#!/usr/bin/env bash
# Copy the app to a self-hosted server (set up with deploy/setup.sh) and restart it.
# Run from the project folder on your machine:
#   SERVER=root@your-server SSH_KEY=~/.ssh/id_ed25519 deploy/deploy.sh
# The database on the server is never touched.
set -euo pipefail

SERVER="${SERVER:?Set SERVER, e.g. SERVER=root@your-server}"
SSH_KEY="${SSH_KEY:?Set SSH_KEY to the private key for that server}"
SSH="ssh -i $SSH_KEY -o IdentitiesOnly=yes"

cd "$(dirname "$0")/.."

echo "==> Running tests"
npm test --silent >/dev/null

echo "==> Copying app to $SERVER"
rsync -az --delete -e "$SSH" \
  --include='/server.js' --include='/package.json' \
  --include='/lib/***' --include='/public/***' \
  --exclude='*' \
  ./ "$SERVER:/opt/rtbsplitter/"

echo "==> Restarting"
$SSH "$SERVER" 'systemctl restart rtbsplitter && sleep 1 && systemctl is-active rtbsplitter && curl -fsS -o /dev/null -w "local check: HTTP %{http_code}\n" http://127.0.0.1:3000/'
