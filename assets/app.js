/**
 * GH图床 —— 前端逻辑（纯静态 + mdui）
 *
 * 依赖：
 *   mdui       https://cdn.jsdelivr.net/npm/mdui@2/mdui.esm.js
 *   qrcode     仅在使用二维码时动态加载，不拖慢首屏
 */

import { snackbar, setTheme, getTheme } from 'https://cdn.jsdelivr.net/npm/mdui@2/mdui.esm.js';

// ---------- 配置 ----------
const STORAGE_KEY = 'zychUpImageList';
const MAX_SIZE_MB = 15; // 单文件上限（与服务端 20MB 上限对齐，此处更保守）
const uploadAPI = `${location.origin}/upload`;

let qrcodeLib = null;
const loadQrcode = async () => {
  if (!qrcodeLib) {
    qrcodeLib = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.4/+esm');
  }
  return qrcodeLib;
};

// ---------- 状态 ----------
/** @type {Array<{name:string,link:string,sha:string,status:string,error?:string}>} */
let fileList = [];

// 从 localStorage 恢复历史。
// 只存远端 link，不使用 blob: URL —— 它只在当前页面生命周期内有效，刷新即失效。
try {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  fileList = (Array.isArray(saved) ? saved : []).filter(
    (i) => i && typeof i.link === 'string' && i.link
  );
} catch {
  fileList = [];
}

// ---------- DOM ----------
const $ = (s) => document.querySelector(s);
const dropZone = $('#dropZone');
const fileInput = $('#fileInput');
const toolbar = $('#toolbar');
const resultList = $('#resultList');
const snackbarEl = $('#snackbar');

const notify = (msg) => {
  snackbarEl.textContent = msg;
  snackbarEl.open = true;
};

const persist = () => {
  try {
    // 只保留必要字段（不使用 blob URL，刷新后必然失效）
    const data = fileList
      .filter((i) => i.status === 'success' && i.link)
      .map(({ name, link, sha, status }) => ({ name, link, sha, status }));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* 存储不可用（隐私模式等）则忽略 */
  }
};

// ---------- 文件处理 ----------
// webp 转 png（部分场景下的兼容性处理）
const toPngIfWebp = (file) =>
  new Promise((resolve) => {
    if (!/^image\/webp$/i.test(file.type)) return resolve(file);
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        resolve(
          blob
            ? new File([blob], file.name.replace(/\.webp$/i, '.png'), { type: 'image/png' })
            : file
        );
      }, 'image/png');
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });

const addFiles = async (files) => {
  const list = Array.from(files || []).filter(Boolean);
  if (!list.length) return;

  // 体积过滤
  const valid = [];
  let skipped = 0;
  for (const f of list) {
    if (f.size <= MAX_SIZE_MB * 1024 * 1024) valid.push(f);
    else skipped++;
  }
  if (skipped) notify(`已过滤 ${skipped} 个超过 ${MAX_SIZE_MB}MB 的文件`);

  const converted = await Promise.all(valid.map(toPngIfWebp));

  // 先把全部条目入列并渲染，index 固定下来，再交给队列逐个上传
  batchAborted = '';
  const tasks = [];
  converted.forEach((file) => {
    const index = fileList.length;
    fileList.push({
      name: file.name || `image-${Date.now()}`,
      status: 'uploading',
      link: '',
      sha: ''
    });
    tasks.push(() => upload(file, index));
  });
  render();

  await runQueue(tasks);

  // 本批结束：清空凭证并重置组件，下次批量需重新验证一次
  turnstilePass = '';
  batchAborted = '';
  resetTurnstile();
};

/**
 * 并发受限的任务队列
 *
 * 为什么不能一次性全部发出：多选图片时若同时发起 N 个上传请求，
 * Cloudflare Pages Functions 需要同时做 N 次 base64 编码（CPU 密集），
 * 容易超出免费额度的 CPU / 内存限制而被中断，响应变成错误页（HTML），
 * 前端 res.json() 解析失败，就显示为「网络错误」。
 * 限制并发数可以显著降低单次请求的资源占用。
 * 这里设为 1（完全串行）：一次只传一张，最稳妥，对免费额度最友好。
 */
const CONCURRENCY = 1;

