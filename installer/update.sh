#!/usr/bin/env sh
# Update AStack in a project through the update pipeline, from the git repository.
# Usage: sh update.sh [project-dir] [pipeline flags]   (default: current directory)
set -eu
CORE="${ASTACK_CORE:-$HOME/.astack/core}"
SOURCE="${ASTACK_SOURCE:-https://github.com/ARaminco/AStack.git}"
if [ -d "$CORE/.git" ]; then
  git -C "$CORE" fetch --depth 1 --quiet origin main
  git -C "$CORE" checkout --quiet --force --detach FETCH_HEAD
else
  git clone --depth 1 --quiet "$SOURCE" "$CORE"
fi
TARGET="${1:-$PWD}"
[ $# -gt 0 ] && shift
node "$CORE/bin/astack.mjs" update --target "$TARGET" "$@"
