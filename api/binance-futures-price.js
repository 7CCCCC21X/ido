/**
 * 币安合约（U 本位 / 盘前永续）最新价 —— 同源后端代理（Vercel Serverless Function）
 * --------------------------------------------------------------------------
 * 前端默认直接请求 https://fapi.binance.com/fapi/v1/ticker/price?symbol=PREDICTUSDT
 * （币安公开行情接口自带 CORS 头）。本文件只是兜底：当浏览器直连被网络环境拦截
 * 或限流时，前端会改走 /api/binance-futures-price?symbol=PREDICTUSDT，由这里
 * 代为请求并带上 CORS 头返回，响应格式与币安原接口一致：{ symbol, price, time }。
 *
 * 部署：把本仓库部署到 Vercel（或任何支持 /api serverless 的平台）即可，
 * 文件路径 /api/binance-futures-price.js 会自动成为 /api/binance-futures-price 接口。
 */
const UPSTREAMS = [
  'https://fapi.binance.com/fapi/v1/ticker/price',
  'https://fapi1.binance.com/fapi/v1/ticker/price',
  'https://fapi2.binance.com/fapi/v1/ticker/price'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // 只接受合法的合约交易对符号（如 PREDICTUSDT），防止被当成通用代理。
  const symbol = String(req.query?.symbol || 'PREDICTUSDT').toUpperCase();
  if (!/^[A-Z0-9]{2,24}$/.test(symbol)) {
    return res.status(400).json({ error: 'bad_symbol' });
  }

  let lastError = 'upstream_failed';
  for (const base of UPSTREAMS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const r = await fetch(`${base}?symbol=${encodeURIComponent(symbol)}`, {
        headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
        signal: controller.signal
      });
      const text = await r.text();
      if (!r.ok) { lastError = `HTTP ${r.status}`; continue; }
      res.status(200);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // 边缘缓存 10s，减轻对上游的压力。
      res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
      return res.send(text);
    } catch (e) {
      lastError = e.message;
    } finally {
      clearTimeout(timer);
    }
  }
  return res.status(502).json({ error: 'proxy_failed', message: lastError });
}
