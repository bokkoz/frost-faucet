'use strict';
const crypto = require('crypto');
const db = require('./db');

const MICRO = 1000000;
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const envNum = (k, d) => { const v = Number(env(k, d)); return Number.isFinite(v) ? v : d; };

const ICONS = {
  flake: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7M9 3.5l3 2.5 3-2.5M9 20.5l3-2.5 3 2.5M2.5 10.2l3.6.2-.9-3.5M21.5 13.8l-3.6-.2.9 3.5M2.5 13.8l3.6-.2-.9 3.5M21.5 10.2l-3.6.2.9-3.5"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  wave: '<path d="M2 8c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 13c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2M2 18c2.5 0 2.5-2 5-2s2.5 2 5 2 2.5-2 5-2 2.5 2 5 2"/>',
  moon: '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>',
  storm: '<path d="M17 18a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9a4.5 4.5 0 0 0 .5 9"/><path d="M12 11l-3 5h4l-2 4"/>',
};
// One code base, many faucets: pick a look with THEME=frost|neon|storm|ocean|shadow
const THEMES = {
  frost:  { brand: 'Frost',  bot: 'frostfaucet_bot',  emoji: '❄️', icon: 'flake', bg: '#070d14', surface: '#0e1823', surface2: '#14212f', line: '#1f3347', text: '#e8f4fb', muted: '#7d97ab', accent: '#5cd6ff', ink: '#04202e' },
  neon:   { brand: 'Neon',   bot: 'neonfaucet_bot',   emoji: '⚡', icon: 'bolt',  bg: '#0d0710', surface: '#1a0f1f', surface2: '#24142b', line: '#3a2145', text: '#fbeaf6', muted: '#a487a0', accent: '#ff3fb4', ink: '#2a0220' },
  storm:  { brand: 'Storm',  bot: 'stormfaucet_bot',  emoji: '⛈', icon: 'storm', bg: '#0c0d10', surface: '#16181d', surface2: '#1f2229', line: '#30343d', text: '#f3f1e6', muted: '#8c8f98', accent: '#ffd21f', ink: '#231b00' },
  ocean:  { brand: 'Ocean',  bot: 'oceanfaucet_bot',  emoji: '🌊', icon: 'wave',  bg: '#05121a', surface: '#0a1f2b', surface2: '#0f2a39', line: '#17415a', text: '#e6f7f8', muted: '#78a3aa', accent: '#1fd1c1', ink: '#032a27' },
  shadow: { brand: 'Shadow', bot: 'shadowfaucet_bot', emoji: '🌑', icon: 'moon',  bg: '#08080a', surface: '#131316', surface2: '#1b1b20', line: '#2b2b33', text: '#ececf0', muted: '#8b8b96', accent: '#c9ccd6', ink: '#121216' },
};
const themeName = () => (THEMES[String(env('THEME', 'frost')).toLowerCase()] ? String(env('THEME', 'frost')).toLowerCase() : 'frost');
const theme = () => THEMES[themeName()];
const cfg = {
  botToken: () => env('BOT_TOKEN', ''),
  faucetpayKey: () => env('FAUCETPAY_KEY', ''),
  currency: () => env('CURRENCY', 'USDT'),
  decimals: () => envNum('USDT_DECIMALS', 8),
  verifyEmail: () => env('VERIFY_EMAIL', 'true') !== 'false',
  claimAmount: () => envNum('CLAIM_AMOUNT', 0.0005),
  dailyLimit: () => envNum('DAILY_LIMIT', 20),
  cooldown: () => envNum('COOLDOWN', 20),
  minAdSeconds: () => envNum('MIN_AD_SECONDS', 8),
  minWithdraw: () => envNum('MIN_WITHDRAW', 0.01),
  captchaEvery: () => envNum('CAPTCHA_EVERY', 5),
  maxAccountsPerIp: () => envNum('MAX_ACCOUNTS_PER_IP', 0),
  bonus: () => env('BONUS', 'true') === 'true',
  bonusAmount: () => envNum('BONUS_AMOUNT', 0.0003),
  bonusDaily: () => envNum('BONUS_DAILY', 3),
  inapp: () => env('INAPP_POPUPS', 'false') === 'true',
  zone: () => env('MONETAG_ZONE', ''),
  sdkSrc: () => env('MONETAG_SDK_SRC', 'https://libtl.com/sdk.js'),
  ownerUsername: () => env('OWNER_USERNAME', 'Ratha123z'),
  ownerId: () => env('OWNER_ID', ''),
  brand: () => env('BRAND', theme().brand),
  emoji: () => theme().emoji,
  botUsername: () => env('BOT_USERNAME', theme().bot),
  themeData: () => ({ ...theme(), iconSvg: ICONS[theme().icon], name: themeName() }),
  siteUrl: () => env('SITE_URL', process.env.VERCEL_PROJECT_PRODUCTION_URL ? 'https://' + process.env.VERCEL_PROJECT_PRODUCTION_URL : ''),
  webhookSecret: () => env('WEBHOOK_SECRET', ''),
};

