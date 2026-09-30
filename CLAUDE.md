# CLAUDE.md

Guidance for Claude Code sessions in this repository. Humans: see [README.md](README.md).

RTBSplitter is a self-hosted bill-splitting web app (groups, four split types, simplified debts, settle up) with Telegram notifications and a Telegram Mini App. One codebase runs on **Cloudflare Workers + D1** (the normal deployment) and on **Node 22.13+** with the built-in `node:sqlite` (local use, tests, self-hosting). No runtime dependencies and no build step; `wrangler` is the only dev dependency.

## Helping someone install it

If the user asks to set up, install or deploy the app, follow this playbook. The README's "Set it up" section has the same steps for humans.

### 1. Decide the route

Ask one question if it isn't clear already: **Cloudflare** (recommended; free, automatic HTTPS, needed for Telegram), **just on this computer** (to try it out), or **their own Ubuntu server**. Default to Cloudflare. Check `node -v` is 22.13 or newer, and help them install Node if it isn't.

### 2. Steps the person must do themselves

Never ask for passwords or tokens in chat, and never put them in files, commits or command lines. Tell the person exactly what to run and wait for them to say it's done.

| Step | Why they must do it | What to tell them |
| --- | --- | --- |
| `npx wrangler login` | Opens a browser to authorise their Cloudflare account | Run it; click **Allow** |
| First `npx wrangler deploy` on a new Cloudflare account | Prompts them to choose a workers.dev subdomain | Run it in their own terminal if the deploy asks for a subdomain |
| `npx wrangler secret put ADMIN_PASSWORD` | Prompts for a secret value | **Run it in their own terminal window**, not via `!` in Claude Code |
| Creating the Telegram bot | Only possible in Telegram, with @BotFather `/newbot` | Keep the token private |
| `npx wrangler secret put TELEGRAM_BOT_TOKEN` | Prompts for a secret value | Own terminal, or dashboard → Variables and Secrets → **Type: Secret** (not Text) |

⚠️ **Commands run with `!` in Claude Code, and your own Bash tool, cannot answer prompts.** `wrangler secret put` then silently stores an **empty** secret. Always have the person run secret commands in a real terminal. Never pass the token as an argument, because `wrangler secret put <token>` creates a secret *named* after the token.

### 3. Steps you do (Cloudflare route)

Run these from the repository root:

1. `npm install`
2. After they've logged in, run `npx wrangler whoami` to confirm the account.
3. `npx wrangler d1 create rtbsplitter`, and note the printed `database_id`.
4. Edit `wrangler.jsonc`: set `name` (the Worker name, which becomes the URL `https://<name>.<subdomain>.workers.dev`), `d1_databases[0].database_name` and `d1_databases[0].database_id`. **The values committed in the repo belong to the maintainer's copy.** Always replace them for anyone else, or their deploy will fail or target the wrong database. Keep `"keep_vars": true`.
5. `npx wrangler d1 execute <database_name> --remote --file lib/schema.sql`
6. `npm test`, then `npx wrangler deploy`. Note the printed URL.
7. Have them run `npx wrangler secret put ADMIN_PASSWORD` in their own terminal. The Worker creates `admin` with that password on the next request, and only when no active admin exists.
8. **Verify:**
   - `curl -s -o /dev/null -w '%{http_code}' <url>/` returns `200`.
   - `curl -s <url>/api/state` returns `{"error":"Please log in."}`.
   - A brand-new workers.dev URL can fail with a TLS **handshake failure** for 1–5 minutes while its certificate is issued. Poll; don't debug.
9. Tell them to log in as `admin`, change the password (menu under their name), and add people under **Admin**.

**Telegram (optional):**
1. After they've stored `TELEGRAM_BOT_TOKEN` as a secret, have them open **Admin → Telegram notifications → Connect bot to this site** in the app. That sets the webhook, the "Open RTBSplitter" menu button and the bot's name.
2. Check it: as an admin, `GET /api/admin/telegram` should report `webhookOk: true` and `menuButtonOk: true`.
3. **Set bot picture to the app icon** uploads `public/telegram-bot-photo.jpg`.
4. People connect from the menu under their name, or an admin sends them an invite link from the Admin page.

**Local route:** `npm start` serves http://localhost:3000. It prints a generated admin password on first start, or use `ADMIN_PASSWORD=… npm start`. Data goes in `data/rtbsplitter.db` (git-ignored).

