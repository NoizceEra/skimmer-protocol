# 🚀 Skimmer Protocol — deploy runbook (off this PC + on-chain + first users)

## Part 1 — Off this PC (Railway, ~20 min)

Repo: `https://github.com/NoizceEra/skimmer-protocol`. Each service has a
Dockerfile; Railway builds them directly. No code changes needed.

1. Railway → New Project → Deploy from GitHub → pick `skimmer-protocol`.
2. Add **3 services** from the same repo (root directory per service):
   - `bots/telegram` → bot. Env: `TELEGRAM_BOT_TOKEN`, `TREASURY=85TK12gDB5HEJog6g9Gs7sw9xomrsMfsAy8ZSgGtS3ka`,
     `RPC_URL`, `PROGRAM_ID`, `PROTOCOL_FEE_BPS=40`. Add a **volume** mounted at
     `/app/data` (keeps user state across restarts). No public port needed.
   - `listener` → trade watcher. Env: `RPC_URL`, `PROGRAM_ID`, `TREASURY`.
     Give it a **public domain** (Railway settings → Networking). Note the URL —
     Helius posts swaps to `https://<it>/webhook/tx`. Health: `/health`.
   - `keeper` → sweeper. Env: `RPC_URL`, `PROGRAM_ID`, `TREASURY`, plus the
     keeper keypair (Railway **volume** at `/app/keys` or a secret env var —
     never in git). Fund it with ~0.5 SOL gas. Health: `/health`.
3. Helius dashboard → Webhooks → New, type SWAP, addresses = each onboarded
   user's trading wallet (append as users join, or use a wildcard monitored
   list via API), target = listener `/webhook/tx`.
4. Turn off the PC bot (delete the `SkimmerTelegramBot` registry Run value) so
   two bots don't double-reply once Railway owns polling.

## Part 2 — On-chain deploy (mainnet, ~1.6 SOL)

Do this from WSL2/Ubuntu (Windows SBF builds need the Win SDK — see prior
`SAS-Vaults-Skim/MAINNET_DEPLOY.md`). Devnet first, same steps, free.

1. Install Rust + Solana CLI + Anchor 0.29. `anchor --version` → 0.29.0.
2. Fresh program keypair + fresh upgrade authority (hardware/Squads for mainnet —
   never reuse a hot file key). Put the pubkey in `declare_id!` and `Anchor.toml`.
3. `anchor build` → note `target/deploy/skim_protocol.so` bytes →
   rent = `(size + 45) × 6960 / 1e9` (see `docs/COSTS.md`).
4. Fund deployer (~1.6 SOL), `anchor deploy --provider.cluster mainnet`.
5. Verify: `solana program show <ID>` + send 0.01 SOL test skim on devnet build first.
6. Update `PROGRAM_ID` everywhere (`.env.example`s, Railway env, bot config) to
   the real ID.

## Part 3 — First users try it (devnet, $0)

1. User opens `@SkimmerProtocol_Bot`: /connect → /set_rate → /set_destination → /spawn_wallet.
2. Airdrop them devnet SOL; they fund the skim wallet, make a test swap.
3. Listener sees SWAP → keeper sweeps skim + 0.4% → user checks /accrued. 🎉
4. Graduate to mainnet: same flow, real RPC + funded keeper + Helius mainnet webhook.

## Kill-switches

- User: /pause, or revoke the token approval in Phantom/Solflare. Funds never locked.
- You: stop keeper service (sweeps halt, trades unaffected). Treasury needs no action.
