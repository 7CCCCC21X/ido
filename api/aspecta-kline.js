/**
 * Aspecta K 线行情 —— 同源后端代理（Vercel Serverless Function）
 * ------------------------------------------------------------
 * 为什么需要它：CORS 是「目标服务器」返回给浏览器的响应头，前端无法自己加。
 * trade.aspecta.ai 不返回 CORS 头，所以浏览器直接请求会被拦截。
 * 解决方式：把请求放到后端执行 —— 前端请求本仓库的 /api/aspecta-kline，
 * 由这里去请求 Aspecta，再带上 CORS 头返回给前端。
 *
 * 部署：把本仓库部署到 Vercel（或任何支持 /api serverless 的平台）即可，
 * 文件路径 /api/aspecta-kline.js 会自动成为 /api/aspecta-kline 接口。
 *
 * 前端调用：GET /api/aspecta-kline?project=Re
 */
export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    const project = (req.query.project || "Re").toString();
    const offset = (req.query.offset || "24").toString();
    const windowType = (req.query.window_type || "1h").toString();

    // 真实 Aspecta K 线接口（参考 aps 仓库）。
    const aspectaUrl = new URL("https://trade.aspecta.ai/api/hermes/trading/k-line");
    aspectaUrl.searchParams.set("project_address", project);
    aspectaUrl.searchParams.set("offset", offset);
    aspectaUrl.searchParams.set("window_type", windowType);

    const response = await fetch(aspectaUrl.toString(), {
      method: "GET",
      headers: {
        accept: "application/json",
        "user-agent": "Mozilla/5.0",
        // 若接口返回 401/403，可在 Vercel 环境变量里配 ASPECTA_COOKIE。
        ...(process.env.ASPECTA_COOKIE ? { cookie: process.env.ASPECTA_COOKIE } : {}),
      },
    });

    const text = await response.text();
    res.status(response.status);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // 边缘缓存 15s，减轻对上游的压力。
    res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
    return res.send(text);
  } catch (error) {
    return res.status(500).json({ error: "proxy_failed", message: error.message });
  }
}
