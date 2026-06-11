#!/bin/sh
set -e

# Migrations run on every boot; the container never starts on a stale schema.
node scripts/migrate.mjs

exec node server.js
