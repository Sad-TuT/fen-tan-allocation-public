#!/usr/bin/env bash
set -euo pipefail

: "${ALLOCATION_DATA_DIR:?ALLOCATION_DATA_DIR is required}"
: "${ALLOCATION_BACKUP_DIR:?ALLOCATION_BACKUP_DIR is required}"

site_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$site_root"
umask 077

node scripts/allocation-backup.mjs create
