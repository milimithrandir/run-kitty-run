# Run Kitty Run

3D square-spiral kitty runner (three.js): one long corridor of straight legs winding in to the goal room, with solo, local co-op and **online lobbies (up to 32 players)**.

Live: https://runkittyrun.fun (domain on Cloudflare, DNS only → the UpCloud box; Caddy gets the cert). Hosting moved to the maximilianlight UpCloud account on 15 October 2026 (Apps server `80.47.237.0`). The public domain stays the same.

The old free names (https://runkittyrun.80-47-225-25.nip.io, https://80-47-225-25.nip.io and the .sslip.io mirrors) redirect pages there but still serve /ws and /api for app builds.

## Run locally

```bash
npm install
npm start          # http://localhost:8080
```

## Mobile apps (iOS & Android)

The same game ships as native iOS and Android apps (Capacitor wraps `public/`) that play on this server, cross-play with
the web. `.github/workflows/mobile.yml` builds both on every push; store uploads (TestFlight / Google Play) are one click
via "Run workflow". Setup, secrets, release flow and review notes: **[docs/MOBILE.md](docs/MOBILE.md)**.

```bash
npm run android:build                  # debug APK
npm run ios:sync && npm run ios:open   # Xcode
node scripts/bump-version.mjs patch    # bump app version everywhere
```

## Patch notes

Player-facing notes live in `public/js/patchnotes.js` (newest first) and show on the title screen on desktop.
Add a line there whenever you ship something players will notice.

## Search engines

The game page itself is a canvas, so the words search engines read live elsewhere:

- `public/index.html`: the title, description, canonical link, the JSON-LD block (what the game is) and the text inside `<canvas>` (never shown over the game).
- `public/about.html`, `how-to-play.html`, `warcraft-3-run-kitty-run.html`: text pages at `/about`, `/how-to-play`, `/warcraft-3-run-kitty-run` (styled by `public/site.css`). Keep them true when the rules change.
- `/patch-notes`: built by `server/pages.js` from `public/js/patchnotes.js`, nothing to keep in step.
- `public/robots.txt`, `public/sitemap.xml` (add new pages there) and `public/llms.txt`.

## Player feedback

Players can send feedback from the game (button shows while their kitty is down / on game over).
It's stored on the server in `/var/lib/run-kitty-run/feedback.jsonl`. Read it with:

```bash
scripts/feedback.sh          # newest last; add -n 20 for only the last 20
```

## Layout

- `public/` – the browser client (static files). `public/js/shared/` is the pure, deterministic game sim, used by both client and server.
- `server/index.js` – Node server: serves `public/` and runs lobbies over WebSockets at `/ws`.
- `deploy/` – systemd unit, Caddyfile (HTTPS), one-time `setup.sh`, `deploy.sh`, and the `rkr-autodeploy` timer that runs it when `main` moves.
- `scripts/deploy.sh` – push `main` and deploy to the UpCloud box right away (the box also polls GitHub every 5 minutes).

## Online netcode, briefly

The server is authoritative and runs the sim at 60 Hz, broadcasting snapshots at 20 Hz. Clients run slightly ahead of
the server, send tick-tagged inputs, predict their own kitty, and reconcile on every snapshot. Wolves are deterministic
from the level seed, so every client simulates them locally; the server sends a few wolf positions per snapshot and a
client that drifts asks for a full wolf-state resync. The first player in a lobby is the host and starts the run; if they
leave, the next player in join order becomes host.

## Tests

```bash
npm test                              # CI set (~12s): sim-test + level-sync-test + ice-pattern-test (1 seed)
node scripts/server-test.mjs          # manual: starts its own server on a free port (finale, moderation, lobbies)
node scripts/finale-test.mjs          # manual tuning tool for the final run (slow)
```

`scripts/sim-test.mjs` holds the rules, playthrough, victory, chat-filter and maze self-test checks: add new checks there.
