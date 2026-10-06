#!/usr/bin/env sh
# Install AStack into a project (or bring an old one up to date) and set
# everything up for Claude Code and Codex.
# Usage: sh install.sh [project-dir]   (default: current directory)
set -eu
CORE="${ASTACK_CORE:-$HOME/.astack/core}"
SOURCE="${ASTACK_SOURCE:-https://github.com/ARaminco/AStack.git}"
if [ -d "$CORE/.git" ]; then
  git -C "$CORE" fetch --depth 1 --quiet origin main
  git -C "$CORE" checkout --quiet --force --detach FETCH_HEAD
else
  git clone --depth 1 --quiet "$SOURCE" "$CORE"
fi
node "$CORE/bin/astack.mjs" setup --target "${1:-$PWD}"