// A reply is thrown (rolls back) or returned from a transaction (commits).
class Reply {
  constructor(body, code = 200, uid = null) { this.body = body; this.code = code; this.uid = uid; }
}
const R = (body, code = 200, uid = null) => new Reply(body, code, uid);

const fmt = (m) => (Number(m) / MICRO).toFixed(4);
const now = () => Math.floor(Date.now() / 1000);
const dayStart = () => Math.floor(now() / 86400) * 86400;
const toMicro = (x) => Math.round(Number(x) * MICRO);
const num = (x) => Number(x || 0);
const randHex = (n) => crypto.randomBytes(n).toString('hex');

// ---------- Telegram initData ----------
function verifyInitData(init) {
  if (!init) return null;
  const p = new URLSearchParams(init);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const lines = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => k + '=' + v);
  const secret = crypto.createHmac('sha256', 'WebAppData').update(cfg.botToken()).digest();
  const calc = crypto.createHmac('sha256', secret).update(lines.join('\n')).digest('hex');
  const a = Buffer.from(calc), b = Buffer.from(hash);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (now() - Number(p.get('auth_date') || 0) > 86400) return null;
  try { const u = JSON.parse(p.get('user') || ''); return u && u.id ? u : null; } catch (e) { return null; }
}

const clientIp = (req) => {
  const h = req.headers;
  const v = String(h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0] || '').trim();
  return v.slice(0, 64);
};

