# Run Kitty Run

- Pushing to `main` auto-deploys to the live server (runkittyrun.fun): the box polls GitHub every 5 min (`deploy/rkr-autodeploy.timer` -> `deploy/deploy.sh`); `scripts/deploy.sh` deploys right away
  (health check on `/healthz`, automatic rollback). `deploy/Caddyfile` and the systemd unit are NOT auto-applied.
- Run `npm test` (~15s) before pushing to main; CI runs the same plus `node --check`.
- Don't write new test scripts or bots unless asked: add a couple of checks to `scripts/sim-test.mjs` instead.
- `scripts/server-test.mjs` (starts its own local server) and `scripts/finale-test.mjs` (final-run tuning) are manual tools.
- Never run tests or bots against the live server.
- Native iOS/Android apps wrap `public/` (Capacitor, see docs/MOBILE.md); keep the protocol backward compatible.
