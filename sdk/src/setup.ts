import { Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  buildApproveIx,
  computeSafeAllowance,
  configPda,
  associatedTokenAddress,
  DEFAULT_ALLOWANCE_TOPUPS,
} from './index';

/**
 * One-time onboarding: approve a BOUNDED SPL delegate allowance for the keeper
 * on the user's ATA for a specific mint. The user's own wallet signs ONE tx.
 * No unlimited approvals (never u64::MAX), and it is revocable at any time.
 *
 * Idempotent-safe: SPL `Approve` REPLACES the existing (delegate, amount) pair on
 * the ATA, so re-running the setup cannot stack allowances or double-spend — it
 * simply resets the delegate to `keeperDelegate` with the new bounded amount.
 * Use `setupIsAlreadyEffective()` to skip re-approval when already sufficient.
 */
export interface SetupTxParams {
  /** The user / ATA owner (also the fee payer + sole signer). */
  user: PublicKey;
  /** The keeper pubkey whose delegate approval the user grants. */
  keeperDelegate: PublicKey;
  /** The traded (output) mint. Used to derive the user's ATA. */
  mint?: PublicKey;
  /** Mint decimals — needed for a decimals-aware allowance ceiling. */
  decimals?: number;
  /** Override the derived ATA (advanced). */
  userAta?: PublicKey;
  /** Expected trade output in base units. Defaults to 1 whole token at `decimals`. */
  expectedTradeSize?: bigint;
  savingsBps: number;
  /** Sweeps the approval should cover. Default 20. */
  topUps?: number;
  /** Fee bps. Defaults to the protocol 0.4% (40). */
  feeBps?: number;
  // Decimals-aware ceiling (see computeSafeAllowance): one of these.
  maxUiAmount?: string;
  usdCeiling?: string;
  priceUsdPerToken?: string;
  maxAllowanceBaseUnits?: bigint;
}

export interface SetupPlan {
  /** Unsigned transaction: contains exactly one SPL Approve. */
  transaction: Transaction;
  userAta: PublicKey;
  mint?: PublicKey;
  decimals?: number;
  /** Bounded allowance in base units (skim + fee) × top-ups. */
  allowance: bigint;
  keeperDelegate: string;
  expectedTradeSize: bigint;
  topUps: number;
}

/** Build the plan (allowance + unsigned tx) without touching the network. */
export function planSetup(params: SetupTxParams): SetupPlan {
  if (!params.mint && !params.userAta) {
    throw new Error('setup requires a mint (to derive the ATA) or an explicit userAta');
  }
  const userAta = params.userAta ?? associatedTokenAddress(params.mint as PublicKey, params.user);

  let expectedTradeSize = params.expectedTradeSize;
  if (expectedTradeSize == null) {
    if (params.decimals == null) {
      throw new Error('expectedTradeSize is required when decimals is unknown');
    }
    expectedTradeSize = 10n ** BigInt(params.decimals); // 1 whole token
  }

  const allowance = computeSafeAllowance({
    expectedTradeSize,
    savingsBps: params.savingsBps,
    topUps: params.topUps,
    feeBps: params.feeBps,
    decimals: params.decimals,
    maxUiAmount: params.maxUiAmount,
    usdCeiling: params.usdCeiling,
    priceUsdPerToken: params.priceUsdPerToken,
    maxAllowanceBaseUnits: params.maxAllowanceBaseUnits,
  });

  const transaction = new Transaction().add(
    buildApproveIx(userAta, params.keeperDelegate, params.user, allowance),
  );

  return {
    transaction,
    userAta,
    mint: params.mint,
    decimals: params.decimals,
    allowance,
    keeperDelegate: params.keeperDelegate.toBase58(),
    expectedTradeSize,
    topUps: Math.max(1, Math.floor(params.topUps ?? DEFAULT_ALLOWANCE_TOPUPS)),
  };
}

/** Back-compat: the unsigned transaction alone. */
export function buildSetupTx(params: SetupTxParams): Transaction {
  return planSetup(params).transaction;
}

/** Serialise an UNSIGNED transaction to base64 (fee payer + blockhash required). */
export function serializeUnsignedTx(tx: Transaction): string {
  return tx
    .serialize({ requireAllSignatures: false, verifySignatures: false })
    .toString('base64');
}

export interface SetupBlob extends SetupPlan {
  /** base64 of the unsigned, fee-payer-set, blockhash-set transaction. */
  base64: string;
  bytesLen: number;
}

/**
 * Build the transaction AND serialise it to base64, ready to hand to the user.
 * The bot NEVER signs; the bytes are unsigned and the user's wallet is the only
 * signer. Pass `opts.blockhash` in tests to avoid an RPC round-trip.
 */
export async function buildSetupBlob(
  params: SetupTxParams,
  connection: Connection,
  opts?: { blockhash?: string },
): Promise<SetupBlob> {
  const plan = planSetup(params);
  const tx = plan.transaction;
  tx.feePayer = params.user;
  tx.recentBlockhash =
    opts?.blockhash ?? (await connection.getLatestBlockhash('confirmed')).blockhash;
  const ser = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
  return { ...plan, base64: ser.toString('base64'), bytesLen: ser.length };
}

export interface DelegateState {
  delegate?: string | null;
  delegatedAmount?: bigint | null;
}

/**
 * True when the ATA already delegates enough to this keeper, so the user can skip
 * re-approving. (The allowance shrinks as sweeps draw it down, so this is a
 * point-in-time check, not a guarantee — top-ups are still useful.)
 */
export function setupIsAlreadyEffective(
  current: DelegateState,
  keeperDelegate: string,
  desired: bigint,
): boolean {
  return current.delegate === keeperDelegate && (current.delegatedAmount ?? 0n) >= desired;
}

export async function readConfig(
  connection: Connection,
  programId: PublicKey,
  authority: PublicKey,
): Promise<{ savingsBps: number; destination: string; paused: boolean } | null> {
  const [pda] = configPda(authority, programId);
  const info = await connection.getAccountInfo(pda);
  if (!info) return null;
  // Minimal decode: Anchor discriminator (8) + authority(32) + wallet(32) + dest(32) + bps(u16) + paused(bool)
  // For status display only — full decode lives in the bot.
  const bps = info.data.readUInt16LE(8 + 32 + 32 + 32);
  const paused = info.data.readUInt8(8 + 32 + 32 + 32 + 2) === 1;
  const dest = new PublicKey(info.data.subarray(8 + 32 + 32, 8 + 32 + 32 + 32)).toBase58();
  return { savingsBps: bps, destination: dest, paused };
}
