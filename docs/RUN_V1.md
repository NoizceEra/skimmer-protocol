# Run v1 — one process (bot + listener + keeper)

The v1 rail runs as **ONE Node process on ONE public port**. The Telegram bot
(long-polling, no inbound URL), the listener webhook (`POST /webhook/tx`) and the
keeper engine (`processSkim`, called **in-process** — no HTTP hop) all live here.
`GET /health` on that same port is the single liveness check.

- `app/src/index.ts` — entrypoint: loads `app/.env`, validates, starts everything.
- `app/src/config.ts` — the **one** env surface; fails fast naming a missing var.
- `app/src/runner.ts` — composition + aggregated `/health` + graceful shutdown.
- `app/src/queue-bridge.ts` — the listener's `enqueue/drain` contract over the
  keeper's **durable** `SweepQueue` (persisted to disk; survives restart/retry).
- `app/src/deps.ts` — the only place that reaches into the sibling packages.

v1 needs **no on-chain program** (plain SPL `Approve` + `TransferChecked`). Do not
deploy anything for v1.

---

## 0. Prerequisites (free)

- Node.js 26+ (`node --version`).
- Build the three existing packages once (the runner imports their `dist/`):

```bash
cd /d/ai-studio/skim-protocol
npm --prefix sdk run build
npm --prefix keeper run build
npm --prefix listener run build
npm --prefix bots/telegram run build
```

## 1. Install + build + test (free)

```bash
npm --prefix app install
npm --prefix app run typecheck     # tsc, no emit
npm --prefix app test              # node --test -> 10 tests, no network
npm --prefix app run build
```

## 2. Env (free)

```bash
cp app/.env.example app/.env
```

Edit `app/.env`. **Required** (boot fails fast, naming the missing var):
`TELEGRAM_BOT_TOKEN`, `RPC_URL`, `TREASURY`, `KEEPER_KEYPAIR`, `WEBHOOK_SECRET`.
Everything else has a safe default: `WEBHOOK_PORT` (4000), `PROGRAM_ID`,
`PROTOCOL_FEE_BPS` (40), `USER_STORE_PATH` (`<repo>/data/users.json`),
`KEEPER_STATE_DIR` (`<repo>/data/v1-state`). `app/.env` is gitignored.

The keeper keypair's pubkey is the delegate the bot hands users in `/spawn_wallet`;
the runner exports it to the bot automatically. Generate a keeper keypair if you
need one:

```bash
node -e "const{Keypair}=require('@solana/web3.js'),fs=require('fs');const k=Keypair.generate();fs.writeFileSync('keys/keeper.json',JSON.stringify([...k.secretKey]));console.log(k.publicKey.toBase58())"
```

## 3. Start (free)

```bash
npm --prefix app start
```

Boot prints the keeper pubkey + its SOL balance, then listens.

## 4. Verify `/health` (free)

```bash
curl -s http://127.0.0.1:4000/health
```

```json
{"ok":true,"service":"skim-v1-single-process","uptimeMs":999,"port":4000,
 "bot":{"running":true,"name":"telegram"},
 "listener":{"queueDepth":0,"outstanding":0,"pending":0,"running":0},
 "keeper":{"pubkey":"<keeper>","solLamports":0,"lowFunds":true,"rpc":"ok",
           "envReady":true,"missingEnv":[]}}
```

`bot.running` is `true` only once long-polling is actually up (an invalid/
placeholder token makes it `false` and logs a 401 — that is correct, not a crash).
`keeper.lowFunds:true` means the keeper is under the 0.005 SOL gas floor.

## 5. Fire a test webhook (free)

Helius enhanced-transaction shape; `$SECRET` is your `WEBHOOK_SECRET`:

```bash
curl -s -X POST http://127.0.0.1:4000/webhook/tx \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $SECRET" \
  -d '[{"type":"SWAP",
        "signature":"d814XjoBuviF7Knd8Cjz5sGU3pW4oJNPa5DLwJdaqZMTm5MMnq6MytPwH7yv1U89wXQZUUTHTuRpDvmTYLiY9Cs",
        "feePayer":"36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV",
        "transactionError":null,
        "tokenTransfers":[
          {"fromUserAccount":"36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV","toUserAccount":"5C5ZmJWzc7NZaWjq6VRdaSfF2e1mTN1Gc1ENnD7oYCaS","mint":"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","rawTokenAmount":{"tokenAmount":"250000000","decimals":6}},
          {"fromUserAccount":"5C5ZmJWzc7NZaWjq6VRdaSfF2e1mTN1Gc1ENnD7oYCaS","toUserAccount":"36bQKy5gGsAYFhz6aEK9ZJjbTiVXaPirHMa2yRqoQ2ZV","mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","rawTokenAmount":{"tokenAmount":"1234567890000","decimals":5}}]}]'
```

Expected `{"queued":1,"forwarded":1,"rejected":0}` and, in the process log:

```
enqueued sweep job { signature: 'd814…Y9Cs', user: '36bQ…2ZV' }
keeper engine (in-process) result { signature: 'd814…Y9Cs', user: '36bQ…2ZV', status: 'skipped', reason: 'not-configured' }
```

`not-configured` is correct for a wallet that never onboarded — the point is the
job reached `processSkim` **in this process**. A wrong/absent bearer secret → `401`.

## 6. Onboard a user through the bot

In Telegram: `/start` → `/connect <WALLET>` → `/set_rate 5` →
`/set_destination <SAVINGS_WALLET>` → `/add_mint <MINT>` → `/spawn_wallet`, then
sign the one bounded SPL `Approve` in the user's own wallet. The bot writes the
shared store at `USER_STORE_PATH`; the keeper resolves the user by authority. No
keys are ever held by the bot/keeper beyond the keeper's own sweep key.

## 7. Devnet end-to-end

**Free (no SOL):** steps 1–5 above and the whole `app/test` suite.

**Needs devnet SOL** (the transaction-fee / float parts):

```bash
# fund the keeper (~0.01 SOL is enough for many sweeps) -- needs the faucet
solana airdrop 1 <KEEPER_PUBKEY> --url devnet
# then: onboard a user (step 6) and make a swap on devnet from that wallet,
# and watch the log for `keeper engine (in-process) result { status: 'swept', ... }`.
```

- The keeper float, the user's `Approve` tx fee, and the swap all need SOL. The
  **devnet faucet is rate-limited**: `solana airdrop` frequently returns HTTP 429.
  Retry later or use https://faucet.solana.com. Until the keeper is funded, sweeps
  return `no-keeper-funds` and `/health` shows `lowFunds:true` — funding is the
  blocker, the code is not. This is stated honestly: **a fully live devnet sweep
  could not be demonstrated here because the keeper was unfunded (0 lamports).**

- The inbound webhook needs a **public URL**. On a local PC use a tunnel
  (`cloudflared tunnel --url http://localhost:4000` / `ngrok http 4000`) and point
  your Helius webhook at `https://<tunnel>/webhook/tx` with the same bearer secret.
  `scripts/lifecycle-devnet.js` is the FULL-stack test (PDA factory / session rail)
  and needs the program deployed — **not** part of v1.

## 8. Stop

`Ctrl+C` (or SIGTERM on Linux). The runner stops the bot, closes the port, waits
(bounded) for in-flight sweeps to drain, and closes the queue. Jobs are persisted
by `SweepQueue` on every state change, so an abrupt kill loses no work either —
a restart resumes from `<KEEPER_STATE_DIR>/queue.json`.
