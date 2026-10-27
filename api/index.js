'use strict';
const db = require('../db');
const L = require('../core');
const { cfg, R, Reply, fmt, now, dayStart, toMicro, num, randHex } = L;

const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function route(a, req, ctx) {
  const d = db();
  const post = req.method === 'POST';
  const inp = ctx.body;
  const st = (uid) => L.state(uid, ctx.ip);
  const withState = async (uid, body, code) => R(body, code, uid);

  if (a === 'config') {
    return R({ adZone: cfg.zone(), adSrc: cfg.sdkSrc(), adsOff: cfg.zone() === '', inapp: cfg.inapp(), tasks: false, bonus: cfg.bonus(), brand: cfg.brand(), bot: cfg.botUsername(), theme: cfg.themeData() });
  }

  if (a === 'me') {
    const u = await L.auth(req);
    return R({ ...(await st(u.id)), owner: L.isOwner(u) });
  }

  // Login step: link a verified FaucetPay email to this Telegram account (once, permanent).
  if (a === 'register' && post) {
    const uid = num((await L.auth(req)).id);
    const email = String(inp.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 190) return R({ error: 'bad_email' }, 400);
    const cur = (await d.q('SELECT email FROM users WHERE id=?', [uid])).rows[0];
    if (cur && cur.email) return R({ error: 'already' }, 400, uid);
    if ((await d.q('SELECT id FROM users WHERE email=? AND id<>?', [email, uid])).rows.length) return R({ error: 'email_taken' }, 400);
    const cap = cfg.maxAccountsPerIp();
    if (cap > 0 && ctx.ip) {
      const n = num((await d.q('SELECT COUNT(*) c FROM users WHERE ip=? AND email IS NOT NULL AND id<>?', [ctx.ip, uid])).rows[0].c);
      if (n >= cap) return R({ error: 'ip_limit' }, 400);
    }
    const chk = await L.checkEmail(email);
    if (!chk.ok) return R({ error: chk.error }, 400);
    await d.q('UPDATE users SET email=? WHERE id=? AND email IS NULL', [email, uid]);
    return R({ ok: true }, 200, uid);
  }

  // Step 1: user is about to watch an ad. Issue a single-use token.
  if (a === 'ad_start' && post) {
    const uid = num((await L.auth(req)).id);
    await L.requireEmail(uid);
    const r = await d.tx(async (c) => {
      await L.lockUser(c, uid);
      const err = await L.claimCheck(c, uid);
      if (err) throw R({ error: err }, 400, uid);
      const strikes = num((await c.q('SELECT strikes FROM users WHERE id=?', [uid])).rows[0].strikes);
      const done = num((await c.q('SELECT COUNT(*) c FROM claims WHERE user_id=? AND created_at>=?', [uid, dayStart()])).rows[0].c);
      const every = cfg.captchaEvery();
      const need = (every > 0 && (done + 1) % every === 0) || strikes >= 3;
      let cq = null, ca = null;
      if (need) [cq, ca] = L.makeCaptcha();
      await c.q("DELETE FROM ad_sessions WHERE user_id=? AND used=0 AND (captcha_answer IS NULL OR captcha_answer<>'bonus')", [uid]);
      const token = randHex(16);
      await c.q('INSERT INTO ad_sessions (user_id, token, created_at, captcha_answer) VALUES (?,?,?,?)', [uid, token, now(), ca]);
      return R(need ? { token, captcha: cq } : { token });
    });
    return r;
  }

  // Step 2: ad finished, claim with the token.
  if (a === 'claim' && post) {
    const uid = num((await L.auth(req)).id);
    await L.requireEmail(uid);
    const token = String(inp.token || '');
    return d.tx(async (c) => {
      await L.lockUser(c, uid);
      const err = await L.claimCheck(c, uid);
      if (err) throw R({ error: err }, 400, uid);
      const row = (await c.q("SELECT id, created_at, captcha_answer FROM ad_sessions WHERE user_id=? AND token=? AND used=0 AND (captcha_answer IS NULL OR captcha_answer<>'bonus')", [uid, token])).rows[0];
      if (!row) throw R({ error: 'no_session' }, 400, uid);
      const age = now() - num(row.created_at);
      if (age < cfg.minAdSeconds()) throw R({ error: 'too_fast' }, 400); // session kept
      if (age > 600) throw R({ error: 'expired' }, 400, uid);
      const hadCaptcha = row.captcha_answer !== null;
      if (hadCaptcha && String(inp.captcha || '').trim() !== row.captcha_answer) {
        await c.q('UPDATE ad_sessions SET used=1 WHERE id=?', [row.id]);
        await c.q('UPDATE users SET strikes=strikes+1 WHERE id=?', [uid]);
        return R({ error: 'bad_captcha' }, 400, uid); // committed: the strike counts
      }
      const amt = toMicro(cfg.claimAmount());
      await c.q('UPDATE ad_sessions SET used=1 WHERE id=?', [row.id]);
      await c.q('INSERT INTO claims (user_id, amount, created_at) VALUES (?,?,?)', [uid, amt, now()]);
      await c.q('UPDATE users SET balance=balance+?, total_earned=total_earned+? WHERE id=?', [amt, amt, uid]);
      if (hadCaptcha) await c.q('UPDATE users SET strikes=0 WHERE id=?', [uid]);
      return R({ ok: true }, 200, uid);
    });
  }

  // Bonus offer (Rewarded Popup). Step 1: issue a single-use token.
  if (a === 'bonus_start' && post) {
    if (!cfg.bonus()) return R({ error: 'off' }, 404);
    const uid = num((await L.auth(req)).id);
    await L.requireEmail(uid);
    return d.tx(async (c) => {
      await L.lockUser(c, uid);
      if ((await L.setting('pause', c)) === '1') throw R({ error: 'paused' }, 400, uid);
      const lim = cfg.bonusDaily();
      if (lim <= 0 || (await L.bonusUsed(uid, c)) >= lim) throw R({ error: 'daily_limit' }, 400, uid);
      await c.q("DELETE FROM ad_sessions WHERE user_id=? AND used=0 AND captcha_answer='bonus'", [uid]);
      const token = randHex(16);
      await c.q("INSERT INTO ad_sessions (user_id, token, created_at, captcha_answer) VALUES (?,?,?,'bonus')", [uid, token, now()]);
      return R({ token });
    });
  }

  // Bonus offer. Step 2: the popup was confirmed, claim the reward.
  if (a === 'bonus_claim' && post) {
    if (!cfg.bonus()) return R({ error: 'off' }, 404);
    const uid = num((await L.auth(req)).id);
    await L.requireEmail(uid);
    const token = String(inp.token || '');
    return d.tx(async (c) => {
      await L.lockUser(c, uid);
      if ((await L.setting('pause', c)) === '1') throw R({ error: 'paused' }, 400, uid);
      const lim = cfg.bonusDaily();
      if (lim <= 0 || (await L.bonusUsed(uid, c)) >= lim) throw R({ error: 'daily_limit' }, 400, uid);
      const row = (await c.q("SELECT id, created_at FROM ad_sessions WHERE user_id=? AND token=? AND used=0 AND captcha_answer='bonus'", [uid, token])).rows[0];
      if (!row) throw R({ error: 'no_session' }, 400, uid);
      const age = now() - num(row.created_at);
      if (age < cfg.minAdSeconds()) throw R({ error: 'too_fast' }, 400);
      if (age > 900) throw R({ error: 'expired' }, 400, uid);
      const amt = toMicro(cfg.bonusAmount());
      await c.q('UPDATE ad_sessions SET used=1 WHERE id=?', [row.id]);
      await c.q('UPDATE users SET balance=balance+?, total_earned=total_earned+? WHERE id=?', [amt, amt, uid]);
      return R({ ok: true }, 200, uid);
    });
  }

  // Withdraw whole balance to the verified FaucetPay email, paid instantly through the FaucetPay API.
  if (a === 'withdraw' && post) {
    const uid = num((await L.auth(req)).id);
    await L.requireEmail(uid);
    if ((await L.setting('pause_withdraw')) === '1') return R({ error: 'paused' }, 400);
    const to = String((await d.q('SELECT email FROM users WHERE id=?', [uid])).rows[0].email);
    const w = await d.tx(async (c) => {
      const bal = num((await c.q('SELECT balance FROM users WHERE id=? FOR UPDATE', [uid])).rows[0].balance);
      if (bal < toMicro(cfg.minWithdraw())) throw R({ error: 'below_min' }, 400, uid);
      if (num((await c.q("SELECT COUNT(*) c FROM withdrawals WHERE user_id=? AND status='processing'", [uid])).rows[0].c) > 0) throw R({ error: 'pending_exists' }, 400, uid);
      await c.q('UPDATE users SET balance=0 WHERE id=?', [uid]);
      const ins = await c.q('INSERT INTO withdrawals (user_id, amount, destination, status, created_at, last_try) VALUES (?,?,?,?,?,?) RETURNING id', [uid, bal, to, 'processing', now(), now()]);
      return { id: num(ins.rows[0].id), user_id: uid, amount: bal, destination: to };
    });
    await L.processWithdrawal(w, ctx.ip);
    return R({ ok: true }, 200, uid);
  }

  // ---- Coupons (users) ----
  if (a === 'coupon' && post) {
    const uid = num((await L.auth(req)).id);
    await L.requireEmail(uid);
    if ((await L.setting('pause')) === '1') return R({ error: 'paused' }, 400);
    const code = String(inp.code || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
    if (num((await d.q('SELECT COUNT(*) c FROM coupon_tries WHERE user_id=? AND created_at>?', [uid, now() - 3600])).rows[0].c) >= 8) return R({ error: 'too_many' }, 429);
    return d.tx(async (c) => {
      await L.lockUser(c, uid);
      const cp = code === '' ? null : (await c.q('SELECT * FROM coupons WHERE code=? FOR UPDATE', [code])).rows[0];
      let err = null;
      if (!cp || !num(cp.active)) err = 'invalid';
      else if (num(cp.expires_at) < now()) err = 'expired';
      else if (num(cp.used) >= num(cp.max_uses)) err = 'used_up';
      else if ((await c.q('SELECT 1 FROM coupon_redemptions WHERE coupon_id=? AND user_id=?', [cp.id, uid])).rows.length) err = 'already';
      if (err) {
        if (err !== 'already') await c.q('INSERT INTO coupon_tries (user_id, created_at) VALUES (?,?)', [uid, now()]);
        return R({ error: err }, 400);
      }
      const amt = num(cp.amount);
      await c.q('INSERT INTO coupon_redemptions (coupon_id, user_id, amount, created_at) VALUES (?,?,?,?)', [cp.id, uid, amt, now()]);
      await c.q('UPDATE coupons SET used=used+1 WHERE id=?', [cp.id]);
      await c.q('UPDATE users SET balance=balance+?, total_earned=total_earned+? WHERE id=?', [amt, amt, uid]);
      return R({ ok: true, reward: fmt(amt) }, 200, uid);
    });
  }

  // ---- Owner dashboard (every call re-checks the owner on the server) ----
  if (a.startsWith('o_')) {
    const me = await L.ownerAuth(req);
    const one = async (sql, p = []) => (await d.q(sql, p)).rows[0];

    if (a === 'o_stats') {
      const t0 = dayStart();
      const u = await one(`SELECT COUNT(*) total, COUNT(*) FILTER (WHERE email IS NOT NULL) reg, COUNT(*) FILTER (WHERE banned=1) banned,
                                  COUNT(*) FILTER (WHERE created_at>=?) newtoday, COALESCE(SUM(balance),0) owed FROM users`, [t0]);
      const c = await one('SELECT COUNT(*) total, COUNT(*) FILTER (WHERE created_at>=?) today, COALESCE(SUM(amount),0) paidout FROM claims', [t0]);
      const w = await one(`SELECT COUNT(*) FILTER (WHERE status='paid') paid_n, COALESCE(SUM(amount) FILTER (WHERE status='paid'),0) paid_amt,
                                  COUNT(*) FILTER (WHERE status='processing') pend_n, COALESCE(SUM(amount) FILTER (WHERE status='processing'),0) pend_amt FROM withdrawals`);
      const cp = await one('SELECT COUNT(*) n FROM coupons WHERE active=1 AND expires_at>? AND used<max_uses', [now()]);
      return R({
        users: num(u.total), registered: num(u.reg), banned: num(u.banned), newToday: num(u.newtoday), owed: fmt(u.owed),
        claims: num(c.total), claimsToday: num(c.today), earnedByClaims: fmt(c.paidout),
        paidCount: num(w.paid_n), paidTotal: fmt(w.paid_amt), pendingCount: num(w.pend_n), pendingTotal: fmt(w.pend_amt),
        activeCoupons: num(cp.n), pause: (await L.setting('pause')) === '1', pauseWithdraw: (await L.setting('pause_withdraw')) === '1',
      });
    }

    if (a === 'o_users') {
      const q = String(ctx.query.q || '').trim();
      const sel = `SELECT id, username, first_name, email, balance, banned, created_at,
                          (SELECT COUNT(*) FROM claims c WHERE c.user_id = users.id) AS claims FROM users`;
      let rows;
      if (q === '') rows = (await d.q(sel + ' ORDER BY created_at DESC LIMIT 25')).rows;
      else {
        const bare = q.replace(/^@/, '');
        const like = '%' + bare.replace(/[\\%_]/g, (m) => '\\' + m) + '%';
        rows = (await d.q(sel + ' WHERE CAST(id AS TEXT) = ? OR username ILIKE ? OR email ILIKE ? OR first_name ILIKE ? ORDER BY created_at DESC LIMIT 25', [bare, like, like, like])).rows;
      }
      return R({ users: rows.map((r) => ({ id: String(r.id), username: r.username, name: r.first_name, email: r.email, balance: fmt(r.balance), banned: num(r.banned) === 1, claims: num(r.claims), joined: num(r.created_at) })) });
    }

    if (a === 'o_user') {
      const id = num(ctx.query.id);
      const r = await one('SELECT * FROM users WHERE id=?', [id]);
      if (!r) return R({ error: 'not_found' }, 404);
      const c = await one('SELECT COUNT(*) total, COUNT(*) FILTER (WHERE created_at>=?) today, MAX(created_at) last FROM claims WHERE user_id=?', [dayStart(), id]);
      const w = await one("SELECT COUNT(*) n, COALESCE(SUM(amount) FILTER (WHERE status='paid'),0) paid FROM withdrawals WHERE user_id=?", [id]);
      const cp = await one('SELECT COUNT(*) n, COALESCE(SUM(amount),0) amt FROM coupon_redemptions WHERE user_id=?', [id]);
      const same = await one("SELECT COUNT(*) n FROM users WHERE ip=? AND id<>? AND ip IS NOT NULL AND ip<>''", [String(r.ip || ''), id]);
      return R({ user: {
        id: String(r.id), username: r.username, name: r.first_name, email: r.email, balance: fmt(r.balance), totalEarned: fmt(r.total_earned),
        banned: num(r.banned) === 1, strikes: num(r.strikes), joined: num(r.created_at),
        claims: num(c.total), claimsToday: num(c.today), lastClaim: c.last ? num(c.last) : null,
        withdrawals: num(w.n), withdrawn: fmt(w.paid), coupons: num(cp.n), couponTotal: fmt(cp.amt), sameIp: num(same.n),
      } });
    }

    if (a === 'o_ban' && post) {
      const id = num(inp.id);
      if (id === num(me.id)) return R({ error: 'self' }, 400);
      await d.q('UPDATE users SET banned=? WHERE id=?', [inp.banned ? 1 : 0, id]);
      if (inp.banned) await d.q('UPDATE ad_sessions SET used=1 WHERE user_id=?', [id]);
      return R({ ok: true });
    }

    if (a === 'o_coupons') {
      const rows = (await d.q('SELECT id, code, amount, max_uses, used, active, created_at, expires_at FROM coupons ORDER BY id DESC LIMIT 30')).rows;
      return R({ now: now(), coupons: rows.map((r) => ({ id: num(r.id), code: r.code, amount: fmt(r.amount), max: num(r.max_uses), used: num(r.used), active: num(r.active) === 1, expires: num(r.expires_at) })) });
    }

    if (a === 'o_coupon_new' && post) {
      const amount = Number(inp.amount || 0), uses = Math.trunc(Number(inp.uses || 0));
      if (!(amount >= 0.0001 && amount <= 5)) return R({ error: 'bad_amount' }, 400);
      if (!(uses >= 1 && uses <= 1000)) return R({ error: 'bad_uses' }, 400);
      let code = null;
      for (let i = 0; i < 6 && !code; i++) {
        let t = ''; for (let k = 0; k < 8; k++) t += ALPHA[require('crypto').randomInt(ALPHA.length)];
        const ins = await d.q('INSERT INTO coupons (code, amount, max_uses, created_at, expires_at) VALUES (?,?,?,?,?) ON CONFLICT (code) DO NOTHING', [t, toMicro(amount), uses, now(), now() + 86400]);
        if (ins.count === 1) code = t;
      }
      if (!code) return R({ error: 'server' }, 500);
      return R({ ok: true, code, amount: fmt(toMicro(amount)), uses, expires: now() + 86400 });
    }

    if (a === 'o_coupon_off' && post) {
      await d.q('UPDATE coupons SET active=0 WHERE id=?', [num(inp.id)]);
      return R({ ok: true });
    }

    if (a === 'o_withdrawals') {
      const rows = (await d.q(`SELECT w.id, w.user_id, w.amount, w.destination, w.status, w.note, w.created_at, u.username
                               FROM withdrawals w LEFT JOIN users u ON u.id = w.user_id ORDER BY w.id DESC LIMIT 30`)).rows;
      return R({ items: rows.map((r) => ({ id: num(r.id), user: String(r.user_id), username: r.username, amount: fmt(r.amount), to: r.destination, status: r.status, note: r.note, at: num(r.created_at) })) });
    }

    if (a === 'o_setting' && post) {
      const name = String(inp.name || '');
      if (!['pause', 'pause_withdraw'].includes(name)) return R({ error: 'bad_setting' }, 400);
      await d.q('INSERT INTO settings (name, val) VALUES (?,?) ON CONFLICT (name) DO UPDATE SET val=EXCLUDED.val', [name, inp.value ? '1' : '0']);
      return R({ ok: true });
    }

    // ---- Broadcast. The bot webhook saves the owner's last text message; the app sends it to everyone ----
    if (a === 'o_bc_fetch') {
      const text = await L.setting('bc_draft');
      const n = await one('SELECT COUNT(*) n FROM users WHERE banned=0');
      return R({ message: text ? { update_id: 0, text, date: now() } : null, total: num(n.n) });
    }

    if (a === 'o_bc_send' && post) {
      const text = String(inp.text || '').trim();
      if (!text || [...text].length > 1000) return R({ error: 'bad_text' }, 400);
      const after = num(inp.after);
      const rows = (await d.q('SELECT id FROM users WHERE id>? AND banned=0 ORDER BY id LIMIT 20', [after])).rows;
      const site = cfg.siteUrl();
      let sent = 0, failed = 0, last = after, wait = 0, lastErr = '';
      for (const r of rows) {
        const body = { chat_id: num(r.id), text };
        if (site) body.reply_markup = { inline_keyboard: [[{ text: 'Open faucet', web_app: { url: site } }]] };
        const [code, j] = await L.tg('sendMessage', body);
        if (code === 429) { wait = num(j.parameters && j.parameters.retry_after) || 3; break; }
        last = num(r.id);
        if (j.ok) sent++; else { failed++; lastErr = String(j.description || 'HTTP ' + code).slice(0, 120); }
        await new Promise((res) => setTimeout(res, 60));
      }
      return R({ next: last, sent, failed, wait, err: lastErr, done: wait === 0 && rows.length < 20 });
    }

    if (a === 'o_bc_ack' && post) {
      await d.q("DELETE FROM settings WHERE name='bc_draft'");
      return R({ ok: true });
    }

    return R({ error: 'not_found' }, 404);
  }

  return R({ error: 'not_found' }, 404);
}

module.exports = async (req, res) => {
  let reply;
  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const url = new URL(req.url, 'http://x');
    const query = Object.fromEntries(url.searchParams.entries());
    const ctx = { body: body && typeof body === 'object' ? body : {}, query, ip: L.clientIp(req) };
    try { reply = await route(String(query.a || ''), req, ctx); }
    catch (e) { if (e instanceof Reply) reply = e; else throw e; }
    if (reply.uid !== null && reply.uid !== undefined) reply = R({ ...(await L.state(reply.uid, ctx.ip)), ...reply.body }, reply.code);
  } catch (e) {
    console.error('faucet:', e && e.stack || e);
    reply = R({ error: 'server', ...(process.env.DEBUG === 'true' ? { detail: String(e && e.message).slice(0, 200) } : {}) }, 500);
  }
  res.status(reply.code).setHeader('Cache-Control', 'no-store').json(reply.body);
};
module.exports.route = route;