/* ------------------------------------------------------------------
 * 人机验证（Cloudflare Turnstile）
 *
 * token 是一次性的，所以「一批只验证一次」不能靠复用 token 实现。
 * 做法：本批第一张带 token 上传，后端验证通过后签发一个 HMAC 批次凭证，
 * 后续上传带上该凭证即可；凭证有有效期，且获取它必须先通过一次真实验证。
 * ------------------------------------------------------------------ */

let turnstilePass = ''; // 本批次凭证，批结束后清空
let turnstileEnabled = true; // 后端未启用验证时会置为 false

// 验证类错误会让整批后续上传必然失败（token 一次性、已消耗），
// 遇到就中止本批，避免每张都重试一次浪费配额并刷屏报错。
let batchAborted = '';

const turnstileToken = () => {
  try {
    return window.turnstile?.getResponse?.() || '';
  } catch {
    return '';
  }
};

const resetTurnstile = () => {
  try {
    window.turnstile?.reset?.();
  } catch {
    /* 脚本未加载则忽略 */
  }
};

const runQueue = async (tasks) => {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      try {
        await task();
      } catch {
        /* 单个任务内部已处理错误，不中断队列 */
      }
    }
  });
  await Promise.all(workers);
};

const upload = async (file, index) => {
  const item = fileList[index];

  // 本批已因验证失败中止，剩余任务直接标记失败，不再发请求
  if (batchAborted) {
    item.status = 'error';
    item.error = batchAborted;
    render();
    return;
  }

  // 单次上传最多尝试 2 次（仅对网络层失败重试）
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // 每次重试都重建 FormData，避免复用已消费的请求体
      const fd = new FormData();
      fd.append('file', file);

      // 人机验证：优先用批次凭证，没有则带上 widget 的 token。
      // 注意：即使 Turnstile 脚本未加载也要走这里 —— 拿不到 token 就明确报错，
      // 而不是「不带字段直接发请求」，否则只会在服务端得到一个含义不明的失败。
      if (turnstileEnabled) {
        if (turnstilePass) {
          fd.append('turnstile_pass', turnstilePass);
        } else {
          const t = turnstileToken();
          if (!t) {
            item.status = 'error';
            item.error = window.turnstile
              ? '请先完成上方的人机验证'
              : '验证组件未加载，请刷新页面重试';
            batchAborted = item.error;
            render();
            return;
          }
          fd.append('cf-turnstile-response', t);
        }
      }

      const res = await fetch(uploadAPI, { method: 'POST', body: fd });
      // 先取文本再解析：Cloudflare 出错时返回的是 HTML 错误页，
      // 直接 res.json() 会抛异常，导致把 HTTP 错误误报成「网络错误」
      const text = await res.text();
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }

      if (data?.success && data?.data?.link) {
        item.link = data.data.link;
        item.sha = data.data.sha || '';
        item.status = 'success';
        // 后端签发批次凭证后，本批后续上传凭它免验证
        if (data.data.turnstile_pass) turnstilePass = data.data.turnstile_pass;
        render();
        persist();
        return;
      }

      // 服务端有明确错误信息就展示它，否则带上状态码
      item.status = 'error';
      item.error = data?.error || `服务端返回 HTTP ${res.status}`;
      // 验证类失败（403）会让整批必然失败，中止后续请求
      if (res.status === 403) batchAborted = item.error;
      render();
      return;
    } catch {
      // 网络层失败：短暂等待后重试一次
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 800));
        continue;
      }
      item.status = 'error';
      item.error = '网络错误：请求被中断，请重试';
    }
  }
  render();
  persist();
};

// ---------- 渲染 ----------
const iconBtn = (icon, act, label) =>
  `<mdui-button-icon icon="${icon}" title="${label}" data-act="${act}" class="act"></mdui-button-icon>`;

