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

if git -C "$ROOT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if [ -z "$(git -C "$ROOT_DIR" status --porcelain -- 2>/dev/null)" ]; then
    current_branch="$(git -C "$ROOT_DIR" branch --show-current 2>/dev/null || true)"
    if [ "$current_branch" = "main" ] && git -C "$ROOT_DIR" remote get-url upstream >/dev/null 2>&1; then
      git -C "$ROOT_DIR" fetch upstream --prune --tags
      if git -C "$ROOT_DIR" rev-parse --verify upstream/main >/dev/null 2>&1; then
        git -C "$ROOT_DIR" rebase upstream/main
      fi
    fi
  else
    echo "Skipping upstream sync because the checkout has local changes." >&2
  fi
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
