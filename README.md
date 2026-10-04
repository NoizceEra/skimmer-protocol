# Skimmer Protocol

> Pay yourself first. Set a percent once, trade anywhere, auto-save a cut of every
> trade — like a fee you pay yourself.

Telegram onboarding + status only (`@SkimmerProtocol_Bot`). No trading inside
Telegram.

## How it works

1. Connect your wallet in Telegram. No new seed.
2. Pick a savings percent and where it goes.
3. Sign **one** transaction: a bounded, revocable SPL delegate approval for the keeper.
4. Trade like normal.
5. Seconds later the keeper moves your cut to savings and takes **0.4%** to treasury.

You keep your keys. Revoke or pause anytime.

## The two rails (be honest about which one v1 uses)

- **v1 rail = plain SPL delegation.** The user approves the keeper as a **bounded
  delegate** on their token account with a standard SPL Token `Approve`
  (`sdk/src/setup.ts`), and the keeper sweeps skim + the 0.4% fee with standard SPL
  `TransferChecked` (`keeper/src/sweeper.ts`, `keeper/src/engine.ts`). No custom
  program is involved.
  - **The keeper can move up to the approved cap, not only "the savings cut"** — the
    chain cannot enforce "only the cut" on this rail. The user's protection is the
    **bounded, revocable approval**. And because both legs are enforced by the
    **keeper's own off-chain code**, the 0.4% fee and the skim can (in principle) be
    skipped or underpaid by a faulty keeper.
- **On-chain atomic `session_consume` rail = NOT wired for v1.** The Anchor program
  has an on-chain rule-enforced session path, but nothing builds or sends
  `grant_session`/`session_consume`, so it is **not** part of v1. Earlier docs
  claimed this rail made enforcement un-skippable — that is **not true today** (see
  `docs/FUNCTIONAL_GAPS.md`).

## Cost

**v1 one-time on-chain cost is $0 and monthly infra targets $0–5** — the plain SPL
rail needs no program deploy and runs as one process. Runbook:
**`docs/MINIMAL_DEPLOY.md`**. Full model: `docs/DEPLOYMENT_COSTS.md`.

Deferred (only if the atomic on-chain rail is wanted later): mainnet program deploy
(≈3.346 SOL peak, 4 SOL float; the 328,912-byte build locks 1.67152320 SOL).

## Program IDs

| Role | ID | State |
|---|---|---|
| devnet / localnet | `2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` | **LIVE** (322,896 B, upgradeable) |
| mainnet | `ECZ6ZsA79WqYEonfJcmSzp51SPg9nSDiTqu4bAxrfvc9` | not deployed |

The repo's `declare_id!` and `Anchor.toml` match the live devnet id. Details +
cross-agent fix list: `docs/PROGRAM_IDS.md`.

## Layout

```
programs/skim_protocol/src/lib.rs  # Anchor program (deferred rail only)
sdk/src/                           # SPL Approve/Revoke + fee math
keeper/src/                        # engine + sweeper (SPL TransferChecked)
listener/src/                      # trade watcher (webhook) + queue
bots/telegram/src/                 # grammy long-polling bot
web/                               # static marketing site
scripts/                           # build / deploy / verify
```

## Build & verify

```bash
scripts/build-sbf.sh          # build the SBF .so (anchor build is broken on this host)
scripts/verify-devnet.sh      # assert devnet id + upgrade authority match this repo
scripts/deploy-devnet.sh      # upgrade the live devnet program (only if you adopt the program)
node tests/fee-math.test.js   # fee math
```

`anchor build` fails here with `error: no such command: build-bpf` (anchor-cli 0.29
calls the removed `cargo build-bpf`); `scripts/build-sbf.sh` is the supported path.

## Run

- Bot: `npm --prefix bots/telegram run build && npm --prefix bots/telegram start`
- Listener: `npm --prefix listener start`
- Keeper: `npm --prefix keeper start`

Env var names, the single-process layout, and a free devnet beta:
`docs/MINIMAL_DEPLOY.md`. Secrets (`.env`, `keys/`) are gitignored and never pushed.
