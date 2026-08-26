#!/usr/bin/env sh
set -eu
node bin/astack.mjs upgrade
node bin/astack.mjs init
