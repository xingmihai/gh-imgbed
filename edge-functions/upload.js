/**
 * 图片上传代理 —— GitHub Contents API（EdgeOne Pages 版）
 *
 * 与 Cloudflare 版（functions/upload.js）逻辑一致，仅做平台适配：
 *   1. 目录改为 edge-functions/ —— EdgeOne 按该目录结构生成函数路由
 *   2. 单文件上限降到 0.9MB —— EdgeOne Edge Functions 请求 body 硬限制 1MB
 *   3. 客户端 IP 不再读 CF-Connecting-IP —— EdgeOne 无此 header
 *
 * 存储：GitHub 仓库（Contents API PUT 写入）
 * 访问：自建 /v2/ 代理，EdgeOne 边缘缓存（见 v2/[[default]].js）
 *
 * 环境变量（EdgeOne Pages 控制台 → 项目设置 → 环境变量，切勿写进代码）：
 *   GITHUB_TOKEN   —— 仅对目标仓库开放的 Contents: Read and write 细粒度令牌
 *   GITHUB_OWNER   —— 仓库所有者用户名
 *   GITHUB_REPO    —— 存图的仓库名
 *   GITHUB_PATH    —— 可选，留空则存仓库根目录（链接更短）
 *   TURNSTILE_SECRET / TURNSTILE_HOSTNAMES —— 可选，启用人机验证后必填后者
 *
 * 分支名固定为 images（IMG_BRANCH_NAME），不接受环境变量覆盖。
 *
 * 注意：1MB 限制只作用于「浏览器 → EdgeOne」的入站请求。
 * 函数出站请求（PUT 到 api.github.com，携带 base64）不受该限制。
 */

// EdgeOne Edge Functions 请求 body 上限 1MB，留出 multipart 与验证字段的开销
const MAX_BYTES = Math.floor(0.9 * 1024 * 1024);

// 批次凭证有效期：一次人机验证后，允许本批后续上传在此时限内免验证
const PASS_TTL_MS = 10 * 60 * 1000;

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

// 客户端 IP：EdgeOne 没有 CF-Connecting-IP，尝试常见转发头。
// siteverify 的 remoteip 是可选参数，取不到留空不影响校验结果。
const clientIp = (request) => {
  const h = request.headers;
  return (
    h.get('EO-Client-IP') ||
    h.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    h.get('X-Real-IP') ||
    ''
  );
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

/* ------------------------------------------------------------------
 * 人机验证（Cloudflare Turnstile）
 *
 * 为什么必须有 secret：token 是浏览器传来的，攻击者可以随手填一个假的。
 * 后端无法自己判断 token 真假，必须拿它去问 Cloudflare；secret 就是
 * 向 Cloudflare 证明「我是这个站点主人」的凭据，因此只能留在服务端。
 *
 * 为什么还要校验 hostname：任何人都能自己建一个 widget（域名填他自己的），
 * 通过挑战后把 token 提交给你的接口 —— Cloudflare 会如实回答 success=true，
 * 因为那确实是真的 token，只是不是为你签发的。所以必须比对 hostname。
 *
 * Turnstile 是纯 HTTP 调用，与部署平台无关，EdgeOne 上可照常使用。
 * ------------------------------------------------------------------ */

const hostnamesOf = (env) =>
  new Set(
    String(env?.TURNSTILE_HOSTNAMES ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean)
      .map((h) => h.split(':')[0]) // 去掉可能的端口
  );

/**
 * 调用官方 siteverify
 *
 * 返回结构化结果，便于区分各种失败原因。
 */
const siteverify = async ({ token, secret, remoteip }) => {
  if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
    return {
      ok: false,
      reason: 'no-token',
      detail: token == null ? '(字段不存在)' : `(长度 ${token.length})`
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  let result;
  let raw = '';
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: remoteip || '' }),
      signal: controller.signal
    });
    raw = await r.text();
    if (!r.ok) {
      return { ok: false, reason: 'http', detail: `${r.status} ${raw.slice(0, 80)}` };
    }
    result = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'network', detail: raw ? `非 JSON 响应：${raw.slice(0, 80)}` : '请求超时或网络异常' };
  } finally {
    clearTimeout(timer);
  }
  return { ok: true, result };
};

