'use strict';
const db = require('../db');
const L = require('../core');
const { cfg, now } = L;

const WELCOME = () => `Welcome to ${cfg.brand()} ❄️\n\nWatch short ads, earn USDT, and get paid instantly to your FaucetPay account.\n\nTap the button below to start earning.`;
const openBtn = () => {
  const url = cfg.siteUrl();
  return url ? { inline_keyboard: [[{ text: '❄️ Open App', web_app: { url } }]] } : undefined;
};

async function handleMessage(m) {
  if (!m || !m.chat || m.chat.type !== 'private' || !m.from || m.from.is_bot) return;
  const d = db();
  const text = String(m.text || '');
  // Anyone who talks to the bot can receive broadcasts.
  await d.q(`INSERT INTO users (id, username, first_name, created_at) VALUES (?,?,?,?)
             ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, first_name = EXCLUDED.first_name`,
    [m.from.id, m.from.username || null, m.from.first_name || null, now()]);

  if (text.startsWith('/start') || text.startsWith('/help') || text.startsWith('/app')) {
    await L.tg('sendMessage', { chat_id: m.chat.id, text: WELCOME(), reply_markup: openBtn() });
    return;
  }
  if (L.isOwner({ id: m.from.id, username: m.from.username }) && text && !text.startsWith('/')) {
    // Owner texts become the draft for "Message to all users" in the app.
    await d.q('INSERT INTO settings (name, val) VALUES (?,?) ON CONFLICT (name) DO UPDATE SET val=EXCLUDED.val', ['bc_draft', text.slice(0, 1000)]);
    await L.tg('sendMessage', { chat_id: m.chat.id, text: 'Saved as your broadcast draft ✅\nOpen the app → Owner → Message → Load from bot chat.', reply_markup: openBtn() });
    return;
  }
  if (text) await L.tg('sendMessage', { chat_id: m.chat.id, text: 'Tap the button to open the app.', reply_markup: openBtn() });
}

module.exports = async (req, res) => {
  try {
    const secret = cfg.webhookSecret();
    const url = new URL(req.url, 'http://x');

    // One-time setup: open  /api/telegram?setup=<WEBHOOK_SECRET>  in the phone browser.
    if (req.method === 'GET') {
      if (!secret || url.searchParams.get('setup') !== secret) return res.status(403).send('forbidden');
      const site = cfg.siteUrl();
      if (!site) return res.status(500).send('SITE_URL is not set');
      const out = {};
      out.webhook = (await L.tg('setWebhook', { url: site + '/api/telegram', secret_token: secret, allowed_updates: ['message'], drop_pending_updates: true }))[1];
      out.menu = (await L.tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open', web_app: { url: site } } }))[1];
      out.commands = (await L.tg('setMyCommands', { commands: [{ command: 'start', description: 'Open the app' }] }))[1];
      return res.status(200).setHeader('Content-Type', 'application/json').send(JSON.stringify(out, null, 2));
    }

    if (!secret || req.headers['x-telegram-bot-api-secret-token'] !== secret) return res.status(403).send('forbidden');
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    await handleMessage(body && body.message);
  } catch (e) {
    console.error('webhook:', e && e.stack || e);
  }
  res.status(200).send('ok'); // always 200 so Telegram does not keep retrying
};
module.exports.handleMessage = handleMessage;
