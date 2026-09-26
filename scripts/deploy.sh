#!/usr/bin/env bash
# Pulls the latest code, rebuilds, and restarts both services with PM2.
# Run on the server from anywhere:  ~/mf-chat/scripts/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> Pulling latest code"
git pull --ff-only

echo "==> Installing dependencies"
npm ci --include=dev

echo "==> Building"
npm run build

echo "==> Restarting services"
pm2 startOrReload ecosystem.config.cjs
pm2 save

echo "==> Health check"
sleep 3
curl -fsS http://127.0.0.1:3000/health && echo