**Ubuntu route:**
1. Copy `deploy/setup.sh` to a fresh Ubuntu 24.04 server and run it as root (`DOMAIN=… bash setup.sh` for HTTPS).
2. Then run `SERVER=root@host SSH_KEY=path deploy/deploy.sh` locally.
3. The admin password appears in `journalctl -u rtbsplitter`, unless `ADMIN_PASSWORD` was set.

## Working on the code

- `npm test`: node:test suites for the money maths, the HTTP API and the Telegram flows. They call the same `lib/app.js` handler the Worker uses. Run them before every deploy.
- `npm start` / `npm run dev`: the Node server on port 3000.
- `npx wrangler dev`: the real Workers runtime locally. Run `npx wrangler d1 execute <db> --local --file lib/schema.sql` first.
- Deploy with `npm test && npx wrangler deploy`.

### Architecture

| File | Role |
| --- | --- |
| `worker.js` | Workers entry. Only `/api/*` runs the Worker (`run_worker_first`); `public/` is served as static assets with SPA fallback. |
| `server.js`, `lib/node-http.js` | Node entry: bridges `node:http` to the fetch-style API and serves `public/`. |
| `lib/app.js` | `createApp(db, { telegram, loadAsset, secureCookies })` returns `(Request, { clientIp, waitUntil }) → Response`. All routes, validation and permissions live here. |
| `lib/store.js` | `get / all / run / batch` over D1 or `node:sqlite`. **D1 has no BEGIN/COMMIT**; anything that must be atomic goes in one `db.batch([...])`. Inside a batch, a new row's id is `(SELECT MAX(id) FROM table)`. |
| `lib/schema.sql` | Idempotent schema (`CREATE … IF NOT EXISTS`), used for D1 and local files. |
| `lib/db.js` | Node only: opens SQLite files and runs legacy upgrades. |
| `lib/money.js` | Pure maths, all **integer cents**, largest-remainder rounding, zero-decimal currencies (JPY etc.) in whole units, `simplifyDebts`. |
| `lib/auth.js` | PBKDF2-SHA256 (100k iterations, the Workers maximum) via Web Crypto. Legacy `scrypt$` hashes are verified and upgraded on login. Sessions store only a SHA-256 of the token. Login rate limiting is kept in the database, since Workers have no shared memory. |
| `lib/telegram.js` | Bot API calls, webhook secret (HMAC of the token), Mini App `initData` verification, `/start <code>` linking, invites. |
| `lib/notify.js` | Before/after snapshots and per-recipient message text. Never notify the actor. Messages are sent after the response through `waitUntil`. |
| `public/app.js` | Hash-routed single-page app in plain JS. Build DOM with `h()`; **user text is always inserted as text, never as HTML**. |

### Conventions and gotchas

- **Money is integer cents everywhere.** Format with the group's currency and `currencyDisplay: 'narrowSymbol'`. Never convert between currencies.
- **Schema changes:**
  - New tables and indexes go in `lib/schema.sql`.
  - `CREATE TABLE IF NOT EXISTS` never adds columns to an existing table. For a new column, also add an `ALTER TABLE` in `lib/db.js` (local files), and run it once on D1: `npx wrangler d1 execute <db> --remote --command "ALTER TABLE …"`.
  - Back up first with `npx wrangler d1 export <db> --remote --output backup.sql`.
- **Secrets never go in `wrangler.jsonc`.** `keep_vars: true` stops deploys from deleting dashboard variables, but secrets must be of the *Secret* type.
- **CSRF:** every non-GET API call needs the header `X-Requested-With: fetch`. The Telegram webhook is the one exception; it's verified by its secret header.
- **Inside Telegram** the app authenticates with `Authorization: Bearer <session token>`, because cookies can be blocked in Telegram's frames. `public/_headers` allows only `https://web.telegram.org` to frame the site.
- **Don't use `confirm()` or `prompt()`** in the frontend; they're unreliable inside Telegram. Use `ask()`.
- Phone inputs must be at least 16px, or iOS zooms in when they're tapped.

## Privacy

This repository is public.
- **Never commit** real data: `data/`, `*.db`, root-level `*.sql` exports, `.ssh/` and `.env*` are git-ignored; keep it that way.
- **No personal details** (names, emails, IPs, tokens) in code, docs, tests or screenshots. Tests and `docs/` screenshots use made-up people.
- **The maintainer commits under a neutral identity** (`RTBSplitter <noreply@rtbsplitter.invalid>`, UTC timestamps). Don't change the local git identity.
