/**
 * 图片上传代理 —— GitHub Contents API
 *
 * 存储：GitHub 仓库（Contents API PUT 写入）
 * 访问：自建 /v2/ 代理，Cloudflare 边缘缓存（见 v2/[[vkey]].js）
 *
 * 需要的环境变量（在 Cloudflare Pages 后台配置，切勿写进代码）：
 *   GITHUB_TOKEN   —— 仅对目标仓库开放的 Contents: Read and write 细粒度令牌
 *   GITHUB_OWNER   —— 仓库所有者用户名
 *   GITHUB_REPO    —— 存图的仓库名（建议单独建一个仓库，不要和代码混用）
 *   GITHUB_PATH    —— 可选，留空则存仓库根目录
 *
 * 分支名固定为 images（IMG_BRANCH_NAME），不接受环境变量覆盖。
 */

// 单文件上限 20MB
const MAX_BYTES = 20 * 1024 * 1024;

// 图片存放分支：固定值，不允许通过环境变量自定义。
// 固定分支可避免误配导致图片与代码混入同一分支（会带来代码被读取的风险）。
const IMG_BRANCH_NAME = 'images';

// File -> base64
const toBase64 = async (file) => {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let out = '';
  const CHUNK = 0x8000; // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
};

// 取扩展名，兜底 png
const extOf = (name = '') => {
  const m = /\.([a-zA-Z0-9]+)$/.exec(name);
  return (m ? m[1] : 'png').toLowerCase();
};

// 跨域头：博客与图床不同子域时，浏览器需要它才允许页面 JS 读取上传响应
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
  });

export async function onRequest({ request, env }) {
  // 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== 'POST') {
    return json({ success: false, error: 'Method Not Allowed' }, 405);
  }

  const {
    GITHUB_TOKEN,
    GITHUB_OWNER,
    GITHUB_REPO,
    GITHUB_PATH = '' // 留空则直接存仓库根目录；想归到一个目录下就填目录名（不要带斜杠）
  } = env || {};

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return json(
      { success: false, error: '服务端未配置 GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO' },
      500
    );
  }

  // 取文件
  let file;
  try {
    file = (await request.formData()).get('file');
  } catch (_) {}
  if (!file || typeof file === 'string') {
    return json({ success: false, error: '缺少 file 字段' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json(
      { success: false, error: `文件超过 ${MAX_BYTES / 1024 / 1024}MB 上限` },
      413
    );
  }

  // 扁平文件名：日期前缀（yymmdd）+ 5 位随机，例：261009-mcm3x.png
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const yymmdd = `${String(d.getUTCFullYear()).slice(2)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
  const ext = extOf(file.name);
  const randN = () => Math.random().toString(36).slice(2, 7).padEnd(5, '0');
  const toPath = (n) => (GITHUB_PATH ? `${GITHUB_PATH}/${n}` : n);

  const content = await toBase64(file);
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'GH-ImgBed-Uploader'
  };

  // 5 位随机的空间约 6000 万，撞名概率极低；
  // 仍保留重试：撞名（GitHub 返回 422）时换一个名字重来，最多 6 次。
  let res;
  let text = '';
  let name = '';
  let path = '';
  for (let i = 0; i < 6; i++) {
    name = `${yymmdd}-${randN()}.${ext}`;
    path = toPath(name);
    const api = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${path}`;
    const payload = JSON.stringify({ message: `upload: ${name}`, content, branch: IMG_BRANCH_NAME });

    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(api, { method: 'PUT', headers, body: payload });
      text = await res.text();
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 500 * Math.pow(2, attempt)));
    }

    let probe;
    try {
      probe = JSON.parse(text);
    } catch (_) {
      probe = {};
    }
    // 撞名：GitHub 会要求提供 sha，此时换名字重试
    if (res.status === 422 && /sha/i.test(probe.message || '')) continue;
    break;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = {};
  }

  if (!res.ok || !data.content) {
    return json(
      { success: false, status: res.status, error: data.message || 'GitHub 写入失败' },
      502
    );
  }

  // 基于请求域名拼接，pages.dev 与自定义域名自动适配
  const selfOrigin = new URL(request.url).origin;
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${IMG_BRANCH_NAME}/${path}`;

  // 返回结构对齐前端（见 src/utils/index.ts）
  return json({
    success: true,
    status: 200,
    data: {
      id: name,
      // 走自建代理：链接与后端解耦，换存储不用改老链接
      link: `${selfOrigin}/v2/${path}`,
      raw: rawUrl,
      path,
      sha: data.content.sha, // 删除 / 更新文件时要用，务必留存
      _vh_filename: file.name
    }
  });
}
