/**
 * 图片访问代理 —— /v2/<path>  ->  GitHub Raw（Cloudflare 边缘缓存）
 *
 * 例：/v2/261010-k7f2m.png
 *   -> https://raw.githubusercontent.com/<owner>/<repo>/images/261010-k7f2m.png
 *
 * 说明：
 *   浏览器始终只与本函数（Cloudflare 边缘节点）通信，由函数回源 GitHub。
 *   因此访客所在网络能否直连 raw.githubusercontent.com 并不影响访问。
 *   使用 Cache API 做确定性缓存，不依赖上游响应头是否可缓存。
 *
 * 私有仓库支持：若配置了 GITHUB_TOKEN，回源时会携带认证头，
 *   这样即使存图仓库是 private 也能读取（配合缓存，实际回源次数很少）。
 *
 * 可选：设置环境变量 IMG_CDN=jsdelivr 可改回走 jsDelivr 分发。
 */

// 缓存 1 年（图片内容不可变，路径即版本）
const CACHE_TTL = 31536000;

// 图片分支：必须与上传函数一致，固定值，不接受环境变量覆盖
const IMG_BRANCH_NAME = 'images';

const originUrl = (env, p) => {
  const { GITHUB_OWNER, GITHUB_REPO } = env || {};
  const base =
    env?.IMG_CDN === 'jsdelivr'
      ? `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${IMG_BRANCH_NAME}`
      : `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${IMG_BRANCH_NAME}`;
  return `${base}/${p}`;
};

const withCacheHeaders = (res) => {
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}, immutable`);
  out.headers.set('Timing-Allow-Origin', '*');
  return out;
};

export async function onRequestGet({ request, params, env }) {
  // 通配路由：params.vkey 是多段数组
  const p = Array.isArray(params.vkey) ? params.vkey.join('/') : params.vkey || '';
  if (!p) return new Response('Not Found', { status: 404 });

  const url = new URL(request.url);
  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });

  // 1) 命中边缘缓存直接返回
  const hit = await cache.match(key);
  if (hit) return hit;

  // 2) 回源（配置了 token 时携带认证，用于读取私有仓库）
  const headers = { 'User-Agent': 'GH-ImgBed' };
  if (env?.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const upstream = await fetch(originUrl(env, p), { headers });

  // 3) 只缓存成功响应，404 / 报错不缓存，方便重试
  if (upstream.ok) {
    const res = withCacheHeaders(upstream);
    // 异步写缓存，不阻塞本次响应
    const copy = res.clone();
    const cc = { headers: { 'Cache-Control': `public, max-age=${CACHE_TTL}` } };
    request.ctx?.waitUntil?.(cache.put(key, new Response(copy.body, {
      status: copy.status,
      headers: { ...Object.fromEntries(copy.headers), ...cc.headers }
    })));
    return res;
  }

  return new Response(upstream.body, { status: upstream.status });
}
