// Telegram bot: linking people's chats and sending them messages.
// Configured by the TELEGRAM_BOT_TOKEN secret; without it everything here is switched off.

const API = 'https://api.telegram.org';
const CODE_TTL_MS = 15 * 60_000;

export const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const utf8 = s => new TextEncoder().encode(s);

async function hmac(keyBytes, message) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof message === 'string' ? utf8(message) : message));
}

function sameText(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Checks the signed "initData" Telegram gives a Mini App, as specified at
// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
// Returns the Telegram user ({ id, username, first_name, … }) or null.
export async function verifyInitData(token, initData, { maxAgeSeconds = 86400, now = Date.now() } = {}) {
  if (typeof initData !== 'string' || !initData || initData.length > 4096) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = await hmac(utf8('WebAppData'), token);
  if (!sameText(hex(await hmac(secretKey, dataCheck)), hash)) return null;
  const authDate = Number(params.get('auth_date'));
  if (!authDate || now / 1000 - authDate > maxAgeSeconds) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user && Number.isInteger(user.id) ? user : null;
  } catch {
    return null;
  }
}

export const telegramDisplayName = u => (u?.username ? `@${u.username}` : (u?.first_name || ''));

// Secret Telegram echoes back on every webhook call, derived from the token so there's
// nothing extra to configure. Only [A-Za-z0-9_-] is allowed.
export async function webhookSecret(token) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('splitwise-webhook'))).slice(0, 48);
}