const render = () => {
  toolbar.hidden = fileList.length === 0;

  resultList.innerHTML = fileList
    .map((item, i) => {
      const ok = item.status === 'success';
      const pend = item.status === 'uploading';
      const thumb = ok
        ? `<img src="${escapeHtml(item.link)}" alt="${escapeHtml(item.name)}" loading="lazy" />`
        : pend
          ? `<mdui-circular-progress></mdui-circular-progress>`
          : `<mdui-icon name="broken_image--outlined"></mdui-icon>`;
      return `
      <mdui-card variant="outlined" class="result-item">
        <div class="result-thumb">${thumb}</div>
        <div class="result-main">
          ${ok
            ? `<a class="result-link" title="${escapeHtml(item.name)}" href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.link)}</a>
             <a class="result-md" data-act="md-${i}" title="点击复制 Markdown">${escapeHtml(mdLink(item))}</a>`
            : pend
              ? `<mdui-linear-progress></mdui-linear-progress>`
              : `<span class="result-error">${escapeHtml(item.name)} 上传失败：${escapeHtml(item.error || '')}</span>`}
          ${ok
            ? `<div class="result-actions">
                 ${iconBtn('content_copy--outlined', `copy-${i}`, '复制链接')}
                 ${iconBtn('article--outlined', `md-${i}`, '复制 Markdown')}
                 ${iconBtn('qr_code--outlined', `qr-${i}`, '二维码')}
                 ${iconBtn('open_in_new--outlined', `open-${i}`, '打开原图')}
                 ${iconBtn('delete--outlined', `del-${i}`, '移除')}
               </div>`
            : `<div class="result-actions">${iconBtn('delete--outlined', `del-${i}`, '移除')}</div>`}
        </div>
      </mdui-card>`;
    })
    .join('');
};

// ![文件名](链接)
const mdLink = (item) => `![${item.name || 'image'}](${item.link})`;

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

// ---------- 复制 ----------
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  }
};

// ---------- 二维码 ----------
const showQr = async (text) => {
  try {
    const { toDataURL } = await loadQrcode();
    const url = await toDataURL(text, { width: 480, margin: 1 });
    const el = document.createElement('mdui-dialog');
    el.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;gap:12px;padding:8px">
        <img src="${url}" alt="二维码" style="width:240px;height:240px;border-radius:12px" />
        <mdui-button variant="tonal" data-close>关闭</mdui-button>
      </div>`;
    document.body.appendChild(el);
    el.open = true;
    el.querySelector('[data-close]').addEventListener('click', () => (el.open = false));
    el.addEventListener('close', () => el.remove());
  } catch {
    notify('二维码生成失败');
  }
};

// ---------- 事件 ----------
dropZone.addEventListener('click', () => fileInput.click());

fileInput.addEventListener('change', (e) => {
  addFiles(e.target.files);
  e.target.value = '';
});

['dragenter', 'dragover'].forEach((t) =>
  dropZone.addEventListener(t, (e) => {
    e.preventDefault();
    dropZone.classList.add('is-dragover');
  })
);

['dragleave', 'drop'].forEach((t) =>
  dropZone.addEventListener(t, (e) => {
    e.preventDefault();
    dropZone.classList.remove('is-dragover');
  })
);

dropZone.addEventListener('drop', (e) => addFiles(e.dataTransfer?.files));

// 粘贴上传
document.addEventListener('paste', (e) => {
  const files = e.clipboardData?.files;
  if (files?.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// 结果区按钮（事件委托）
resultList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const [act, idxStr] = String(btn.dataset.act).split('-');
  const i = Number(idxStr);
  const item = fileList[i];
  if (!item) return;

  if (act === 'copy') notify((await copyText(item.link)) ? '复制成功' : '复制失败');
  else if (act === 'md')
    notify((await copyText(mdLink(item))) ? '已复制 Markdown' : '复制失败');
  else if (act === 'qr') showQr(item.link);
  else if (act === 'open') window.open(item.link, '_blank', 'noopener');
  else if (act === 'del') {
    fileList.splice(i, 1);
    render();
    persist();
  }
});

$('#clearBtn').addEventListener('click', () => {
  fileList = [];
  render();
  persist();
});

$('#copyAllBtn').addEventListener('click', async () => {
  const ok = fileList.filter((i) => i.status === 'success');
  if (!ok.length) return notify('暂无可复制的链接');
  const text = ok.map((i) => i.link).join('\n');
  notify((await copyText(text)) ? `已复制 ${ok.length} 条链接` : '复制失败');
});

$('#copyAllMdBtn').addEventListener('click', async () => {
  const ok = fileList.filter((i) => i.status === 'success');
  if (!ok.length) return notify('暂无可复制的链接');
  const text = ok.map(mdLink).join('\n');
  notify((await copyText(text)) ? `已复制 ${ok.length} 条 Markdown` : '复制失败');
});

// 主题切换
$('#themeBtn').addEventListener('click', async () => {
  const cur = await getTheme();
  const next = cur === 'dark' ? 'light' : 'dark';
  setTheme(next);
  $('#themeBtn').setAttribute('icon', next === 'dark' ? 'light_mode--outlined' : 'dark_mode--outlined');
});

render();
