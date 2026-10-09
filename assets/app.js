/**
 * GH图床 —— 前端逻辑（纯静态，零组件库依赖）
 *
 * 依赖：
 *   assets/app.css   自建样式与主题
 *   assets/icons.svg 图标 sprite（本地）
 *   assets/qrcode.js 二维码库（本地，按需动态加载）
 */

// ---------- 配置 ----------
const STORAGE_KEY = 'zychUpImageList';
const THEME_KEY = 'ghTheme';
const MAX_SIZE_MB = 15;
const uploadAPI = `${location.origin}/upload`;

let qrcodeLib = null;
const loadQrcode = async () => {
  if (!qrcodeLib) qrcodeLib = await import('./qrcode.js');
  return qrcodeLib;
};

// ---------- 图标 sprite ----------
const loadSprite = async () => {
  try {
    const res = await fetch('./icons.svg');
    document.getElementById('iconSprite').innerHTML = await res.text();
  } catch {
    /* 失败时图标留空，不影响其余功能 */
  }
};

// ---------- Snackbar ----------
const snackbarEl = document.getElementById('snackbar');
let snackTimer = null;
const notify = (msg) => {
  snackbarEl.textContent = msg;
  snackbarEl.classList.add('is-open');
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => snackbarEl.classList.remove('is-open'), 2600);
};

// ---------- 主题 ----------
const themeBtn = document.getElementById('themeBtn');
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const currentTheme = () =>
  document.documentElement.getAttribute('data-theme') || (systemDark() ? 'dark' : 'light');

const applyTheme = (t) => {
  document.documentElement.setAttribute('data-theme', t);
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch { }
  themeBtn.innerHTML =
    t === 'dark'
      ? '<svg class="icon" aria-hidden="true"><use href="#i-light_mode" /></svg>'
      : '<svg class="icon" aria-hidden="true"><use href="#i-dark_mode" /></svg>';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#1d1b20' : '#f7f2fa');
};

themeBtn.addEventListener('click', () => {
  applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
});

// 跟随系统（仅当用户未手动选择时）
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  let saved = null;
  try {
    saved = localStorage.getItem(THEME_KEY);
  } catch { }
  if (!saved) applyTheme(systemDark() ? 'dark' : 'light');
});

// ---------- 状态 ----------
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

const persist = () => {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(fileList.filter((i) => i.status === 'success'))
    );
  } catch { }
};

// ---------- 文件处理 ----------
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

  const valid = [];
  let skipped = 0;
  for (const f of list) {
    if (f.size <= MAX_SIZE_MB * 1024 * 1024) valid.push(f);
    else skipped++;
  }
  if (skipped) notify(`已过滤 ${skipped} 个超过 ${MAX_SIZE_MB}MB 的文件`);

  const converted = await Promise.all(valid.map(toPngIfWebp));
  converted.forEach((file) => {
    fileList.push({
      name: file.name || `image-${Date.now()}`,
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
  } catch {
    item.status = 'error';
    item.error = '网络错误';
  }
  render();
  persist();
};

// ---------- 渲染 ----------
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );

const iconBtn = (icon, act, label) =>
  `<button type="button" class="act-btn" title="${label}" aria-label="${label}" data-act="${act}">` +
  `<svg class="icon" aria-hidden="true"><use href="#i-${icon}" /></svg></button>`;

const render = () => {
  toolbar.hidden = fileList.length === 0;

  resultList.innerHTML = fileList
    .map((item, i) => {
      const ok = item.status === 'success';
      const pend = item.status === 'uploading';
      return `
      <section class="card card--outlined result-item">
        <div class="result-thumb">
          ${ok || pend
            ? `<img src="${item.localUrl}" alt="${escapeHtml(item.name)}" loading="lazy" />`
            : `<svg class="icon" style="font-size:32px;color:var(--c-outline)" aria-hidden="true"><use href="#i-broken_image" /></svg>`}
        </div>
        <div class="result-main">
          <p class="result-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
          ${ok
            ? `<a class="result-link" href="${item.link}" target="_blank" rel="noopener">${escapeHtml(item.link)}</a>`
            : pend
              ? `<div class="progress"></div>`
              : `<span class="result-error">上传失败：${escapeHtml(item.error || '')}</span>`}
          <div class="result-actions">
            ${ok ? iconBtn('content_copy', `copy-${i}`, '复制链接') : ''}
            ${ok ? iconBtn('qr_code', `qr-${i}`, '二维码') : ''}
            ${ok ? iconBtn('open_in_new', `open-${i}`, '打开原图') : ''}
            ${iconBtn('delete', `del-${i}`, '移除')}
          </div>
        </div>
      </section>`;
    })
    .join('');
};

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

// ---------- 二维码弹窗 ----------
const showQr = async (text) => {
  try {
    const { toDataURL } = await loadQrcode();
    const url = await toDataURL(text, { width: 480, margin: 1 });

    const mask = document.createElement('div');
    mask.className = 'dialog-mask';
    mask.innerHTML = `
      <div class="dialog">
        <div style="display:flex;flex-direction:column;align-items:center;gap:16px">
          <img src="${url}" alt="二维码" style="width:240px;height:240px;border-radius:12px" />
          <button type="button" class="btn btn--outlined" data-close>关闭</button>
        </div>
      </div>`;
    document.body.appendChild(mask);
    requestAnimationFrame(() => mask.classList.add('is-open'));

    const close = () => {
      mask.classList.remove('is-open');
      setTimeout(() => mask.remove(), 220);
    };
    mask.querySelector('[data-close]').addEventListener('click', close);
    mask.addEventListener('click', (e) => {
      if (e.target === mask) close();
    });
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

document.addEventListener('paste', (e) => {
  const files = e.clipboardData?.files;
  if (files?.length) {
    e.preventDefault();
    addFiles(files);
  }
});

resultList.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const [act, idxStr] = String(btn.dataset.act).split('-');
  const item = fileList[Number(idxStr)];
  if (!item) return;

  if (act === 'copy') notify((await copyText(item.link)) ? '复制成功' : '复制失败');
  else if (act === 'qr') showQr(item.link);
  else if (act === 'open') window.open(item.link, '_blank', 'noopener');
  else if (act === 'del') {
    fileList.splice(Number(idxStr), 1);
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

// ---------- 启动 ----------
applyTheme(currentTheme());
loadSprite().then(render);