export function createTelegram({ token, db, fetchImpl = (...a) => fetch(...a) }) {
  if (!token) return null;
  let botUsername = null;

  async function call(method, body = {}) {
    const res = await fetchImpl(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: !!json.ok, result: json.result, description: json.description || '' };
  }

  const send = (chatId, text) => call('sendMessage', {
    chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true },
  });

  return {
    async username() {
      if (!botUsername) {
        const r = await call('getMe');
        if (!r.ok) throw new Error(`Telegram rejected the bot token (${r.description || r.status}).`);
        botUsername = r.result.username;
      }
      return botUsername;
    },

    async setWebhook(url) {
      const r = await call('setWebhook', {
        url, secret_token: await webhookSecret(token), allowed_updates: ['message'], drop_pending_updates: true,
      });
      if (!r.ok) throw new Error(`Telegram refused the webhook: ${r.description || r.status}`);
    },

    async webhookInfo() {
      const r = await call('getWebhookInfo');
      return r.ok ? r.result : null;
    },

    verifySecret: async header => !!header && header === await webhookSecret(token),

    verifyInitData: initData => verifyInitData(token, initData),

    // The "Open Splitwise" button beside the message box in every chat with the bot.
    async setMenuButton(url) {
      const r = await call('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Open Splitwise', web_app: { url } } });
      if (!r.ok) throw new Error(`Telegram refused the menu button: ${r.description || r.status}`);
    },

    // The bot's profile picture. Telegram wants a JPG sent as a file upload.
    async setProfilePhoto(jpegBytes) {
      const form = new FormData();
      form.append('photo', JSON.stringify({ type: 'static', photo: 'attach://picture' }));
      form.append('picture', new Blob([jpegBytes], { type: 'image/jpeg' }), 'picture.jpg');
      const res = await fetchImpl(`${API}/bot${token}/setMyProfilePhoto`, { method: 'POST', body: form });
      const json = await res.json().catch(() => ({}));
      if (!json.ok) throw new Error(`Telegram refused the picture: ${json.description || res.status}`);
    },

    async menuButton() {
      const r = await call('getChatMenuButton');
      return r.ok ? r.result : null;
    },

    // One-time code for t.me/<bot>?start=<code>: 15 minutes by default (the Connect button),
    // longer for invites an admin sends to someone.
    async createLinkCode(userId, ttlMs = CODE_TTL_MS, kind = 'connect') {
      const code = hex(crypto.getRandomValues(new Uint8Array(16)));
      await db.batch([
        ['DELETE FROM telegram_codes WHERE user_id = ? OR expires_at < ?', userId, Date.now()],
        ['INSERT INTO telegram_codes (code, user_id, expires_at, kind) VALUES (?, ?, ?, ?)', code, userId, Date.now() + ttlMs, kind],
      ]);
      return code;
    },

    // messages: [{ userId, text }]. People without a linked chat are skipped. Chats that
    // blocked the bot or no longer exist are unlinked so we stop trying.
    async sendToUsers(messages) {
      if (!messages.length) return;
      const ids = [...new Set(messages.map(m => m.userId))];
      const links = await db.all(`SELECT user_id, chat_id FROM telegram_links WHERE user_id IN (${ids.map(() => '?').join(',')})`, ...ids);
      const chatOf = new Map(links.map(l => [l.user_id, l.chat_id]));
      await Promise.all(messages.filter(m => chatOf.has(m.userId)).map(async m => {
        const r = await send(chatOf.get(m.userId), m.text);
        if (r.status === 403 || (r.status === 400 && /chat not found/i.test(r.description))) {
          await db.run('DELETE FROM telegram_links WHERE user_id = ?', m.userId);
        } else if (!r.ok) {
          console.error('telegram sendMessage failed', r.status, r.description);
        }
      }));
    },

    send,

    // Incoming messages to the bot (via the webhook).
    async handleUpdate(update, appUrl) {
      const msg = update && update.message;
      if (!msg || !msg.chat || msg.chat.type !== 'private' || typeof msg.text !== 'string') return;
      const chatId = String(msg.chat.id);
      const [command, arg] = msg.text.trim().split(/\s+/, 2);

      if (command === '/start' && arg) {
        const row = await db.get('SELECT user_id, kind FROM telegram_codes WHERE code = ? AND expires_at > ?', arg, Date.now());
        if (!row) {
          await send(chatId, 'That link has expired or was already used. Ask whoever runs your Splitwise for a new invite link.');
          return;
        }
        const tgName = telegramDisplayName(msg.from);
        await db.batch([
          ['DELETE FROM telegram_codes WHERE code = ?', arg],
          ['DELETE FROM telegram_links WHERE chat_id = ? OR user_id = ?', chatId, row.user_id], // one person per chat
          ['INSERT INTO telegram_links (user_id, chat_id, tg_name) VALUES (?, ?, ?)', row.user_id, chatId, tgName],
        ]);
        const user = await db.get('SELECT name, username FROM users WHERE id = ?', row.user_id);
        await send(chatId, `✅ Connected to Splitwise as <b>${escapeHtml(user?.name || '')}</b>.\n\n`
          + 'You\'ll get a message here whenever someone adds, edits or deletes an expense or payment you\'re part of.\n\n'
          + 'Tap <b>Open Splitwise</b> below the message box to use the app right here in Telegram. Send /stop to turn notifications off.');
        // Tell the admins (those on Telegram) that someone accepted their invite.
        if (row.kind === 'invite') {
          const admins = await db.all(`SELECT l.chat_id FROM telegram_links l JOIN users u ON u.id = l.user_id
            WHERE u.is_admin = 1 AND u.active = 1 AND u.id != ?`, row.user_id);
          await Promise.all(admins.map(a => send(a.chat_id,
            `✅ <b>${escapeHtml(user?.name || '')}</b> (@${escapeHtml(user?.username || '')}) just joined Splitwise through their Telegram invite.`)));
        }
        return;
      }

      if (command === '/stop') {
        const { changes } = await db.run('DELETE FROM telegram_links WHERE chat_id = ?', chatId);
        await send(chatId, changes
          ? '🔕 Notifications are off. You can reconnect any time from Splitwise.'
          : 'This chat isn\'t connected to Splitwise.');
        return;
      }

      const linked = await db.get('SELECT 1 AS x FROM telegram_links WHERE chat_id = ?', chatId);
      await send(chatId, linked
        ? 'You\'re connected — updates will arrive here automatically. Tap <b>Open Splitwise</b> below the message box to use the app. Send /stop to turn notifications off.'
        : 'Tap <b>Open Splitwise</b> below the message box and log in once — that connects this chat. '
          + `(Or in <a href="${escapeHtml(appUrl)}">Splitwise</a>: your name → <b>Telegram notifications</b> → <b>Connect</b>.)`);
    },
  };
}
