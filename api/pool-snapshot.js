/**
 * 全局「最终数据」快照 —— Vercel Serverless Function + Vercel KV
 * ---------------------------------------------------------------
 * 目的：活动结束后，把最后一刻的募集数据（资金池 + 价格 + 时间）持久化到
 * 服务端，让任何设备、任何新访客之后打开都能看到同一份最终数据
 * （localStorage 只能在同一台设备上保留）。
 *
 * 为什么必须在活动结束前抓取：结束后链上会陆续处理退款，目标地址余额会
 * 下降，过后就再也读不到「最终募集额」了。所以要在 [开始, 结束] 窗口内抓。
 *
 * 两种用法（同一个文件，按请求自动区分）：
 *   - 读取：GET /api/pool-snapshot            → 返回已存的快照 JSON
 *   - 抓取：GET /api/pool-snapshot?action=capture
 *       由 Vercel Cron 定时调用（见仓库 vercel.json，21:59 北京时间）。
 *       带防呆：只在活动窗口内、且新值不小于已存值时才写入，所以即便被
 *       重复/延迟调用也不会把好数据覆盖坏。
 *
 * 部署前置（唯一的一次性手动步骤）：
 *   在 Vercel 项目 → Storage → 连接一个 Redis（Redis Cloud 免费档 / Upstash 均可）。
 *   连接后会自动注入 REDIS_URL（或 KV_URL）连接串，本文件直接就能用。
 *   可选：设置 CRON_SECRET，则抓取要求 Bearer 校验，更安全。
 */

import { createClient } from 'redis';

const CONFIG = {
  SYMBOL: 'RE',
  ADDRESS: (process.env.POOL_ADDRESS || '0xc5510b179d80451d3b062732b1768085d9ef8689').toLowerCase(),
  TOKEN_PROJECT_NAME: 'Re', // Aspecta project_address (English name, not contract)
  START_MS: new Date('2026-06-17T20:00:00+08:00').getTime(),
  END_MS: new Date('2026-06-17T22:00:00+08:00').getTime(),
  RPC_NODES: [
    'https://bsc-dataseed.binance.org/',
    'https://bsc-dataseed1.defibit.io/',
    'https://bsc-dataseed4.defibit.io/',
    'https://bsc-dataseed1.ninicoin.io/'
  ],
  PRICE_APIS: [
    'https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT',
    'https://fapi.binance.com/fapi/v1/ticker/price?symbol=BNBUSDT',
    'https://api.coingecko.com/api/v3/simple/price?ids=binancecoin&vs_currencies=usd',
    'https://min-api.cryptocompare.com/data/price?fsym=BNB&tsyms=USD'
  ]
};

const REDIS_URL = process.env.REDIS_URL || process.env.KV_URL || '';
const KV_KEY = `tge:final:${CONFIG.SYMBOL}:${CONFIG.ADDRESS}`;

/* ---------- Redis (TCP) helpers ---------- */
// Reuse the connection across warm invocations; reconnect on cold start.
let _client = null;
async function getClient() {
  if (!REDIS_URL) throw new Error('Redis not configured (missing REDIS_URL / KV_URL)');
  if (_client && _client.isOpen) return _client;
  _client = createClient({
    url: REDIS_URL,
    socket: {
      connectTimeout: 5000,
      // Give up quickly instead of retrying forever inside a serverless call.
      reconnectStrategy: retries => (retries > 2 ? false : 200)
    }
  });
  _client.on('error', e => console.error('redis error:', e?.message));
  await _client.connect();
  return _client;
}

async function kvGet(key) {
  try {
    const c = await getClient();
    const v = await c.get(key);
    if (v == null) return null;
    try { return JSON.parse(v); } catch { return null; }
  } catch (e) {
    console.error('kvGet failed:', e?.message);
    return null;
  }
}

async function kvSet(key, value) {
  const c = await getClient();
  await c.set(key, JSON.stringify(value));
  return true;
}

/* ---------- On-chain pool balance ---------- */
function weiHexToBNB(weiHex) {
  try {
    const wei = BigInt(weiHex);
    const base = 10n ** 18n;
    const frac = (wei % base).toString().padStart(18, '0').slice(0, 6);
    return Number(`${(wei / base).toString()}.${frac}`);
  } catch { return 0; }
}

async function fetchJSON(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(id); }
}

async function fetchPoolBNB() {
  const body = JSON.stringify({ jsonrpc: '2.0', method: 'eth_getBalance', params: [CONFIG.ADDRESS, 'latest'], id: 1 });
  for (const node of CONFIG.RPC_NODES) {
    try {
      const { result } = await fetchJSON(node, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body
      }, 5000);
      const bnb = weiHexToBNB(result);
      if (bnb > 0) return bnb;
    } catch (e) { /* try next node */ }
  }
  return 0;
}

