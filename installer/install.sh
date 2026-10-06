#!/usr/bin/env sh
# Install or update AStack in a project and set everything up for Claude Code
# and Codex. Usage: sh install.sh [project-dir]   (default: current directory)
set -eu
CORE="${ASTACK_CORE:-$HOME/.astack/core}"
if [ -d "$CORE/.git" ]; then
  git -C "$CORE" pull --ff-only --quiet
else
  git clone --depth 1 --quiet "${ASTACK_SOURCE:-https://github.com/ARaminco/AStack.git}" "$CORE"
fi
node "$CORE/bin/astack.mjs" setup --target "${1:-$PWD}"
