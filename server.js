// Node entry point: `npm start`. Serves public/ and the API from one port.
// (On Cloudflare, worker.js plays this role and public/ is served by Workers Assets.)

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open } from './lib/db.js';
import { nodeStore } from './lib/store.js';
import { createApp, ensureAdmin } from './lib/app.js';
import { nodeHandler } from './lib/node-http.js';
import { createTelegram } from './lib/telegram.js';
import fs from 'node:fs/promises';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || undefined; // e.g. 127.0.0.1 behind a reverse proxy; default = all interfaces
const DB_FILE = process.env.DB_FILE || path.join(ROOT, 'data', 'splitwise.db');

const db = nodeStore(open(DB_FILE));
const created = await ensureAdmin(db, { password: process.env.ADMIN_PASSWORD });
if (created) {
  console.log('\n  No admin account existed, so one was created:');
  console.log(`    username: ${created.username}`);
  console.log(`    password: ${created.password}`);
  console.log('  Log in and change it under your profile.\n');
}

const api = createApp(db, {
  secureCookies: process.env.SECURE_COOKIES === '1',
  telegram: createTelegram({ token: process.env.TELEGRAM_BOT_TOKEN, db }), // optional
  loadAsset: async p => new Uint8Array(await fs.readFile(path.join(ROOT, 'public', path.normalize(p).replace(/^(\.\.[/\\])+/, '')))),
});
http.createServer(nodeHandler(api, { publicDir: path.join(ROOT, 'public'), trustProxy: process.env.TRUST_PROXY === '1' }))
  .listen(PORT, HOST, () => console.log(`Splitwise running at http://${HOST || 'localhost'}:${PORT}`));
