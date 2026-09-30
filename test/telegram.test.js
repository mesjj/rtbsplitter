import test from 'node:test';
import assert from 'node:assert/strict';
import * as db from '../lib/db.js';
import { nodeStore } from '../lib/store.js';
import { createApp, ensureAdmin } from '../lib/app.js';
import { createTelegram, webhookSecret, verifyInitData } from '../lib/telegram.js';
import { createHmac } from 'node:crypto';

const TOKEN = '123456:TEST-TOKEN';

// A fake Telegram Bot API: records every call, lets tests make chats "blocked".
function fakeTelegram() {
  const sent = [];
  const blocked = new Set();
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    if (init.body instanceof FormData) {
      const pic = init.body.get('picture');
      calls.push({ method, photo: JSON.parse(init.body.get('photo')), type: pic.type, bytes: new Uint8Array(await pic.arrayBuffer()) });
      return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    const reply = (status, json) => new Response(JSON.stringify(json), { status });
    if (method === 'getMe') return reply(200, { ok: true, result: { username: 'split_test_bot' } });
    if (method === 'setWebhook') return reply(200, { ok: true, result: true });
    if (method === 'setChatMenuButton') return reply(200, { ok: true, result: true });
    if (method === 'setMyName') return reply(200, { ok: true, result: true });
    if (method === 'getChatMenuButton') return reply(200, { ok: true, result: calls.findLast(c => c.method === 'setChatMenuButton')?.body.menu_button || { type: 'commands' } });
    if (method === 'getWebhookInfo') return reply(200, { ok: true, result: { url: calls.findLast(c => c.method === 'setWebhook')?.body.url || '' } });
    if (method === 'sendMessage') {
      if (blocked.has(String(body.chat_id))) return reply(403, { ok: false, description: 'Forbidden: bot was blocked by the user' });
      sent.push({ chat: String(body.chat_id), text: body.text });
      return reply(200, { ok: true, result: {} });
    }
    return reply(404, { ok: false });
  };
  return { fetchImpl, sent, blocked, calls, take: () => sent.splice(0) };
}

