#!/usr/bin/env bash
# One-time server setup for Ubuntu 24.04. Run as root on the server:
#   DOMAIN=split.example.com bash setup.sh     (HTTPS via Let's Encrypt)
#   bash setup.sh                               (plain HTTP on the server's IP)
# Safe to re-run: it only (re)writes config and restarts services.
set -euo pipefail

DOMAIN="${DOMAIN:-}"
APP_DIR=/opt/splitwise
DATA_DIR=/var/lib/splitwise
BACKUP_DIR=/var/backups/splitwise

export DEBIAN_FRONTEND=noninteractive

echo "==> Packages"
apt-get update -qq
apt-get install -y -qq curl gnupg debian-keyring debian-archive-keyring apt-transport-https rsync sqlite3 ufw >/dev/null

if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi

if ! command -v caddy >/dev/null; then
  echo "==> Caddy"
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy >/dev/null
fi

echo "==> App user and folders"
id splitwise >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin splitwise
mkdir -p "$APP_DIR" "$DATA_DIR" "$BACKUP_DIR"
chown splitwise:splitwise "$DATA_DIR"
chmod 700 "$DATA_DIR" "$BACKUP_DIR"

echo "==> systemd service"
SECURE=0; [ -n "$DOMAIN" ] && SECURE=1
cat > /etc/systemd/system/splitwise.service <<EOF
[Unit]
Description=Splitwise Lite
After=network.target

[Service]
User=splitwise
Group=splitwise
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $APP_DIR/server.js
Environment=NODE_ENV=production
Environment=HOST=127.0.0.1
Environment=PORT=3000
Environment=DB_FILE=$DATA_DIR/splitwise.db
Environment=TRUST_PROXY=1
Environment=SECURE_COOKIES=$SECURE
Restart=always
RestartSec=2
# Hardening: read-only system, writable data folder only.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable splitwise >/dev/null 2>&1

echo "==> Caddy (reverse proxy${DOMAIN:+ + HTTPS for $DOMAIN})"
SITE="${DOMAIN:-:80}"
cat > /etc/caddy/Caddyfile <<EOF
$SITE {
	encode gzip
	reverse_proxy 127.0.0.1:3000
	header {
		X-Content-Type-Options nosniff
		Referrer-Policy same-origin
		X-Frame-Options DENY
		-Server
	}
}
EOF
systemctl enable caddy >/dev/null 2>&1
systemctl reload-or-restart caddy

echo "==> Firewall"
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "==> Nightly backups (03:15, keep 14 days)"
cat > /etc/cron.d/splitwise-backup <<EOF
15 3 * * * root sqlite3 $DATA_DIR/splitwise.db ".backup $BACKUP_DIR/splitwise-\$(date +\%F).db" && find $BACKUP_DIR -name 'splitwise-*.db' -mtime +14 -delete
EOF

echo "==> Done. Node $(node -v), $(caddy version | cut -d' ' -f1)"
