# 🚀 Skimmer Protocol — deploy runbook (off this PC + on-chain + first users)

> **START HERE for v1:** `docs/MINIMAL_DEPLOY.md` — v1 needs **no on-chain program
> deploy** (plain SPL `Approve` + `TransferChecked`) and targets **$0–5/mo** on a
> **single process**. Parts 1–2 below are the heavier multi-service + on-chain
> program path, **deferred** until the atomic session rail is actually wanted.

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

## Part 2 — On-chain program (DEFERRED; not needed for v1)

**v1 does not deploy or call this program.** See `docs/MINIMAL_DEPLOY.md`. Only do
this if you adopt the on-chain PDA factory / `session_consume` session rail.

Build (this Windows host): `scripts/build-sbf.sh` (wraps `build-sbf-msvc.bat`,
`cargo-build-sbf 2.2.0`). `anchor build` is broken here — anchor-cli 0.29 calls the
removed `cargo build-bpf` (`error: no such command: build-bpf`).

Rent is **`(size + 128) × 5080` lamports** (live rent sysvar; NOT the obsolete
`×6960`), i.e. `solana rent <size>`. For the 328,912-byte build that is
**1.67152320 SOL** locked; a fresh deploy peaks at **~3.346 SOL** (recommend a 4 SOL
float). Full model + citations: `docs/DEPLOYMENT_COSTS.md`.

### Upgrade the live devnet program in place (optional, cheap)

```
scripts/build-sbf.sh
scripts/deploy-devnet.sh          # prints the exact SOL shortfall if unfunded
scripts/verify-devnet.sh          # asserts id + authority against devnet
```

No program keypair is needed for an upgrade (`--program-id <pubkey>` +
`--upgrade-authority <key>`). The live devnet program is
`2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp`, authority `95DmM5…`.

### Fresh deploy at a NEW id (mainnet, later)

1. Generate a program keypair and put its pubkey in `declare_id!` + `Anchor.toml`.
2. Build (`scripts/build-sbf.sh`), fund the deployer with ~4 SOL.
3. `solana program deploy target/deploy/skim_protocol.so --program-id <keypair.json>
   --url mainnet-beta` (or `anchor deploy --provider.cluster mainnet`).
4. Verify: `solana program show <ID> --url mainnet-beta`.
5. Update `PROGRAM_ID` in every `.env.example` / host env (currently
   `2YHE64pk…` on devnet — see `docs/PROGRAM_IDS.md`).

## Part 3 — First users try it (devnet, $0)

1. User opens `@SkimmerProtocol_Bot`: /connect → /set_rate → /set_destination → /spawn_wallet.
2. Airdrop them devnet SOL; they fund the skim wallet, make a test swap.
3. Listener sees SWAP → keeper sweeps skim + 0.4% → user checks /accrued. 🎉
4. Graduate to mainnet: same flow, real RPC + funded keeper + Helius mainnet webhook.

## Kill-switches

- User: /pause, or revoke the token approval in Phantom/Solflare. Funds never locked.
- You: stop keeper service (sweeps halt, trades unaffected). Treasury needs no action.
