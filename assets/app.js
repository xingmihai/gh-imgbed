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
/** @type {Array<{name:string,link:string,sha:string,status:string,localUrl:string}>} */
let fileList = [];

try {
  fileList = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
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
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(fileList.filter((i) => i.status === 'success'))
    );
  } catch {
    /* 存储不可用则忽略 */
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
  converted.forEach((file, idx) => {
    const name = file.name || `image-${Date.now()}`;
    fileList.push({
      name,
      localUrl: URL.createObjectURL(file),
      status: 'uploading',
      link: '',
      sha: ''
    });
    upload(file, fileList.length - 1);
  });
  render();
};

const upload = async (file, index) => {
  const item = fileList[index];
  const fd = new FormData();
  fd.append('file', file);
  try {
    const res = await fetch(uploadAPI, { method: 'POST', body: fd });
    const data = await res.json();
    if (data?.success && data?.data?.link) {
      item.link = data.data.link;
      item.sha = data.data.sha || '';
      item.status = 'success';
    } else {
      item.status = 'error';
      item.error = data?.error || `HTTP ${res.status}`;
    }
  } catch (e) {
    item.status = 'error';
    item.error = '网络错误';
  }
  render();
  persist();
};

// ---------- 渲染 ----------
const iconBtn = (icon, title) =>
  `<mdui-button-icon icon="${icon}" title="${title}" data-act="${title}" class="act"></mdui-button-icon>`;

const render = () => {
  toolbar.hidden = fileList.length === 0;

  resultList.innerHTML = fileList
    .map((item, i) => {
      const ok = item.status === 'success';
      const pend = item.status === 'uploading';
      return `
      <mdui-card variant="outlined" class="result-item">
        <div class="result-thumb">
          ${ok || pend
            ? `<img src="${item.localUrl}" alt="${escapeHtml(item.name)}" loading="lazy" />`
            : `<mdui-icon name="broken_image--outlined"></mdui-icon>`}
        </div>
        <div class="result-main">
          <p class="result-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
          ${ok
            ? `<a class="result-link" href="${item.link}" target="_blank" rel="noopener">${item.link}</a>`
            : pend
              ? `<mdui-linear-progress></mdui-linear-progress>`
              : `<span class="result-error">上传失败：${escapeHtml(item.error || '')}</span>`}
          ${ok
            ? `<div class="result-actions">
                 ${iconBtn('content_copy--outlined', `copy-${i}`)}
                 ${iconBtn('qr_code--outlined', `qr-${i}`)}
                 ${iconBtn('open_in_new--outlined', `open-${i}`)}
                 ${iconBtn('delete--outlined', `del-${i}`)}
               </div>`
            : `<div class="result-actions">${iconBtn('delete--outlined', `del-${i}`)}</div>`}
        </div>
      </mdui-card>`;
    })
    .join('');
};

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
  const links = fileList.filter((i) => i.status === 'success').map((i) => i.link);
  if (!links.length) return notify('暂无可复制的链接');
  notify((await copyText(links.join('\n'))) ? `已复制 ${links.length} 条链接` : '复制失败');
});

// 主题切换
$('#themeBtn').addEventListener('click', async () => {
  const cur = await getTheme();
  const next = cur === 'dark' ? 'light' : 'dark';
  setTheme(next);
  $('#themeBtn').setAttribute('icon', next === 'dark' ? 'light_mode--outlined' : 'dark_mode--outlined');
});

render();
