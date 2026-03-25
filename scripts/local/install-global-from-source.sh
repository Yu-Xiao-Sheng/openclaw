#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

cd "$ROOT_DIR"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required" >&2
  exit 1
fi

pnpm install --frozen-lockfile
pnpm build
npm install -g .

if command -v openclaw >/dev/null 2>&1 && command -v systemctl >/dev/null 2>&1; then
  if systemctl --user show-environment >/dev/null 2>&1; then
    openclaw gateway install --force --runtime node
  else
    echo "Skipping gateway service reinstall because systemd user services are unavailable in this shell." >&2
  fi
fi
