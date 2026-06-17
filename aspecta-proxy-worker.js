/**
 * Aspecta 行情 CORS 代理 —— Cloudflare Worker
 * ------------------------------------------------------------
 * 作用：trade.aspecta.ai 不返回 CORS 头，静态网页无法直接请求。
 * 这个 Worker 帮你转发请求并补上 CORS 头，让前端能正常取价。
 *
 * 部署步骤（全程免费，约 2 分钟）：
 *   1. 打开 https://dash.cloudflare.com/ → 左侧 Workers & Pages → Create → Worker
 *   2. 给它起个名字（如 aspecta-proxy）→ Deploy
 *   3. 点 "Edit code"，把本文件全部内容粘贴进去 → Deploy
 *   4. 复制分配给你的地址，形如：
 *        https://aspecta-proxy.你的子域.workers.dev
 *   5. 回到 index.html 的 CONFIG.CORS_PROXIES，把第一行替换/取消注释为：
 *        'https://aspecta-proxy.你的子域.workers.dev/?url='
 *      （注意结尾的 /?url= 不能少）
 *
 * 之后页面就会优先走你自己的代理，稳定且不依赖第三方公共代理。
 */
export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Max-Age': '86400'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const target = new URL(request.url).searchParams.get('url');
    if (!target) {
      return new Response('missing url param', { status: 400, headers: cors });
    }

    // 只允许转发到 aspecta，避免被当成开放代理滥用。
    let host;
    try { host = new URL(target).hostname; } catch { host = ''; }
    if (host !== 'trade.aspecta.ai') {
      return new Response('forbidden host', { status: 403, headers: cors });
    }

    try {
      const upstream = await fetch(target, {
        headers: { accept: 'application/json' },
        cf: { cacheTtl: 15, cacheEverything: true }
      });
      const body = await upstream.text();
      return new Response(body, {
        status: upstream.status,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' }
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e) }), {
        status: 502,
        headers: { ...cors, 'content-type': 'application/json; charset=utf-8' }
      });
    }
  }
};
