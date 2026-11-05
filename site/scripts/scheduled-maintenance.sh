#!/usr/bin/env bash
set -euo pipefail

: "${ALLOCATION_DATA_DIR:?ALLOCATION_DATA_DIR is required}"
: "${ALLOCATION_BACKUP_DIR:?ALLOCATION_BACKUP_DIR is required}"
: "${ALLOCATION_LEDGER_SYNC_CONFIG:?ALLOCATION_LEDGER_SYNC_CONFIG is required}"

site_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$site_root"
umask 077

node scripts/allocation-backup.mjs create
node scripts/ledger-sync.mjs --config "$ALLOCATION_LEDGER_SYNC_CONFIG"
