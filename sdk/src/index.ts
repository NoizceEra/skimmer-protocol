import { PublicKey, TransactionInstruction } from '@solana/web3.js';
import { PROTOCOL_FEE_BPS } from './fees';

// ─────────────────────────────────────────────────────────────────────────────
// Program / token identities
// ─────────────────────────────────────────────────────────────────────────────
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
);
export const USER_CONFIG_SEED = 'user_config';

export const BPS_DENOMINATOR = 10_000n;

/**
 * @deprecated Decimals-unaware legacy cap. It is 10^10 **base units of whatever
 * mint** is being approved — i.e. "10 SOL" only when the mint has 9 decimals, but
 * 10,000 USDC when it has 6, and 0.00001 of a 15-decimal token. Its real value
 * varies wildly per token, so it must NOT be used to bound an approval.
 *
 * Retained ONLY so existing imports don't break. Use `resolveAllowanceCeiling()`
 * with explicit `decimals` (and optionally a USD ceiling) instead.
 */
export const MAX_SAFE_ALLOWANCE = 10_000_000_000n;

/** Default number of sweep top-ups one approval should cover. */
export const DEFAULT_ALLOWANCE_TOPUPS = 20;
/** Default per-mint UI-unit ceiling when the caller supplies decimals only. */
export const DEFAULT_MAX_UI_AMOUNT = '100';

// ─────────────────────────────────────────────────────────────────────────────
// Fee math — FROZEN. skim = output * bps / 10000 (integer floor).
// The keeper (keeper/src/sweeper.ts) and the on-chain program compute the exact
// same way, so this behaviour must never change.
// ─────────────────────────────────────────────────────────────────────────────
export function skimFor(output: bigint, bps: number): bigint {
  return (output * BigInt(bps)) / BPS_DENOMINATOR;
}

/**
 * The 0.4% protocol fee charged on a trade's OUTPUT (same base denomination as
 * `output`, i.e. the output mint's base units) — NOT on the skim.
 * Matches `keeper/src/sweeper.ts::skimFor(outputAmount, PROTOCOL_FEE_BPS)`.
 */
export function feeForOutput(output: bigint, feeBps: number = PROTOCOL_FEE_BPS): bigint {
  return skimFor(output, feeBps);
}

function assertBps(bps: number, label: string): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > Number(BPS_DENOMINATOR)) {
    throw new Error(`${label} must be an integer 0..10000 (got ${bps})`);
  }
  return bps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Decimal-aware amount helpers. Everything is BigInt; no float math.
// ─────────────────────────────────────────────────────────────────────────────
const DECIMAL_RE = /^(\d+)(?:\.(\d+))?$/;

/** Parse a human decimal string into an integer scaled by 10^scale (floor). */
export function decimalToScaled(value: string, scale: number): bigint {
  if (!Number.isInteger(scale) || scale < 0 || scale > 36) {
    throw new Error(`scale must be an integer 0..36 (got ${scale})`);
  }
  const s = String(value).trim();
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new Error(`invalid decimal amount: ${JSON.stringify(value)}`);
  const digits = m[1] + (m[2] ?? '');
  const fracLen = (m[2] ?? '').length;
  const mantissa = BigInt(digits);
  const exp = scale - fracLen;
  if (exp >= 0) return mantissa * 10n ** BigInt(exp);
  return mantissa / 10n ** BigInt(-exp);
}

/**
 * Convert a human UI amount (e.g. "2.5") into the mint's BASE UNITS.
 * "1" at 9 decimals → 1_000_000_000n.
 */
export function decimalToBaseUnits(value: string, decimals: number): bigint {
  return decimalToScaled(value, decimals);
}

/**
 * USD-bounded per-mint ceiling in base units: floor(usdCeiling / priceUsdPerToken)
 * whole tokens, then scaled by 10^decimals. Integer-only.
 */
export function ceilingFromUsd(
  usdCeiling: string,
  priceUsdPerToken: string,
  decimals: number,
): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`bad decimals: ${decimals}`);
  }
  const P = 18;
  const usd = decimalToScaled(usdCeiling, P);
  const price = decimalToScaled(priceUsdPerToken, P);
  if (price <= 0n) throw new Error('priceUsdPerToken must be > 0');
  const tokensScaled = (usd * 10n ** BigInt(P)) / price; // human tokens × 10^P
  return (tokensScaled * 10n ** BigInt(decimals)) / 10n ** BigInt(P);
}

export interface AllowanceCeiling {
  /** Mint decimals — required unless `maxAllowanceBaseUnits` is given. */
  decimals?: number;
  /** Human UI-token ceiling, e.g. "100". */
  maxUiAmount?: string;
  /** USD ceiling + per-token USD price (both human decimal strings). */
  usdCeiling?: string;
  priceUsdPerToken?: string;
  /** Explicit escape hatch: a ceiling already expressed in the mint's base units. */
  maxAllowanceBaseUnits?: bigint;
}

/**
 * Resolve the per-mint allowance ceiling in BASE UNITS of the mint being approved.
 * Order: explicit base units → USD ceiling → UI-amount ceiling (default 100 tokens).
 * Always in the mint's own base units, so it is decimals-correct for that mint.
 */
