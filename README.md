# Splitwise Lite

A small self-hosted Splitwise clone: shared expenses, flexible splits, automatic "who pays whom".

No runtime dependencies. It needs Node **22.13+** and uses the built-in `node:sqlite`. (`wrangler` is a dev dependency, only needed for Cloudflare.)

## Run it

```sh
npm start                 # http://localhost:3000
```

On first start an `admin` account is created and its password is printed to the console
(or set it yourself with `ADMIN_PASSWORD=... npm start`). Log in, go to **Admin → Add person**
to create everyone's logins, and change your own password from the menu in the top right.

| Env var          | Default              | What it does                                   |
|------------------|----------------------|------------------------------------------------|
| `PORT`           | `3000`               | HTTP port                                      |
| `DB_FILE`        | `data/splitwise.db`  | SQLite database file (back this up)            |
| `ADMIN_PASSWORD` | random               | Password for the bootstrap admin (first run)   |
| `SECURE_COOKIES` | off                  | Set to `1` when serving over HTTPS             |

Forgot the admin password? Stop the server and run
`sqlite3 data/splitwise.db "UPDATE users SET is_admin=0"`. Then start it with
`ADMIN_PASSWORD=newpass npm start`. Whenever no active admin exists, `admin` is recreated (or reset) with that password.

## Deploying to Cloudflare Workers

The same code runs as a Cloudflare Worker, with D1 (Cloudflare's SQLite) as the database. Pages, CSS and JS are served as static assets; only `/api/*` runs the Worker (`worker.js`, config in `wrangler.jsonc`).

| Task | Command |
| --- | --- |
| Log in (once) | `npx wrangler login` |
| Create the database (once) | `npx wrangler d1 create splitwise`, then put the printed `database_id` in `wrangler.jsonc` |
| Create the tables (once; safe to re-run) | `npx wrangler d1 execute splitwise --remote --file lib/schema.sql` |
| Copy data from a SQLite file (e.g. the VPS) | `node deploy/sqlite-to-d1.mjs splitwise.db > data.sql`, then `npx wrangler d1 execute splitwise --remote --file data.sql` |
| First admin on an empty database | `npx wrangler secret put ADMIN_PASSWORD`; `admin` is created on the first request |
| Deploy | `npm test && npx wrangler deploy` |
| Try the Worker locally | `npx wrangler d1 execute splitwise --local --file lib/schema.sql`, then `npx wrangler dev` |
| Logs | `npx wrangler tail` |
| Back up the database | `npx wrangler d1 export splitwise --remote --output backup.sql` (D1 also keeps 30 days of point-in-time restore: `wrangler d1 time-travel`) |

Passwords are hashed with PBKDF2 (Web Crypto). Hashes from the first version (scrypt) still work and are upgraded the first time each person logs in.

## Self-hosting on your own server (Ubuntu 24.04)

The app also runs as a plain Node server. `deploy/setup.sh` prepares a fresh Ubuntu 24.04 machine with:

- **App:** a `splitwise` systemd service that runs as its own user and listens on `127.0.0.1:3000` only.
- **Proxy:** Caddy in front on port 80, plus 443 with automatic HTTPS once a domain is set.
- **Firewall:** `ufw` allows only SSH, HTTP and HTTPS.
- **Database:** `/var/lib/splitwise/splitwise.db`.
- **Backups:** every night at 03:15 to `/var/backups/splitwise/`, kept for 14 days.

| Task | Command |
| --- | --- |
| First-time setup | copy `deploy/setup.sh` to the server and run `bash setup.sh` as root (`DOMAIN=split.example.com bash setup.sh` for HTTPS) |
| Ship code changes (runs tests, copies files, restarts) | `SERVER=root@your-server SSH_KEY=path/to/key deploy/deploy.sh` |
| Logs | `ssh root@your-server journalctl -u splitwise -f` |
| Restore a backup | `systemctl stop splitwise`, copy a backup over the database file, `chown splitwise:splitwise` it, `systemctl start splitwise` |

Keep SSH keys out of the repository; `.ssh/` is git-ignored for that reason.

## Features

- **Logins.** Admins create accounts, and there's no public sign-up. Passwords are hashed with scrypt, sessions last 30 days, and failed logins are rate limited.
- **Admin panel.** Add people, rename them, reset passwords, grant admin, and deactivate or reactivate accounts. A person can only be deleted if they have no history.
- **Expenses.** Each expense has a description, total, date, payer and optional notes, and can be split four ways:
  - *Equally* between whoever you tick
  - *Exact amounts*, which must add up to the total
  - *Percentages*, which must add up to 100%
  - *Shares*, e.g. 2 : 1 : 1
  The form shows each person's share live and tells you how much is left to assign.
- **Balances.** Each group's overview shows your total, who you owe, who owes you, and bars for everyone's balance.
- **Automatic rebalancing.** Debts are simplified into the fewest transfers that settle everyone, like Splitwise's "simplify debts".
- **Settle up.** Record a payment between two people. The suggested amount is pre-filled.
- **Edit or delete** expenses and payments. This is allowed for anyone involved and for admins.
- **Groups.** You can have any number of groups, each with its own mix of members, a currency and separate balances. Groups last until someone deletes them; archiving one makes it read-only. Any member can create a group and manage the groups they're in; admins see and manage all groups. Members only see groups they belong to. People who leave a group but have history there stay on as past members. Any member can delete an empty group. Deleting a group that has expenses removes them too; only its creator or an admin can do that, and they must type the group's name to confirm. Home shows your balance in every group.
- **Currency.** Each group has its own currency, and nothing is converted between groups. Currencies without decimals, such as JPY or KRW, only accept whole amounts.
- **Upgrading.** If a database from before groups is found, all existing expenses and payments move into a "General" group automatically.
- Month-grouped activity feed with an "involving me" filter, dark mode, and a mobile layout.

Money is stored as integer cents. Uneven splits use largest-remainder rounding, so shares always add up
to exactly the total.

## Tests

```sh
npm test
```

## Layout

```
server.js         entry point
lib/money.js      split + debt-simplification math
lib/db.js         schema
lib/auth.js       passwords, sessions
lib/app.js        HTTP API + static files
public/           frontend (vanilla JS, no build step)
old-prototype/    the earlier localStorage-only version
```
