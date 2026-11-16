#!/usr/bin/env bash
# Push main; the server's 5-minute poll deploys it (deploy/rkr-autodeploy.timer).
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(git branch --show-current)" = main ] || { echo "switch to main first" >&2; exit 1; }
git push origin main
echo 'Pushed main. Run Kitty Run will deploy on the next server poll (within about 5 minutes).'
