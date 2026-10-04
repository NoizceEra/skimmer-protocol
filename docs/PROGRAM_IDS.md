# Program IDs — canonical map + alignment status

**Canonical rule: the repo's declared devnet id MUST equal what `solana program show`
returns. It does.**

## The IDs

| Role | ID | State | Where declared |
|---|---|---|---|
| **devnet / localnet (v1)** | `2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` | **LIVE** — 322,896 B, upgradeable, authority `95DmM5xt695F18s7ouhRHf9wETgyUKxWYWa9z5gma6YG` | `programs/skim_protocol/src/lib.rs` `declare_id!`; `Anchor.toml` `[programs.devnet]` + `[programs.localnet]` |
| mainnet (later) | `ECZ6ZsA79WqYEonfJcmSzp51SPg9nSDiTqu4bAxrfvc9` | **NOT deployed**; no keypair exists | `Anchor.toml` `[programs.mainnet]` |
| ~~retired~~ | ~~`EbRLUsTwqTtMi2M9keQCgkaspNUi1JCBMuVb5v5MjTnJ`~~ | **never deployed** (no account on devnet) | retired; keypair parked at `target/deploy/retired/skim_protocol-keypair.EbRLUsTw.json` |

## Why the devnet id was reverted (history)

Commits `241b983 → d1194d5` generated a **fresh** program id `EbRLUsTw…` and changed
`declare_id!`/`Anchor.toml`, but the fresh id was **never deployed** (faucet
rate-limited; the fresh key file `keys/deployer-devnet.json` = `PDvLyu…` has 0 SOL).
That left source and chain diverged.

The revert back to `2YHE64pk…` is **logic-preserving**: `git diff 241b983 d1194d5 --
programs/skim_protocol/src/lib.rs` shows the *only* source change was the
`declare_id!` line — no instruction/logic change. The 6,016-byte artifact growth
(322,896 → 328,912) comes from the `Cargo.lock` dependency pins added in `d1194d5`,
not from the program. So `2YHE64pk…` (live) and the current source are the same
program logic.

## v1 does not need this program at all

The v1 rail is plain SPL Token (`Approve` + `TransferChecked`) — see
`docs/MINIMAL_DEPLOY.md`. Keeping the program deployed on devnet is harmless
(rent is free faucet SOL) and keeps the id resolvable, but nothing in v1 calls it.

## Grading check

```
scripts/verify-devnet.sh          # asserts id + authority against devnet, prints size
```

## Cross-agent fix list (files OUTSIDE this agent's ownership — parent to route)

After the devnet id reverted to the **live** `2YHE64pk…`, files still holding the
retired `EbRLUsTw…` id disagree and should be updated by their owners:

| File | Line | Exact change |
|---|---|---|
| `bots/telegram/.env` *(gitignored local env)* | 4 | `PROGRAM_ID=EbRLUsTwqTtMi2M9keQCgkaspNUi1JCBMuVb5v5MjTnJ` → `PROGRAM_ID=2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` |
| `tests/lifecycle-report.md` | 3, 25 | replace `EbRLUsTwqTtMi2M9keQCgkaspNUi1JCBMuVb5v5MjTnJ` → `2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` (or mark the report superseded) |
| Any Railway/host env for bot/listener/keeper | — | set `PROGRAM_ID=2YHE64pk9NB5NZea7MUGKTdP6zKcjSg4dxdQUuxjdhqp` |

Already-consistent (no change needed): `bots/telegram/.env.example:5` and
`bots/telegram/src/status.ts:4` both default to `2YHE64pk…`; `sdk/` hardcodes no
program id (it takes one as a parameter).
