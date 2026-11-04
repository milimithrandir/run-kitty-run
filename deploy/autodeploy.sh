#!/usr/bin/env bash
# Runs on the server as user rkr every 5 minutes (deploy/rkr-autodeploy.timer): if origin/main has moved,
# runs deploy/deploy.sh (pull, install, restart, health check with rollback). Replaces the GitHub Action.
set -euo pipefail
cd /opt/run-kitty-run/app
git fetch --quiet origin main
HEAD=$(git rev-parse HEAD); NEW=$(git rev-parse origin/main)
[ "$HEAD" = "$NEW" ] && exit 0
echo "main moved ${HEAD:0:7} -> ${NEW:0:7}: deploying"
exec deploy/deploy.sh
