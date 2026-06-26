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
 *       由 Vercel Cron 定时调用（见仓库 vercel.json，19:59 北京时间）。
 *       带防呆：只在活动窗口内、且新值不小于已存值时才写入，所以即便被
 *       重复/延迟调用也不会把好数据覆盖坏。
 *
 * 部署前置（唯一的一次性手动步骤）：
 *   在 Vercel 项目 → Storage → 连接一个 KV（Upstash）。连接后会自动注入
 *   KV_REST_API_URL / KV_REST_API_TOKEN 环境变量，本文件直接就能用。
 *   可选：设置 CRON_SECRET，则抓取要求 Bearer 校验，更安全。
 */

const CONFIG = {
  SYMBOL: 'RE',
  ADDRESS: (process.env.POOL_ADDRESS || '0xc5510b179d80451d3b062732b1768085d9ef8689').toLowerCase(),
  START_MS: new Date('2026-06-26T18:00:00+08:00').getTime(),
  END_MS: new Date('2026-06-26T20:00:00+08:00').getTime(),
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

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
const KV_KEY = `tge:final:${CONFIG.SYMBOL}:${CONFIG.ADDRESS}`;
// Global history of PAST (ended) tokens — one final entry per token, shared
// across all events so a new visitor sees every past sale, not just this one.
const HISTORY_KEY = 'tge:history:ended';
const HISTORY_MAX = 200;        // hard cap on the number of past tokens kept
const TOKEN_ID = `${CONFIG.SYMBOL}:${CONFIG.ADDRESS}`;

/* ---------- KV (Upstash REST) helpers ---------- */
async function kvGet(key) {
  if (!KV_URL || !KV_TOKEN) return null;
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${KV_TOKEN}` }
  });
  if (!r.ok) return null;
  const j = await r.json(); // { result: "<stored string>" | null }
  if (j == null || j.result == null) return null;
  try { return JSON.parse(j.result); } catch { return null; }
}

async function kvSet(key, value) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV not configured (missing KV_REST_API_URL / KV_REST_API_TOKEN)');
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(value)
  });
  if (!r.ok) throw new Error(`KV set failed: HTTP ${r.status}`);
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

/* ---------- History (ended tokens only) ---------- */
async function readHistory() {
  const h = await kvGet(HISTORY_KEY);
  return Array.isArray(h) ? h : [];
}

// Record this token into the global history — but ONLY once it has ended, and
// only once per token. Uses the final snapshot (captured during the window;
// after END the on-chain balance drops as refunds process, so we can't read it
// live anymore). Idempotent: re-running after it's recorded does nothing.
async function finalizeHistory() {
  if (Date.now() <= CONFIG.END_MS) return; // not ended yet → don't record
  const snap = await kvGet(KV_KEY);
  if (!snap || !(Number(snap.dep) > 0)) return; // no usable final value

  const arr = await readHistory();
  if (arr.some(e => e && e.id === TOKEN_ID)) return; // already recorded

  arr.push({
    id: TOKEN_ID,
    sym: CONFIG.SYMBOL,
    address: CONFIG.ADDRESS,
    dep: Number(snap.dep),
    bnbUSDT: Number(snap.bnbUSDT) || 0,
    // Time shown in history is the event's END moment (the final second), not
    // the moment the snapshot happened to be captured (cron at 21:59, or a
    // visitor mid-window). The value (dep) still comes from the last captured
    // snapshot; only the displayed timestamp is pinned to END.
    t: CONFIG.END_MS,
    endedAt: new Date(CONFIG.END_MS).toISOString()
  });
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  try { await kvSet(HISTORY_KEY, arr); } catch (e) { /* non-fatal */ }
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

  const bnbUSDT = await fetchBNBPrice(); // best-effort; 0 is fine, frontend can fetch live

  const snap = { dep, bnbUSDT, t: now, updatedAt: new Date(now).toISOString() };
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

  const action = req.query?.action || '';
  const isCapture = action === 'capture';

  // Read path for the global history of ended tokens. Self-heals: once this
  // token has ended, fold its final snapshot into the global list before
  // returning, so it shows up without needing a separate cron.
  if (action === 'history') {
    try {
      try { await finalizeHistory(); } catch (e) { /* non-fatal */ }
      const history = await readHistory();
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=60');
      return res.status(200).json({ history });
    } catch (e) {
      return res.status(200).json({ history: [] });
    }
  }

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
    } else if (now > CONFIG.END_MS) {
      // Event is over: make sure this token is recorded into the global history.
      try { await finalizeHistory(); } catch (e) { /* non-fatal */ }
    }
    const snap = (await kvGet(KV_KEY)) || {};
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 's-maxage=10, stale-while-revalidate=30');
    return res.status(200).json(snap);
  } catch (e) {
    return res.status(200).json({});
  }
}