async function auth(req) {
  const u = verifyInitData(String(req.headers['x-init-data'] || ''));
  if (!u) throw R({ error: 'unauthorized' }, 401);
  const d = db();
  await d.q(`INSERT INTO users (id, username, first_name, created_at) VALUES (?,?,?,?)
             ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
    [u.id, u.username || null, u.first_name || null, now()]);
  const r = await d.q('SELECT banned FROM users WHERE id=?', [u.id]);
  if (num(r.rows[0] && r.rows[0].banned) === 1) throw R({ error: 'banned' }, 403);
  await d.q('UPDATE users SET ip=? WHERE id=?', [clientIp(req), u.id]);
  return u;
}

const isOwner = (u) => {
  const id = cfg.ownerId();
  if (id) return String(id) === String(u.id);
  const name = String(cfg.ownerUsername()).replace(/^@/, '').toLowerCase();
  return name !== '' && String(u.username || '').toLowerCase() === name;
};
async function ownerAuth(req) {
  const u = await auth(req);
  if (!isOwner(u)) throw R({ error: 'forbidden' }, 403);
  return u;
}

function makeCaptcha() {
  const a = 10 + crypto.randomInt(10), b = 2 + crypto.randomInt(8);
  return crypto.randomInt(2) ? [`${a} + ${b}`, String(a + b)] : [`${a} - ${b}`, String(a - b)];
}

// ---------- settings ----------
async function setting(name, c) {
  try { const r = await (c || db()).q('SELECT val FROM settings WHERE name=?', [name]); return r.rows[0] ? String(r.rows[0].val) : null; }
  catch (e) { return null; }
}

// ---------- FaucetPay ----------
async function fpPost(path, body, timeout) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch('https://faucetpay.io/api/v2/' + path, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.faucetpayKey() },
      body: JSON.stringify(body),
    });
    const raw = await r.text();
    let j = {}; try { j = JSON.parse(raw) || {}; } catch (e) {}
    return { code: r.status, j, raw };
  } catch (e) { return null; } finally { clearTimeout(t); }
}

async function faucetpaySend(wdId, to, micro, ip) {
  const dec = cfg.decimals();
  const units = dec >= 6 ? micro * 10 ** (dec - 6) : Math.floor(micro / 10 ** (6 - dec));
  const body = { idempotency_key: 'wd-' + wdId, to, amount: units, currency: cfg.currency() };
  if (ip) body.ip_address = ip;
  const r = await fpPost('send', body, 20000);
  if (!r) return { ok: false, retry: true, msg: 'network error' };
  if (r.code === 200 && r.j.success) return { ok: true, payoutId: String((r.j.data && r.j.data.payout_id) || ''), msg: 'ok' };
  const msg = String(r.j.message || 'HTTP ' + r.code).slice(0, 200);
  return { ok: false, retry: r.code === 429 || r.code >= 500 || r.code === 409, msg };
}

async function processWithdrawal(w, ip) {
  const d = db();
  const r = await faucetpaySend(w.id, w.destination, w.amount, ip);
  if (r.ok) { await d.q("UPDATE withdrawals SET status='paid', payout_id=?, note=NULL WHERE id=? AND status='processing'", [r.payoutId, w.id]); return; }
  if (r.retry) { await d.q("UPDATE withdrawals SET attempts=attempts+1, last_try=?, note=? WHERE id=? AND status='processing'", [now(), r.msg, w.id]); return; }
  await d.tx(async (c) => {
    const u = await c.q("UPDATE withdrawals SET status='failed', note=? WHERE id=? AND status='processing'", [r.msg, w.id]);
    if (u.count === 1) await c.q('UPDATE users SET balance = balance + ? WHERE id = ?', [w.amount, w.user_id]);
  });
}

async function retryPending(uid, ip) {
  const d = db();
  const r = await d.q("SELECT * FROM withdrawals WHERE user_id=? AND status='processing' AND attempts < 100 AND last_try <= ? LIMIT 3", [uid, now() - 900]);
  for (const w of r.rows) {
    await d.q('UPDATE withdrawals SET last_try=? WHERE id=?', [now(), w.id]);
    await processWithdrawal({ id: num(w.id), user_id: num(w.user_id), amount: num(w.amount), destination: w.destination }, ip);
  }
}

async function checkEmail(email) {
  if (!cfg.verifyEmail()) return { ok: true };
  const r = await fpPost('check-address', { address: email, currency: cfg.currency() }, 15000);
  if (!r || r.code >= 500 || [429, 401, 403, 405].includes(r.code)) {
    console.error('faucetpay check unavailable', r && r.code, r && String(r.raw).slice(0, 200));
    return { ok: false, error: 'check_unavailable' };
  }
  if (r.code === 200 && r.j.success === true && r.j.data && r.j.data.payout_user_hash) return { ok: true };
  return { ok: false, error: 'not_faucetpay' };
}

// ---------- Telegram Bot API ----------
async function tg(method, params = {}) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + cfg.botToken() + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
    });
    const raw = await r.text();
    let j; try { j = JSON.parse(raw); } catch (e) { j = { ok: false, description: 'bad reply (HTTP ' + r.status + ')' }; }
    return [r.status, j];
  } catch (e) { return [0, { ok: false, description: 'network: ' + e.message }]; }
}

// ---------- state ----------
async function bonusUsed(uid, c) {
  const r = await (c || db()).q("SELECT COUNT(*) c FROM ad_sessions WHERE user_id=? AND captcha_answer='bonus' AND used=1 AND created_at>=?", [uid, dayStart()]);
  return num(r.rows[0].c);
}

async function state(uid, ip) {
  await retryPending(uid, ip);
  const d = db();
  const u = (await d.q('SELECT balance, total_earned, email FROM users WHERE id=?', [uid])).rows[0];
  const used = num((await d.q('SELECT COUNT(*) c FROM claims WHERE user_id=? AND created_at>=?', [uid, dayStart()])).rows[0].c);
  const last = (await d.q('SELECT created_at FROM claims WHERE user_id=? ORDER BY id DESC LIMIT 1', [uid])).rows[0];
  const wait = last ? Math.max(0, num(last.created_at) + cfg.cooldown() - now()) : 0;
  const wds = (await d.q('SELECT id, amount, destination, status FROM withdrawals WHERE user_id=? ORDER BY id DESC LIMIT 10', [uid])).rows
    .map((w) => ({ id: num(w.id), amount: fmt(w.amount), destination: w.destination, status: w.status }));
  const bLim = cfg.bonusDaily();
  const bUsed = await bonusUsed(uid);
  return {
    registered: !!u.email, email: u.email, balance: fmt(u.balance), totalEarned: fmt(u.total_earned),
    claimAmount: fmt(toMicro(cfg.claimAmount())), claimsToday: used, dailyLimit: cfg.dailyLimit(), cooldown: wait,
    minWithdraw: fmt(toMicro(cfg.minWithdraw())), withdrawals: wds,
    bonus: { amount: fmt(toMicro(cfg.bonusAmount())), left: Math.max(0, bLim - bUsed), limit: bLim },
  };
}

// Daily limit + cooldown. Call inside a transaction that already locked the user row.
async function claimCheck(c, uid) {
  if ((await setting('pause', c)) === '1') return 'paused';
  const n = num((await c.q('SELECT COUNT(*) c FROM claims WHERE user_id=? AND created_at>=?', [uid, dayStart()])).rows[0].c);
  const lim = cfg.dailyLimit();
  if (lim > 0 && n >= lim) return 'daily_limit';
  const last = (await c.q('SELECT created_at FROM claims WHERE user_id=? ORDER BY id DESC LIMIT 1', [uid])).rows[0];
  if (last && now() - num(last.created_at) < cfg.cooldown()) return 'cooldown';
  return null;
}
const lockUser = (c, uid) => c.q('SELECT id FROM users WHERE id=? FOR UPDATE', [uid]);

async function requireEmail(uid) {
  const r = (await db().q('SELECT email FROM users WHERE id=?', [uid])).rows[0];
  if (!r || !r.email) throw R({ error: 'not_registered' }, 403);
}

module.exports = {
  MICRO, cfg, Reply, R, fmt, now, dayStart, toMicro, num, randHex, verifyInitData, clientIp, auth, ownerAuth, isOwner,
  makeCaptcha, setting, faucetpaySend, processWithdrawal, retryPending, checkEmail, tg, bonusUsed, state, claimCheck,
  lockUser, requireEmail,
};
