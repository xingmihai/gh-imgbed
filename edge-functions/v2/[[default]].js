/**
 * 图片访问代理 —— /v2/<path>  ->  GitHub Raw（EdgeOne 边缘缓存）
 *
 * 例：/v2/261010-k7f2m.png
 *   -> https://raw.githubusercontent.com/<owner>/<repo>/images/261010-k7f2m.png
 *
 * 与 Cloudflare 版（functions/v2/[[vkey]].js）的三处平台差异：
 *   1. 文件名 [[default]].js —— EdgeOne 的多级动态路由叫这个
 *   2. waitUntil 在 context 顶层，不是 request.ctx 下
 *   3. cache.match 缓存过期时会抛 504（EdgeOne 特有行为），必须 try/catch
 *      并删除该缓存键，否则该图片永久无法回源
 *
 * 说明：
 *   浏览器始终只与 EdgeOne 边缘节点通信，由函数回源 GitHub。
 *   因此访客所在网络能否直连 raw.githubusercontent.com 并不影响访问。
 *   缓存内容仅在当前数据节点有效，不会自动复制到其他节点。
 *
 * 私有仓库支持：若配置了 GITHUB_TOKEN，回源时会携带认证头。
 * 可选：设置环境变量 IMG_CDN=jsdelivr 可改走 jsDelivr 分发。
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
  // EdgeOne 的 cache.put 依据 s-maxage / max-age 决定缓存时长；
  // 不用 immutable（不在其识别列表内），避免被判为不可缓存
  out.headers.set('Cache-Control', `public, max-age=${CACHE_TTL}, s-maxage=${CACHE_TTL}`);
  out.headers.set('Timing-Allow-Origin', '*');
  return out;
};

/**
 * EdgeOne Pages Function Handler。
 * context: { request, params, env, waitUntil }
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // 不依赖 params 的键名（EdgeOne 的 [[default]] 与 Cloudflare 的 [[vkey]]
  // 注入格式可能不同），直接从路径剥离 /v2/ 前缀更稳
  let p = '';
  try {
    p = decodeURIComponent(url.pathname.replace(/^\/v2\//, ''));
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  if (!p || p === url.pathname) return new Response('Not Found', { status: 404 });

  const cache = caches.default;
  const key = new Request(url.toString(), { method: 'GET' });

  // 1) 命中边缘缓存直接返回
  //    EdgeOne 在缓存过期时会抛 504，需删掉该键后回源重建
  let hit;
  try {
    hit = await cache.match(key);
  } catch {
    try {
      await cache.delete(key);
    } catch {
      /* 删除失败也继续回源 */
    }
    hit = undefined;
  }
  if (hit) return hit;

  // 2) 回源（配置了 token 时携带认证，用于读取私有仓库）
  const headers = { 'User-Agent': 'GH-ImgBed' };
  if (env?.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;

  const upstream = await fetch(originUrl(env, p), { headers });

  // 3) 只缓存成功响应，404 / 报错不缓存，方便重试
  if (upstream.ok) {
    const res = withCacheHeaders(upstream);
    const copy = res.clone();
    const cached = new Response(copy.body, {
      status: copy.status,
      headers: Object.fromEntries(copy.headers)
    });
    const put = cache.put(key, cached);
    // waitUntil 在 context 顶层（Cloudflare 版用的是 request.ctx.waitUntil）
    if (typeof context.waitUntil === 'function') {
      context.waitUntil(put);
    } else {
      await put; // 兜底：没有 waitUntil 就同步等，避免缓存静默丢失
    }
    return res;
  }

  return new Response(upstream.body, { status: upstream.status });
}
