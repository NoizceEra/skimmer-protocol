# Minimal v1 deploy — $0 one-time, $0–5/month

> **The v1 rail needs NO custom on-chain program.** Confirmed by walking the code:
> the user grants the keeper a bounded SPL delegate with a plain SPL Token
> `Approve` (`sdk/src/setup.ts:85-87` → `buildApproveIx`, tag 4 in
> `sdk/src/index.ts:202-204`), and the keeper moves skim + the 0.4% fee with plain
> SPL `TransferChecked` (`keeper/src/engine.ts`, `keeper/src/sweeper.ts:69-80`),
> signing as the delegate. Both are stock SPL Token program instructions. The Anchor
> program is only touched by the PDA factory / `user_config` / `session_consume`
> session rail — all three unreachable in v1 (see `docs/FUNCTIONAL_GAPS.md`).

## Honest trade-off

In v1 the **skim and the 0.4% fee are enforced by the keeper's own code**, not by
the chain. The user's protection is the **bounded SPL delegate approval** (the
keeper can move at most the approved cap, and the user can revoke it any time), not
an on-chain rule. The atomic on-chain `session_consume` rail would enforce
per-trade amounts, but it is not wired and is deferred.

## Cost

| Item | v1 | Deferred / full stack |
|---|---|---|
| On-chain program deploy | **$0** (none needed) | 1.67152320 SOL locked for the 328,912-byte build; ≈3.346 SOL peak (see `docs/DEPLOYMENT_COSTS.md`) |
| Hosting | **$0–5/mo** (one process; own PC = $0; Railway Hobby = $5 mesh incl. usage) | 3 services ≈ $10–36/mo |
| RPC + webhooks | **$0** (public devnet RPC; Helius Free if a webhook is used) | Helius Developer $49/mo |
| Static site | **$0** (Cloudflare Pages / GitHub Pages) | Vercel Pro $20/mo (Hobby is non-commercial-only) |
| Keeper gas | **$0** devnet (faucet) | mainnet held float ~0.2–0.5 SOL |
| Domain | **$0** (`*.pages.dev` / `*.github.io`) | custom `.com` ~$10/yr |

## Single-process layout

One Node process, outbound-only (no inbound port required):

```
  grammy bot (long-polling)   →  no inbound URL
  trade watcher (in-process)  →  watches the user's recent txs, finds swap output
  keeper engine (in-process)  →  processSkim(...) called directly (no HTTP hop)
```

The keeper engine already exports `processSkim` (`keeper/src/engine.ts:345`), so the
in-process call replaces the listener→keeper HTTP hop. Today the repo ships these as
separate entrypoints; collapsing them is a small glue change owned by the
bot/listener/keeper agents (not the chain side).

## Env vars (names verified from `keeper/src/config.ts`, `listener/src/config.ts`, `bots/telegram/.env.example`)

```
# bot
TELEGRAM_BOT_TOKEN=...
RPC_URL=https://api.devnet.solana.com
PROGRAM_ID=2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp
TREASURY=85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka
PROTOCOL_FEE_BPS=40
# keeper
KEEPER_KEYPAIR=./keys/keeper.json          # a NEW keypair; its pubkey is the delegate
KEEPER_SHARED_SECRET=...                    # shared with the listener (constants only)
# listener (only if you use the webhook path)
WEBHOOK_PORT=4000
WEBHOOK_SECRET=...                          # inbound Helius Authorization secret
KEEPER_URL=http://localhost:5001
KEEPER_SHARED_SECRET=...
```

## Run a free devnet beta (Option P — simplest, no ingress, $0)

1. `npm --prefix sdk run build` then `npm --prefix keeper run build` then
   `npm --prefix bots/telegram run build`.
2. Create a keeper keypair; fund it with free devnet SOL (faucet: `solana airdrop 2
   <keeper> --url devnet`, or https://faucet.solana.com — it is rate-limited, retry
   later if it 429s).
3. Run the single process on your own machine (`RPC_URL` = public devnet). Cost: **$0**.
4. Onboard: `/connect` → `/set_rate` → `/set_destination` → `/spawn_wallet`, sign
   the one SPL `Approve`, then make a test swap on devnet.
5. Watch the keeper move the skim to your savings ATA and 0.4% to treasury.

**Option P** replaces the inbound webhook with **outbound polling** of the user's
recent transactions on an interval. No public URL, no ingress, no webhook provider —
runs anywhere including a local PC. Downside: added latency (seconds→tens of
seconds) and more RPC calls. It needs a small listener change: the current parser
consumes Helius **enhanced-transaction** JSON (`listener/src/parser.ts`), so polling
raw RPC txs must map them into the same shape. **Option W** (webhook) exists today
and is the upgrade path once you want sub-second latency.

## Cheapest always-on host ($5/mo, or $0 self-hosted)

- **Local PC / a spare machine**: $0. Fine for a devnet beta.
- **Railway Hobby**: $5/mo subscription that **includes $5 of usage** — one tiny
  service fits inside it. (https://railway.com/pricing)
- **Static site**: **Cloudflare Pages free** (static asset requests are free and
  unlimited — https://developers.cloudflare.com/pages/functions/pricing/) or
  **GitHub Pages free** (public repo — https://docs.github.com/en/pages). Prefer
  these over Vercel Hobby, whose fair-use policy restricts Hobby to **non-commercial**
  use (a fee-taking protocol would need Vercel Pro, $20/mo).

## Deferred until later

- Mainnet program deploy (the 328,912-byte build; ≈3.346 SOL peak).
- The on-chain `session_consume` atomic rail (`grant_session`/`session_consume`) and
  the smart-wallet PDA factory — unreachable in v1.
- Security audit + multisig treasury (see `docs/DEPLOYMENT_COSTS.md` §Audit).
- Multi-service hosting, Helius Developer tier, custom domain.
