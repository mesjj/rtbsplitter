// Cloudflare Workers entry point. Static files (public/) are served by Workers Assets;
// only /api/* requests reach this code (see wrangler.jsonc: run_worker_first).

import { d1Store } from './lib/store.js';
import { createApp, ensureAdmin } from './lib/app.js';
import { createTelegram } from './lib/telegram.js';

let app;
let adminChecked = false;

export default {
  async fetch(request, env, ctx) {
    const db = d1Store(env.DB);
    app ??= createApp(db, {
      secureCookies: true,
      telegram: createTelegram({ token: env.TELEGRAM_BOT_TOKEN, db }), // null if the secret isn't set
      loadAsset: async path => {
        const res = await env.ASSETS.fetch(new Request(new URL(path, 'https://assets.local')));
        if (!res.ok) throw new Error(`Missing file ${path}`);
        return new Uint8Array(await res.arrayBuffer());
      },
    });

    // First-time setup: with no active admin and an ADMIN_PASSWORD secret set, create one.
    if (!adminChecked && env.ADMIN_PASSWORD) {
      await ensureAdmin(db, { password: env.ADMIN_PASSWORD });
      adminChecked = true;
    }

    const response = await app(request, {
      clientIp: request.headers.get('CF-Connecting-IP') || 'unknown',
      waitUntil: p => ctx.waitUntil(p), // send notifications after responding
    });
    return response ?? env.ASSETS.fetch(request);
  },
};
