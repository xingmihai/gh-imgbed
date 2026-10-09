/**
 * 图片访问代理 —— /v2/<path>  ->  GitHub Raw（Cloudflare 边缘缓存）
 *
 * 例：/v2/261009-mcm3x.png
 *   -> https://raw.githubusercontent.com/<owner>/<repo>/<branch>/261009-mcm3x.png
 *
 * 说明：
 *   浏览器始终只与本函数（Cloudflare 边缘节点）通信，由函数回源 GitHub。
 *   因此访客所在网络能否直连 raw.githubusercontent.com 并不影响访问。
 *   使用 Cache API 做确定性缓存，不依赖上游响应头是否可缓存。
 *
 * 安全：请求路径会经过严格白名单校验（见 isAllowedPath），
 *   仅允许图片扩展名，禁止路径穿越，避免本函数被当作任意 GitHub 内容的开放代理。
 *
 * 可选：设置环境变量 IMG_CDN=jsdelivr 可改回走 jsDelivr 分发。
 */

// 缓存 1 年（图片内容不可变，路径即版本）
const CACHE_TTL = 31536000;

// 允许的文件扩展名
const ALLOW_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic', 'svg'
]);

// 单段字符集：字母数字、下划线、连字符、点
const SEG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;

/**
 * 路径白名单校验
 * - 段数 1~5（兼容多级目录的历史链接）
 * - 每段仅允许安全字符，且不含 ".."（防路径穿越）
 * - 末段必须带白名单内的图片扩展名
 */
const isAllowedPath = (p) => {
  if (!p || p.length > 200) return false;
  const segs = p.split('/');
  if (segs.length < 1 || segs.length > 5) return false;
  for (const s of segs) {
    if (!s || s === '.' || s === '..' || s.includes('..')) return false;
    if (!SEG_RE.test(s)) return false;
  }
  const ext = (segs[segs.length - 1].split('.').pop() || '').toLowerCase();
  return ALLOW_EXT.has(ext);
};

const originUrl = (env, p) => {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main' } = env || {};
  const base =
    env?.IMG_CDN === 'jsdelivr'
      ? `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`
      : `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}`;
  return `${base}/${p}`;
};

// SVG 同源提供时存在脚本执行风险，限制其能力
const harden = (res, p) => {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}, immutable`);
  out.headers.set('X-Content-Type-Options', 'nosniff');
  if (p.toLowerCase().endsWith('.svg')) {
    out.headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  }
  return out;
};

export async function onRequestGet({ request, params, env }) {
  // 通配路由：params.vkey 是多段数组
  const p = Array.isArray(params.vkey) ? params.vkey.join('/') : params.vkey || '';

  // 白名单校验不通过一律 404，不回源、不缓存
  if (!isAllowedPath(p)) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  const url = new URL(request.url);
  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });

  // 1) 命中边缘缓存直接返回
  const hit = await cache.match(key);
  if (hit) return hit;

  // 2) 回源
  const upstream = await fetch(originUrl(env, p), {
    headers: { 'User-Agent': 'GH-ImgBed' }
  });

  // 3) 只缓存成功响应，404 / 报错不缓存，方便重试
  if (upstream.ok) {
    const res = harden(upstream, p);
    request.ctx?.waitUntil?.(
      cache.put(key, new Response(res.clone().body, {
        status: res.status,
        headers: { ...Object.fromEntries(res.headers), 'Cache-Control': `public, max-age=${CACHE_TTL}` }
      }))
    );
    return res;
  }

  return new Response(upstream.body, { status: upstream.status });
}