// ---- 批次凭证：一次验证通过后签发，本批后续上传凭它免验证 ----
// 用 HMAC 签名代替服务端存储（边缘函数无状态），secret 兼任签名密钥。

const b64url = (buf) => {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const signPass = async (secret, expiry) => {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expiry)));
  return `${expiry}.${b64url(sig)}`;
};

const issuePass = (secret) => signPass(secret, Date.now() + PASS_TTL_MS);

const validPass = async (secret, pass) => {
  if (typeof pass !== 'string' || !pass) return false;
  const [exp, sig] = pass.split('.');
  const expNum = Number(exp);
  if (!exp || !sig || !Number.isFinite(expNum)) return false;
  if (expNum < Date.now()) return false;
  return (await signPass(secret, expNum)) === pass;
};

/**
 * EdgeOne Pages Function Handler。
 * context: { request, params, env, waitUntil }
 * 与 Cloudflare 版签名一致，故主体逻辑无需改动。
 */
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
    GITHUB_PATH = ''
  } = env || {};

  if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
    return json(
      { success: false, error: '服务端未配置 GITHUB_TOKEN / GITHUB_OWNER / GITHUB_REPO' },
      500
    );
  }

  let form;
  try {
    form = await request.formData();
  } catch (_) {
    // EdgeOne 边缘函数基于 V8 + 标准 Web API；若该运行时未实现 formData()，
    // 会走到这里。此时需要把上传迁到 Cloud Functions（见 DEPLOY-EDGEONE.md）。
    return json({ success: false, error: '请求体解析失败（运行时不支持 formData）' }, 400);
  }

  // ---- 人机验证（配置了 TURNSTILE_SECRET 才启用） ----
  const turnstileSecret = env?.TURNSTILE_SECRET;
  let passIssued = '';
  if (turnstileSecret) {
    const allowed = hostnamesOf(env);
    if (allowed.size === 0) {
      return json({ success: false, error: '服务端未配置 TURNSTILE_HOSTNAMES' }, 500);
    }

    const pass = form.get('turnstile_pass');
    if (typeof pass === 'string' && pass) {
      if (!(await validPass(turnstileSecret, pass))) {
        return json({ success: false, error: '凭证无效或已过期，请重新完成验证' }, 403);
      }
    } else {
      const v = await siteverify({
        token: form.get('cf-turnstile-response'),
        secret: turnstileSecret,
        remoteip: clientIp(request)
      });

      const fields = [...form.keys()].join(', ');

      if (v.reason === 'no-token') {
        return json(
          { success: false, error: `未收到验证凭据 ${v.detail}；收到的字段：${fields}` },
          403
        );
      }
      if (v.reason === 'http') {
        return json({ success: false, error: `验证服务返回异常：${v.detail}` }, 502);
      }
      if (v.reason === 'network') {
        return json({ success: false, error: `验证服务请求失败：${v.detail}` }, 502);
      }

      const result = v.result;

      if (!result?.success) {
        const codes = Array.isArray(result?.['error-codes'])
          ? result['error-codes'].join(', ')
          : JSON.stringify(result).slice(0, 120);
        return json({ success: false, error: `人机验证未通过：${codes}` }, 403);
      }

      const hostname = String(result.hostname || '').toLowerCase();
      if (!allowed.has(hostname)) {
        return json(
          {
            success: false,
            error: `主机名不匹配：本站接受 ${[...allowed].join(', ')}，实际为 ${hostname || '(空)'}`
          },
          403
        );
      }
      passIssued = await issuePass(turnstileSecret);
    }
  }

  // 取文件
  const file = form.get('file');
  if (!file || typeof file === 'string') {
    return json({ success: false, error: '缺少 file 字段' }, 400);
  }
  if (file.size > MAX_BYTES) {
    return json(
      { success: false, error: `文件超过 0.9MB 上限（EdgeOne 请求体硬限制 1MB）` },
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

  // 基于请求域名拼接，预览域名与自定义域名自动适配
  const selfOrigin = new URL(request.url).origin;
  const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${IMG_BRANCH_NAME}/${path}`;

  return json({
    success: true,
    status: 200,
    data: {
      id: name,
      link: `${selfOrigin}/v2/${path}`,
      raw: rawUrl,
      path,
      sha: data.content.sha,
      ...(passIssued ? { turnstile_pass: passIssued } : {}),
      _vh_filename: file.name
    }
  });
}
