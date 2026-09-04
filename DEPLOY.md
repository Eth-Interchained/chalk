# Deploying Sports-Rater (CHALK) on the VPS

Target: `sports-rater.com` behind Cloudflare (Flexible today), nginx on the box, CHALK on `127.0.0.1:4040` with **NEDB embedded in-process** (no daemon), one systemd unit under a dedicated `chalk` user. Node ≥ 24 required (TypeScript runs natively — no build step).

Everything below is copy-paste in order. Nothing here touches other sites on the box.

## 0. One-time host prep

```bash
sudo useradd --system --home /opt/chalk --shell /usr/sbin/nologin chalk || true
sudo mkdir -p /opt/chalk && sudo chown chalk:chalk /opt/chalk
node -v   # must be >= 24. If not: https://nodejs.org/en/download (or nvm) — Node 24 LTS.
```

## 1. Code

```bash
sudo -u chalk -H bash -c '
  cd /opt/chalk &&
  git clone https://github.com/Eth-Interchained/chalk.git . &&
  npm ci --omit=dev
'
```

Upgrades later: `sudo -u chalk -H bash -c "cd /opt/chalk && git pull && npm ci --omit=dev"` then `sudo systemctl restart chalk`.

## 2. Environment

```bash
sudo -u chalk cp /opt/chalk/deploy/env.example /opt/chalk/.env
sudo -u chalk chmod 600 /opt/chalk/.env
sudoedit -u chalk /opt/chalk/.env      # set CHALK_LLM_KEY; optionally NEDB_TMK=$(openssl rand -hex 32)
```

## 3. Data (first time, ~10 minutes total — run BEFORE starting the service; one engine per data dir)

```bash
sudo -u chalk -H bash -c 'cd /opt/chalk && set -a && . ./.env && set +a &&
  node bin/chalk.ts ingest --season 2025 &&
  node bin/chalk.ts ingest --season 2025 --context-only &&
  node bin/chalk.ts ingest --season 2026 &&
  node bin/chalk.ts verify'
```

Expect: 285 games / 48,771 plays; ~47k context rows; 272 scheduled 2026 games; `verify` → `ok: true, tamper_evident: true`. Then `node bin/chalk.ts audit --season 2025` → `ok: true` (exit 2 and a named game if the source shorted one). Each command opens the embedded store, writes, flushes, exits.

## 4. Serve (API + client + in-process watch loop)

```bash
sudo cp /opt/chalk/deploy/chalk.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now chalk
curl -s http://127.0.0.1:4040/api/v1/health     # chalk ok, nedb embedded, llm has_key true
journalctl -u chalk -f                          # "store: embedded NEDB at /opt/chalk/chalk-data (engine on a worker thread)", "warmup: persisted home snapshot ... serves instantly" (first boot ever: "building"; ~30s once), "watch: season 2026 every 1800s in-process (embedded store, deep=true — context included)", "watch 2026: ..."
```

While `chalk` runs it owns `/opt/chalk/chalk-data`; to run a CLI command against the data, `sudo systemctl stop chalk` first (or point the CLI at a copy).

## 5. nginx + DNS

```bash
sudo cp /opt/chalk/deploy/nginx.sports-rater.conf /etc/nginx/conf.d/sports-rater.conf   # or the Mail-in-a-Box custom hook
sudo nginx -t && sudo systemctl reload nginx
```

Cloudflare: `A sports-rater.com → <VPS IP>` (proxied), `CNAME www → sports-rater.com`. SSL mode Flexible to match the box today; Origin Cert + Full (Strict) is the queued hardening.

## 6. Smoke test from outside

```bash
curl -s https://sports-rater.com/api/v1/health | head -c 200
curl -s "https://sports-rater.com/api/v1/teams/TB/home?season=2025" | head -c 300
curl -sN -X POST https://sports-rater.com/api/v1/ask -H 'content-type: application/json' -d '{"question":"Why is Tampa struggling on third down?"}' | head -c 600
```

## Operations

| Need | Command |
| --- | --- |
| Logs | `journalctl -u chalk -f` (API, watch ticks and the embedded engine all log here) |
| Integrity | `curl -s http://127.0.0.1:4040/api/v1/verify` |
| Ingest status | `curl -s http://127.0.0.1:4040/api/v1/ingest/status \| head -c 800` |
| Season audit (is anything missing?) | `curl -s "http://127.0.0.1:4040/api/v1/ingest/audit?season=2025"` — names games below the 100-play floor or without context; `&full=1` for per-game counts. Fix a short game with `chalk ingest --season 2025 --game <ID> --deep` (stop `chalk` first). |
| Home after restart | instant from the persisted snapshot in `football_home_snapshots`; if the data changed since, the stale one is served flagged `refreshing` and rebuilt in the background. `?fresh=1` on `/api/v1/teams/TB/home` forces a rebuild. |
| Admin panel | set `CHALK_ADMIN_TOKEN=$(openssl rand -hex 24)` in `.env`, restart, open `https://sports-rater.com/admin`, paste the token (kept in that tab only). Usage, heatmaps, unanswered questions, fans, preferences, health. Unset = 404. |
| Force a re-ingest now | `sudo systemctl restart chalk` (first watch tick is immediate) |
| Backup | `sudo systemctl stop chalk`, tar `/opt/chalk/chalk-data`, start. Content-addressed and hash-chained; `chalk verify` after restore. |
| Game day | the in-process watch keeps polling (plays + context every tick; `CHALK_WATCH_DEEP=0` to skip context if the source throttles); set `CHALK_WATCH_INTERVAL=600` in `.env` for 10-minute ticks and restart `chalk`. Premium TheSportsDB key in `.env` unlocks the live scoreboard path. |

## Security posture

- NEDB runs inside the CHALK process — on a worker thread under `chalk serve`, so a 25 s cold rebuild never freezes HTTP (`CHALK_EMBEDDED_WORKER=0` forces in-thread); nothing listens but CHALK on loopback. (Daemon mode remains available via `NEDB_URL` for multi-process setups.)
- CHALK has no accounts and stores no personal data: fan writes carry a client-computed hash + a nickname handle. Moderation, when needed, is a hide-by-hash list — nothing is deleted from the chain.
- Rate limits: 20 fan writes burst per handle (1 per 10 s refill), 60 per address (1 per 5 s). nginx caps bodies at 64 KB.
- The only paid dependency is optional (TheSportsDB Premium, ~$9/mo). Everything else is owned stack: NEDB, AiAS/PIN, this box.