export function resolveAllowanceCeiling(p: AllowanceCeiling): bigint {
  if (p.maxAllowanceBaseUnits != null) {
    if (p.maxAllowanceBaseUnits <= 0n) throw new Error('maxAllowanceBaseUnits must be > 0');
    return p.maxAllowanceBaseUnits;
  }
  if (p.decimals == null) {
    throw new Error(
      'decimals is required for a decimals-aware ceiling (or pass maxAllowanceBaseUnits)',
    );
  }
  if (!Number.isInteger(p.decimals) || p.decimals < 0 || p.decimals > 36) {
    throw new Error(`bad decimals: ${p.decimals}`);
  }
  let ceiling: bigint;
  if (p.usdCeiling != null || p.priceUsdPerToken != null) {
    if (p.usdCeiling == null || p.priceUsdPerToken == null) {
      throw new Error('provide BOTH usdCeiling and priceUsdPerToken');
    }
    ceiling = ceilingFromUsd(p.usdCeiling, p.priceUsdPerToken, p.decimals);
  } else {
    ceiling = decimalToBaseUnits(p.maxUiAmount ?? DEFAULT_MAX_UI_AMOUNT, p.decimals);
  }
  if (ceiling <= 0n) throw new Error('resolved allowance ceiling is 0 — increase the cap');
  return ceiling;
}

export interface AllowanceParams extends AllowanceCeiling {
  /** Expected trade OUTPUT in the output mint's BASE UNITS. */
  expectedTradeSize: bigint;
  savingsBps: number;
  /** Number of sweeps the approval should cover. Default 20. */
  topUps?: number;
  /** Fee in bps. Defaults to the protocol 0.4% (40). */
  feeBps?: number;
}

/**
 * Bounded allowance for the keeper delegate.
 *
 * EVERY sweep spends `skim + protocol fee`, NOT just the skim. The keeper does:
 *   skim = output * savingsBps / 10000
 *   fee  = output * feeBps     / 10000
 * so per-trade spend = skimFor(output, savingsBps) + skimFor(output, feeBps), and
 * the approval must cover that times the number of top-ups, else the allowance
 * silently runs dry and skims stop.
 *
 * The result is capped by a decimals-aware per-mint ceiling (base units).
 */
export function computeSafeAllowance(opts: AllowanceParams): bigint {
  const savingsBps = assertBps(opts.savingsBps, 'savingsBps');
  const feeBps = assertBps(opts.feeBps ?? PROTOCOL_FEE_BPS, 'feeBps');
  if (savingsBps + feeBps > Number(BPS_DENOMINATOR)) {
    throw new Error('savingsBps + feeBps exceeds 10000 bps');
  }
  if (opts.expectedTradeSize <= 0n) throw new Error('expectedTradeSize must be > 0');

  const skim = skimFor(opts.expectedTradeSize, savingsBps);
  const fee = skimFor(opts.expectedTradeSize, feeBps);
  const perTrade = skim + fee;
  if (perTrade <= 0n) {
    throw new Error('per-trade allowance is 0 (trade too small or rate too low)');
  }

  const topUps = Math.max(1, Math.floor(opts.topUps ?? DEFAULT_ALLOWANCE_TOPUPS));
  const total = perTrade * BigInt(topUps);

  const ceiling = resolveAllowanceCeiling(opts);
  if (total > ceiling) {
    throw new Error(
      `allowance ${total} base units (skim ${skim} + fee ${fee}) × ${topUps} top-ups ` +
        `exceeds the per-mint ceiling ${ceiling} base units; raise the ceiling ` +
        `(decimals=${String(opts.decimals)}) or lower top-ups`,
    );
  }
  return total;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPL Approve / Revoke encoders + ATA derivation (no @solana/spl-token needed)
// ─────────────────────────────────────────────────────────────────────────────
function encodeApprove(amount: bigint): Buffer {
  const b = Buffer.alloc(9);
  b.writeUInt8(4, 0); // Approve tag
  b.writeBigUInt64LE(amount, 1);
  return b;
}

/** SPL Token `Revoke` (tag 8) — drops the delegate's authority entirely. */
export function encodeRevoke(): Buffer {
  return Buffer.from([8]);
}

export function buildApproveIx(
  sourceAta: PublicKey,
  delegate: PublicKey,
  owner: PublicKey,
  amount: bigint,
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: encodeApprove(amount),
  });
}

/** Owner-signed revoke of the delegate on their own ATA (belt-and-braces off-switch). */
export function buildRevokeIx(sourceAta: PublicKey, owner: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: sourceAta, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: encodeRevoke(),
  });
}

/** Associated Token Address = PDA([owner, tokenProgram, mint], ATA_PROGRAM). */
export function associatedTokenAddress(
  mint: PublicKey,
  owner: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID,
): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return ata;
}

/**
 * Decode an SPL Approve/Revoke instruction back out, for verification/display.
 * Returns null when `ix` is not an SPL token owner instruction.
 */
export function decodeTokenOwnerIx(
  ix: TransactionInstruction,
):
  | { kind: 'approve'; amount: bigint; delegate: string; owner: string; source: string }
  | { kind: 'revoke'; owner: string; source: string }
  | null {
  if (!ix.programId.equals(TOKEN_PROGRAM_ID) || ix.data.length < 1) return null;
  const tag = ix.data.readUInt8(0);
  if (tag === 4 && ix.data.length >= 9) {
    return {
      kind: 'approve',
      amount: ix.data.readBigUInt64LE(1),
      source: ix.keys[0]?.pubkey.toBase58() ?? '',
      delegate: ix.keys[1]?.pubkey.toBase58() ?? '',
      owner: ix.keys[2]?.pubkey.toBase58() ?? '',
    };
  }
  if (tag === 8) {
    return {
      kind: 'revoke',
      source: ix.keys[0]?.pubkey.toBase58() ?? '',
      owner: ix.keys[1]?.pubkey.toBase58() ?? '',
    };
  }
  return null;
}

export function configPda(authority: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(USER_CONFIG_SEED), authority.toBuffer()],
    programId,
  );
}

export * from './setup';
export * from './fees';
