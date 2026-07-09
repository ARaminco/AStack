#!/usr/bin/env sh
set -eu
node scripts/bootstrap-enterprise.mjs
node bin/astack.mjs doctor
