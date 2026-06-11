#!/usr/bin/env bash
set -euo pipefail

# Full end-to-end smoke (CI + local with Docker): boot the real container
# stack with docker compose, run the smoke scenario against it, then grep
# every container log line for leaked token patterns (spec 12).
#
#   ./scripts/e2e-smoke.sh

cd "$(dirname "$0")/.."

cleanup() {
  docker compose logs app > /tmp/ai-pnl-app.log 2>&1 || true
  docker compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker compose up --build -d

BASE_URL="http://localhost:3000" node scripts/smoke-scenario.mjs | tee /tmp/ai-pnl-canaries.json

docker compose logs app > /tmp/ai-pnl-app.log 2>&1
docker compose logs db > /tmp/ai-pnl-db.log 2>&1
node scripts/check-log-leaks.mjs --canaries /tmp/ai-pnl-canaries.json \
  /tmp/ai-pnl-app.log /tmp/ai-pnl-db.log

echo "e2e smoke passed"