async function fetchBNBPrice() {
  for (const url of CONFIG.PRICE_APIS) {
    try {
      const d = await fetchJSON(url, {}, 5000);
      const v = Number(d?.price ?? d?.binancecoin?.usd ?? d?.USD ?? 0);
      if (v > 0) return v;
    } catch (e) { /* try next */ }
  }
  return 0;
}

/* ---------- RE token price (Aspecta k-line) ---------- */
// Aspecta returns prices as 18-decimal fixed-point integer strings.
function toPrice(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (/^-?\d+$/.test(s)) {
    const neg = s.startsWith('-');
    const digits = (neg ? s.slice(1) : s).padStart(19, '0');
    const intPart = digits.slice(0, -18) || '0';
    const fracPart = digits.slice(-18);
    return (neg ? -1 : 1) * Number(`${intPart}.${fracPart}`);
  }
  const n = Number(s);
  return Number.isFinite(n) ? n / 1e18 : null;
}

// Latest candle's close_price for the requested project (matched by
// project_address; falls back to the first item with candles).
function extractTokenPrice(raw, projectName) {
  const list = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.data) ? raw.data : []);
  if (!list.length) return 0;
  const want = (projectName || '').toLowerCase();
  let item = want ? list.find(x => String(x?.project_address ?? '').toLowerCase() === want) : null;
  if (!item) item = list.find(x => Array.isArray(x?.k_line) && x.k_line.length) || list[0];
  const kline = Array.isArray(item?.k_line) ? item.k_line.slice() : [];
  if (!kline.length) return 0;
  kline.sort((a, b) => (a.ended_at - b.ended_at));
  const price = toPrice(kline[kline.length - 1]?.close_price);
  return Number.isFinite(price) && price > 0 ? price : 0;
}

async function fetchTokenPrice() {
  try {
    const url = new URL('https://trade.aspecta.ai/api/hermes/trading/k-line');
    url.searchParams.set('project_address', CONFIG.TOKEN_PROJECT_NAME);
    url.searchParams.set('offset', '24');
    url.searchParams.set('window_type', '1h');
    const d = await fetchJSON(url.toString(), {
      headers: {
        accept: 'application/json',
        'user-agent': 'Mozilla/5.0',
        ...(process.env.ASPECTA_COOKIE ? { cookie: process.env.ASPECTA_COOKIE } : {})
      }
    }, 6000);
    return extractTokenPrice(d, CONFIG.TOKEN_PROJECT_NAME) || 0;
  } catch (e) {
    console.error('fetchTokenPrice failed:', e?.message);
    return 0;
  }
}

/* ---------- Capture (guarded) ---------- */
async function capture() {
  const now = Date.now();
  // Only ever write inside the activity window; refunds after END would corrupt it.
  if (now < CONFIG.START_MS || now > CONFIG.END_MS) return { skipped: 'out_of_window' };

  const dep = await fetchPoolBNB();
  if (!(dep > 0)) return { skipped: 'no_balance' };

  const existing = await kvGet(KV_KEY);
  // The pool only grows during the sale — never overwrite with a smaller value.
  if (existing && Number(existing.dep) > dep) return { skipped: 'not_greater', existing };

  // Prices are best-effort; if a fetch fails, keep the last good value.
  const [bnbFetched, tokFetched] = await Promise.all([fetchBNBPrice(), fetchTokenPrice()]);
  const bnbUSDT = bnbFetched > 0 ? bnbFetched : Number(existing?.bnbUSDT) || 0;
  const tokenUSDT = tokFetched > 0 ? tokFetched : Number(existing?.tokenUSDT) || 0;

  const snap = { dep, bnbUSDT, tokenUSDT, t: now, updatedAt: new Date(now).toISOString() };
  await kvSet(KV_KEY, snap);
  return { captured: snap };
}

/* ---------- Auth (optional) ---------- */
function captureAllowed(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true; // no secret configured → rely on window + monotonic guards
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${secret}`;
}

/* ---------- Handler ---------- */
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const isCapture = (req.query?.action || '') === 'capture';

  if (isCapture) {
    if (!captureAllowed(req)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    try {
      const result = await capture();
      return res.status(200).json({ ok: true, ...result });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // Read path. Also self-heals: if a visitor opens the page during the live
  // window, opportunistically refresh the snapshot so the last visitor before
  // 22:00 captures the near-final value even if the cron is delayed.
  try {
    const now = Date.now();
    if (now >= CONFIG.START_MS && now <= CONFIG.END_MS) {
      try { await capture(); } catch (e) { /* non-fatal */ }
    }
    const snap = (await kvGet(KV_KEY)) || {};
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(200).json(snap);
  } catch (e) {
    return res.status(200).json({});
  }
}
