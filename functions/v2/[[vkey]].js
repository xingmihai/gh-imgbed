/**
 * 图片访问代理 —— /v2/<path>  ->  jsDelivr CDN
 *
 * 例：/v2/images/2026/10/09/abc123.png
 *   -> https://cdn.jsdelivr.net/gh/<owner>/<repo>@<branch>/images/2026/10/09/abc123.png
 *
 * jsDelivr 首次缓存需要几分钟；在此期间 404 会回源 GitHub Raw，
 * 保证刚上传的图立刻可访问。
 */

const buildUrls = (env, p) => {
  const { GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH = 'main' } = env || {};
  return [
    `https://cdn.jsdelivr.net/gh/${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}/${p}`,
    `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/${p}`
  ];
};

export async function onRequestGet({ request, params, env }) {
  // 通配路由：params.vkey 是多段数组
  const p = Array.isArray(params.vkey) ? params.vkey.join('/') : params.vkey || '';
  if (!p) return new Response('Not Found', { status: 404 });

  const ua = request.headers.get('User-Agent') || 'ZYCS-IMG';
  const [cdnUrl, rawUrl] = buildUrls(env, p);

  // 1) 优先走 CDN
  let res = await fetch(cdnUrl, { headers: { 'User-Agent': ua } });

  // 2) CDN 还没缓存到 -> 回源 GitHub Raw
  if (res.status === 404) {
    res = await fetch(rawUrl, { headers: { 'User-Agent': ua } });
  }

  // 3) 加一层边缘缓存，减轻 GitHub 压力
  const out = new Response(res.body, res);
  out.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  return out;
}
