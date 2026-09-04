# Deploying Sports-Rater (CHALK) on the VPS

Target: `sports-rater.com` behind Cloudflare (Flexible today), nginx on the box, CHALK on `127.0.0.1:4040`, nedbd on `127.0.0.1:7070`, all as systemd services under a dedicated `chalk` user. Node ≥ 24 required (TypeScript runs natively — no build step).

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

Upgrades later: `sudo -u chalk -H bash -c "cd /opt/chalk && git pull && npm ci --omit=dev"` then `sudo systemctl restart chalk chalk-watch`.

## 2. Environment

```bash
sudo -u chalk cp /opt/chalk/deploy/env.example /opt/chalk/.env
sudo -u chalk chmod 600 /opt/chalk/.env
sudoedit -u chalk /opt/chalk/.env      # set CHALK_LLM_KEY; optionally NEDB_TMK=$(openssl rand -hex 32)
```

## 3. Services

```bash
sudo cp /opt/chalk/deploy/nedbd-chalk.service /opt/chalk/deploy/chalk.service /opt/chalk/deploy/chalk-watch.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nedbd-chalk
curl -s http://127.0.0.1:7070/health            # {"ok":true,"engine":"dag",...}
```

## 4. Data (first time, ~10 minutes total)

```bash
sudo -u chalk -H bash -c 'cd /opt/chalk && set -a && . ./.env && set +a && export NEDB_URL=http://127.0.0.1:7070 CHALK_AUTOSTART_NEDB=0 &&
  node bin/chalk.ts ingest --season 2025 &&
  node bin/chalk.ts ingest --season 2025 --context-only &&
  node bin/chalk.ts ingest --season 2026 &&
  node bin/chalk.ts verify'
```

Expect: 285 games / 48,771 plays; ~47k context rows; 272 scheduled 2026 games; `verify` → `ok: true, tamper_evident: true`.

## 5. Serve + watch

```bash
sudo systemctl enable --now chalk chalk-watch
curl -s http://127.0.0.1:4040/api/v1/health     # chalk ok, nedb ok, llm has_key true
journalctl -u chalk -f                          # "warmup: home TB 2025 ready in ...ms"
```

## 6. nginx + DNS

```bash
sudo cp /opt/chalk/deploy/nginx.sports-rater.conf /etc/nginx/conf.d/sports-rater.conf   # or the Mail-in-a-Box custom hook
sudo nginx -t && sudo systemctl reload nginx
```

Cloudflare: `A sports-rater.com → <VPS IP>` (proxied), `CNAME www → sports-rater.com`. SSL mode Flexible to match the box today; Origin Cert + Full (Strict) is the queued hardening.

## 7. Smoke test from outside

```bash
curl -s https://sports-rater.com/api/v1/health | head -c 200
curl -s "https://sports-rater.com/api/v1/teams/TB/home?season=2025" | head -c 300
curl -sN -X POST https://sports-rater.com/api/v1/ask -H 'content-type: application/json' -d '{"question":"Why is Tampa struggling on third down?"}' | head -c 600
```

## Operations

| Need | Command |
| --- | --- |
| Logs | `journalctl -u chalk -f`, `journalctl -u chalk-watch -f`, `journalctl -u nedbd-chalk -f` |
| Integrity | `curl -s http://127.0.0.1:4040/api/v1/verify` |
| Ingest status | `curl -s http://127.0.0.1:4040/api/v1/ingest/status \| head -c 800` |
| Force a re-ingest now | `sudo systemctl restart chalk-watch` (first tick is immediate) |
| Backup | stop `nedbd-chalk`, tar `/opt/chalk/chalk-data`, start. Content-addressed and hash-chained; `verify` after restore. |
| Game day | `chalk-watch` keeps polling; set `CHALK_WATCH_INTERVAL=600` in `.env` for 10-minute ticks and restart the unit. Premium TheSportsDB key in `.env` unlocks the live scoreboard path. |

## Security posture

- nedbd is loopback-only and can additionally require `NEDBD_TOKEN`; at-rest AES-256-GCM via `NEDB_TMK`.
- CHALK has no accounts and stores no personal data: fan writes carry a client-computed hash + a nickname handle. Moderation, when needed, is a hide-by-hash list — nothing is deleted from the chain.
- Rate limits: 20 fan writes burst per handle (1 per 10 s refill), 60 per address (1 per 5 s). nginx caps bodies at 64 KB.
- The only paid dependency is optional (TheSportsDB Premium, ~$9/mo). Everything else is owned stack: NEDB, AiAS/PIN, this box.