async function setup() {
  const store = nodeStore(db.open(':memory:'));
  await ensureAdmin(store, { password: 'adminpass' });
  const tg = fakeTelegram();
  const loadAsset = async p => new Uint8Array(await (await import('node:fs/promises')).readFile(new URL(`../public${p}`, import.meta.url)));
  const api = createApp(store, { telegram: createTelegram({ token: TOKEN, db: store, fetchImpl: tg.fetchImpl }), loadAsset });
  const pending = [];
  const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

  const request = async (method, path, body, { cookie = '', headers = {} } = {}) => {
    const res = await api(new Request(`https://split.test${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', ...(cookie ? { cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), { clientIp: '1.1.1.1', waitUntil: p => pending.push(p) });
    await settle();
    return { status: res.status, body: await res.json().catch(() => null), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = async (username, password) => {
    const { cookie } = await request('POST', '/api/login', { username, password });
    return (method, path, body) => request(method, path, body, { cookie });
  };
  const webhook = async (chatId, text, secret) => request('POST', '/api/telegram/webhook', {
    update_id: 1, message: { chat: { id: chatId, type: 'private' }, from: { username: `user${chatId}` }, text },
  }, { headers: { 'X-Requested-With': '', 'X-Telegram-Bot-Api-Secret-Token': secret ?? await webhookSecret(TOKEN) } });

  return { request, login, webhook, tg };
}

test('telegram: connect, notify only involved people, before/after details, unlink', async () => {
  const { login, webhook, tg } = await setup();
  const admin = await login('admin', 'adminpass');
  const mk = async (u, n) => (await admin('POST', '/api/admin/users', { username: u, name: n, password: 'secret1' })).body.id;
  const ann = await mk('ann', 'Ann'), ben = await mk('ben', 'Ben'), cat = await mk('cat', 'Cat'), dan = await mk('dan', 'Dan');
  const A = await login('ann', 'secret1'), B = await login('ben', 'secret1'), D = await login('dan', 'secret1');

  // Not connected yet
  assert.deepEqual((await A('GET', '/api/me/telegram')).body, { available: true, connected: false, tgName: '', linkedAt: null });

  // Ann connects: the link carries a one-time code; the bot's /start links her chat.
  const url = (await A('POST', '/api/me/telegram/link')).body.url;
  const code = url.match(/^https:\/\/t\.me\/split_test_bot\?start=([0-9a-f]{32})$/)[1];
  assert.equal((await webhook(111, `/start ${code}`, 'wrong-secret')).status, 401); // forged calls are rejected
  assert.equal((await webhook(111, `/start ${code}`)).status, 200);
  assert.match(tg.take()[0].text, /Connected to RTBSplitter as <b>Ann<\/b>/);
  assert.equal((await A('GET', '/api/me/telegram')).body.tgName, '@user111');
  // The code can't be reused.
  await webhook(999, `/start ${code}`);
  assert.match(tg.take()[0].text, /expired or was already used/);

  // Ben and Dan connect too. Cat doesn't.
  for (const [client, chat] of [[B, 222], [D, 444]]) {
    const c = (await client('POST', '/api/me/telegram/link')).body.url.split('start=')[1];
    await webhook(chat, `/start ${c}`);
  }
  tg.take();

  const g = (await A('POST', '/api/groups', { name: 'Trip <3', currency: 'EUR', memberIds: [ann, ben, cat, dan] })).body.id;

  // Ann adds dinner for Ann/Ben/Cat. Ben (linked) is told; Ann (the actor), Cat (not linked)
  // and Dan (not involved) are not.
  const dinner = (await A('POST', '/api/expenses', {
    groupId: g, description: 'Dinner & drinks', amount: '90', paidBy: ann, splitType: 'equal',
    split: [ann, ben, cat].map(userId => ({ userId })),
  })).body.id;
  let msgs = tg.take();
  assert.deepEqual(msgs.map(m => m.chat), ['222']);
  assert.match(msgs[0].text, /<b>Ann<\/b> added <b>Dinner &amp; drinks<\/b> in <i>Trip &lt;3<\/i>/); // HTML escaped
  assert.match(msgs[0].text, /Ann paid €90\.00 · split equally/);
  assert.match(msgs[0].text, /Your share: <b>€30\.00<\/b>/);
  assert.match(msgs[0].text, /you owe <b>€30\.00<\/b>/);
  assert.match(msgs[0].text, /href="https:\/\/split\.test\/#\/groups\/\d+\/expenses"/);

  // Ben edits it: amount up, Dan added, Cat removed. Ann and Dan hear about it, each personally.
  await B('PUT', `/api/expenses/${dinner}`, {
    description: 'Dinner & drinks', amount: '120', paidBy: ann, splitType: 'equal',
    split: [ann, ben, dan].map(userId => ({ userId })),
  });
  msgs = tg.take();
  const toAnn = msgs.find(m => m.chat === '111').text;
  const toDan = msgs.find(m => m.chat === '444').text;
  assert.equal(msgs.length, 2);
  assert.match(toAnn, /<b>Ben<\/b> edited/);
  assert.match(toAnn, /Amount: €90\.00 → €120\.00/);
  assert.match(toAnn, /Your share: €30\.00 → <b>€40\.00<\/b>/);
  assert.match(toAnn, /you're owed <b>€80\.00<\/b>/);
  assert.match(toDan, /You were added to it — your share is <b>€40\.00<\/b>/);

  // Payment: Ben pays Ann back. Ann is told (Ben recorded it himself).
  const pay = (await B('POST', '/api/payments', { groupId: g, fromUser: ben, toUser: ann, amount: 40 })).body.id;
  msgs = tg.take();
  assert.deepEqual(msgs.map(m => m.chat), ['111']);
  assert.match(msgs[0].text, /Ben paid you <b>€40\.00<\/b>/);

  // Deleting the payment tells Ben (Ann deleted it).
  await A('DELETE', `/api/payments/${pay}`);
  msgs = tg.take();
  assert.deepEqual(msgs.map(m => m.chat), ['222']);
  assert.match(msgs[0].text, /deleted a payment/);
  assert.match(msgs[0].text, /You paid Ann <b>€40\.00<\/b>/);

  // Ben blocks the bot: the next message fails and his link is removed.
  tg.blocked.add('222');
  await A('DELETE', `/api/expenses/${dinner}`);
  msgs = tg.take();
  assert.deepEqual(msgs.map(m => m.chat), ['444']);
  assert.match(msgs[0].text, /deleted <b>Dinner &amp; drinks<\/b> \(€120\.00\)/);
  assert.match(msgs[0].text, /Your share was €40\.00/);
  assert.equal((await B('GET', '/api/me/telegram')).body.connected, false);

  // Deleting a group with history tells everyone who was involved in it.
  await A('POST', '/api/expenses', { groupId: g, description: 'Taxi', amount: 10, paidBy: dan, splitType: 'equal', split: [{ userId: dan }, { userId: ann }] });
  tg.take();
  await A('DELETE', `/api/groups/${g}`);
  msgs = tg.take();
  assert.deepEqual(msgs.map(m => m.chat), ['444']);
  assert.match(msgs[0].text, /deleted the group <i>Trip &lt;3<\/i>, including its 1 expense and 0 payments/);

  // /stop and "Disconnect" both switch it off.
  await webhook(444, '/stop');
  assert.match(tg.take()[0].text, /Notifications are off/);
  assert.equal((await D('GET', '/api/me/telegram')).body.connected, false);
  await A('DELETE', '/api/me/telegram');
  assert.equal((await A('GET', '/api/me/telegram')).body.connected, false);
});

test('telegram: admin webhook setup and status; off when no token', async () => {
  const { login, tg } = await setup();
  const admin = await login('admin', 'adminpass');
  assert.equal((await admin('GET', '/api/admin/telegram')).body.webhookOk, false);
  assert.equal((await admin('POST', '/api/admin/telegram/webhook')).status, 200);
  const set = tg.calls.find(c => c.method === 'setWebhook').body;
  assert.equal(set.url, 'https://split.test/api/telegram/webhook');
  assert.equal(set.secret_token, await webhookSecret(TOKEN));
  const status = (await admin('GET', '/api/admin/telegram')).body;
  assert.equal(status.bot, 'split_test_bot');
  assert.equal(status.webhookOk, true);
  assert.equal(status.menuButtonOk, true);
  assert.deepEqual(tg.calls.find(c => c.method === 'setChatMenuButton').body.menu_button,
    { type: 'web_app', text: 'Open RTBSplitter', web_app: { url: 'https://split.test' } });
  assert.deepEqual(tg.calls.find(c => c.method === 'setMyName').body, { name: 'RTBSplitter' });

  // Bot picture: the app icon, uploaded as a JPG file.
  assert.equal((await admin('POST', '/api/admin/telegram/photo')).status, 200);
  const photo = tg.calls.find(c => c.method === 'setMyProfilePhoto');
  assert.deepEqual(photo.photo, { type: 'static', photo: 'attach://picture' });
  assert.equal(photo.type, 'image/jpeg');
  assert.deepEqual([...photo.bytes.slice(0, 3)], [0xff, 0xd8, 0xff]); // JPEG signature

  // Without a token everything is quietly off.
  const plain = createApp(nodeStore(db.open(':memory:')));
  const res = await plain(new Request('https://x/api/telegram/webhook', { method: 'POST', body: '{}' }));
  assert.equal(res.status, 503);
});

// Sign Mini App data the way Telegram does (independently of the code under test).
function signInitData(fields, token = TOKEN) {
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}
const tgUserData = (id, extra = {}) => ({
  auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAH', signature: 'sig',
  user: JSON.stringify({ id, first_name: 'Ann', username: `u${id}` }), ...extra,
});

test('mini app: signed Telegram data logs linked people straight in; others link by logging in once', async () => {
  const { request, login } = await setup();
  const admin = await login('admin', 'adminpass');
  await admin('POST', '/api/admin/users', { username: 'ann', name: 'Ann', password: 'secret1' });
  const initData = signInitData(tgUserData(555));

  // Signature checks: genuine, tampered, wrong bot, too old.
  assert.equal((await verifyInitData(TOKEN, initData)).id, 555);
  assert.equal(await verifyInitData(TOKEN, initData.replace('u555', 'u556')), null);
  assert.equal(await verifyInitData(TOKEN, signInitData(tgUserData(555), '999:OTHER')), null);
  assert.equal(await verifyInitData(TOKEN, signInitData(tgUserData(555, { auth_date: String(Math.floor(Date.now() / 1000) - 2 * 86400) }))), null);
  assert.equal((await request('POST', '/api/telegram/webapp-login', { initData: initData + 'x' })).status, 401);

  // Not linked yet → the app shows the password form.
  assert.deepEqual((await request('POST', '/api/telegram/webapp-login', { initData })).body, { linked: false });

  // Password login inside Telegram asks for a token (cookies may be blocked there)...
  const res = await request('POST', '/api/login', { username: 'ann', password: 'secret1', wantToken: true });
  assert.match(res.body.token, /^[A-Za-z0-9_-]{40,}$/);
  const bearer = { headers: { Authorization: `Bearer ${res.body.token}` } };
  assert.equal((await request('GET', '/api/me', undefined, bearer)).body.username, 'ann');
  // ...and links this Telegram account.
  assert.equal((await request('POST', '/api/me/telegram/webapp-link', { initData }, bearer)).body.tgName, '@u555');
  // Normal logins still don't expose the token.
  assert.equal((await request('POST', '/api/login', { username: 'ann', password: 'secret1' })).body.token, undefined);

  // Next time: straight in, no password.
  const auto = (await request('POST', '/api/telegram/webapp-login', { initData })).body;
  assert.equal(auto.linked, true);
  assert.equal((await request('GET', '/api/me', undefined, { headers: { Authorization: `Bearer ${auto.token}` } })).body.username, 'ann');

  // Deactivated people can't get in this way either.
  const annId = (await admin('GET', '/api/admin/users')).body.find(u => u.username === 'ann').id;
  await admin('PATCH', `/api/admin/users/${annId}`, { active: false });
  assert.deepEqual((await request('POST', '/api/telegram/webapp-login', { initData })).body, { linked: false });
});

test('telegram: amounts use the group currency sign (THB → ฿)', async () => {
  const { login, webhook, tg } = await setup();
  const admin = await login('admin', 'adminpass');
  const ann = (await admin('POST', '/api/admin/users', { username: 'ann', name: 'Ann', password: 'secret1' })).body.id;
  const A = await login('ann', 'secret1');
  const code = (await A('POST', '/api/me/telegram/link')).body.url.split('start=')[1];
  await webhook(111, `/start ${code}`);
  tg.take();
  const g = (await admin('POST', '/api/groups', { name: 'Bangkok', currency: 'THB', memberIds: [1, ann] })).body.id;
  await admin('POST', '/api/expenses', { groupId: g, description: 'Rot niyom', amount: '471.75', paidBy: 1, splitType: 'equal', split: [{ userId: 1 }, { userId: ann }] });
  const text = tg.take()[0].text;
  assert.match(text, /paid ฿471\.75/);
  assert.match(text, /Your share: <b>฿235\.87<\/b>|Your share: <b>฿235\.88<\/b>/);
  assert.doesNotMatch(text, /\$|THB/);
});

test('telegram invite: a new person activates from Telegram alone, no website or password', async () => {
  const { request, login, webhook, tg } = await setup();
  const admin = await login('admin', 'adminpass');

  // Added without a password → Telegram only.
  const zoe = (await admin('POST', '/api/admin/users', { username: 'zoe', name: 'Zoe' })).body.id;
  let row = (await admin('GET', '/api/admin/users')).body.find(u => u.id === zoe);
  assert.equal(row.hasPassword, false);
  assert.equal(row.hasTelegram, false);
  assert.equal((await request('POST', '/api/login', { username: 'zoe', password: '!' })).status, 401);
  assert.equal((await request('POST', '/api/login', { username: 'zoe', password: '' })).status, 401);

  // The admin makes an invite link; a newer one cancels the older one.
  const old = (await admin('POST', `/api/admin/users/${zoe}/telegram-invite`)).body;
  const invite = (await admin('POST', `/api/admin/users/${zoe}/telegram-invite`)).body;
  assert.match(invite.url, /^https:\/\/t\.me\/split_test_bot\?start=[0-9a-f]{32}$/);
  assert.ok(invite.expiresAt - Date.now() > 6.9 * 86400_000);
  await webhook(901, `/start ${old.url.split('start=')[1]}`);
  assert.match(tg.take()[0].text, /expired or was already used/);

  // The admin is on Telegram too (connected the normal way — which doesn't alert anyone).
  const adminCode = (await admin('POST', '/api/me/telegram/link')).body.url.split('start=')[1];
  await webhook(700, `/start ${adminCode}`);
  assert.deepEqual(tg.take().map(m => m.chat), ['700']);

  // Zoe taps Start in Telegram → connected, and the admin is told.
  await webhook(901, `/start ${invite.url.split('start=')[1]}`);
  const sent = tg.take();
  assert.match(sent.find(m => m.chat === '901').text, /Connected to RTBSplitter as <b>Zoe<\/b>/);
  assert.match(sent.find(m => m.chat === '700').text, /✅ <b>Zoe<\/b> \(@zoe\) just joined RTBSplitter through their Telegram invite/);
  assert.equal(sent.length, 2);
  row = (await admin('GET', '/api/admin/users')).body.find(u => u.id === zoe);
  assert.equal(row.hasTelegram, true);

  // ...and the Mini App signs her straight in.
  const initData = signInitData(tgUserData(901));
  const auto = (await request('POST', '/api/telegram/webapp-login', { initData })).body;
  assert.equal(auto.linked, true);
  assert.equal((await request('GET', '/api/me', undefined, { headers: { Authorization: `Bearer ${auto.token}` } })).body.username, 'zoe');

  // Only admins can make invites; deactivated people can't get one.
  const Z = (method, path, body) => request(method, path, body, { headers: { Authorization: `Bearer ${auto.token}` } });
  assert.equal((await Z('POST', `/api/admin/users/${zoe}/telegram-invite`)).status, 403);
  await admin('PATCH', `/api/admin/users/${zoe}`, { active: false });
  assert.equal((await admin('POST', `/api/admin/users/${zoe}/telegram-invite`)).status, 400);
});
