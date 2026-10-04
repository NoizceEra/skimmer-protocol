/**
 * Pure parser: Helius enhanced-transaction event -> skim job for a GENUINE swap output.
 *
 * WHAT COUNTS AS A SWAP
 * A swap is recognised when the FEE PAYER has an incoming SPL-token leg AND an
 * outgoing leg, where the outgoing leg may be EITHER:
 *   - an SPL token transfer (`event.tokenTransfers`), or
 *   - native SOL spent by the fee payer (`event.nativeTransfers` entry whose
 *     `fromUserAccount` is the fee payer, or — as a SUPPORTING signal only — an
 *     `accountData[].nativeBalanceChange` that is negative by MORE than the
 *     network `fee`).
 *
 * WHY THE NATIVE LEG MATTERS
 * `tokenTransfers` covers SPL tokens ONLY. Buying a token with native SOL on
 * Jupiter/Raydium/Photon/GMGN sends NATIVE SOL out and receives an SPL token in,
 * so there is NO outgoing SPL transfer. A parser that required a sent SPL leg
 * silently dropped the single most common trade and earned nothing. Native SOL is
 * therefore treated as a valid OUTGOING leg so a SOL-in swap produces a job for the
 * RECEIVED token.
 *
 * Security properties (each covered by test/parser.test.ts):
 *  - Rejects reverted transactions (`transactionError`).
 *  - Rejects non-swap token-flow shapes. A pure transfer-in, airdrop, claim,
 *    receive or plain send has NO outgoing leg of any kind (SPL OR native) and
 *    produces NOTHING — this is the core over-skim bug that must never regress.
 *    The native leg is deliberately conservative: a lone network fee does NOT
 *    count (an airdrop recipient who merely paid the fee is still rejected), and
 *    the accountData fallback only fires when the payer spent SOL beyond the fee.
 *  - Wrapped SOL (`So11111111111111111111111111111111111111112`) is never a skim
 *    target. A pure wrap/unwrap only moves SOL between the payer and their own
 *    WSOL account, so the received WSOL leg is excluded and no job is produced.
 *  - Selects the NET OUTPUT leg: an incoming token the fee payer did NOT also send
 *    out (so a multi-hop intermediate is rejected), preferring the largest amount.
 *  - Requires `decimals` from the event's token metadata; if they cannot be
 *    determined the job is dropped and logged rather than guessed.
 *  - Validates every signature/pubkey as base58 (signature = 64 bytes, pubkey = 32
 *    bytes) so malformed values never reach the keeper.
 *
 * SOL-OUT (SELL) DECISION — v1 does NOT skim native SOL out
 * A token -> SOL sell (payer gives up a token, receives native SOL) returns null.
 * Native SOL is not an SPL token balance, so there is no truthful mint to charge in
 * base units; reporting the WSOL mint would point the keeper at a token account the
 * payer does not hold. v1 therefore skims received TOKENS only. The sell is
 * intentionally NOT a job; it is documented here and asserted in the tests.
 *
 * RESIDUAL UNCERTAINTY
 * Aggregator routes that move SOL without emitting a `nativeTransfers` entry AND
 * without a fee-exceeding native balance delta would still be missed. The live
 * Helius API cannot be exercised from here, so the native-leg shapes are handled
 * defensively and this gap is acknowledged rather than hidden.
 *
 * The function is pure: it takes an event and returns ParsedSwap | null.
 */

export interface ParsedSwap {
  signature: string;
  /** Fee payer / wallet authority (base58). */
  user: string;
  /** Output token mint (base58). */
  mint: string;
  /** Base-unit amount as a u64 decimal string. */
  outputAmount: string;
  decimals: number;
  /** 'high' when the raw base-unit amount came from rawTokenAmount; 'low' when it
   *  had to be derived from a human-readable amount. */
  confidence: 'high' | 'low';
}

export interface ParseOptions {
  log?: (message: string, meta?: Record<string, unknown>) => void;
}

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_INDEX: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < B58_ALPHABET.length; i++) map[B58_ALPHABET[i]] = i;
  return map;
})();

/** Minimal base58 (bitcoin alphabet) decoder. Returns null on any invalid input. */
export function base58Decode(input: unknown): Uint8Array | null {
  if (typeof input !== 'string' || input.length === 0) return null;
  let zeros = 0;
  while (zeros < input.length && input[zeros] === '1') zeros++;
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const value = B58_INDEX[input[i]];
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

/** True iff `value` is a base58 string encoding exactly 32 bytes (Solana pubkey). */
export function isBase58Pubkey(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === 32;
}

/** True iff `value` is a base58 string encoding exactly 64 bytes (Solana signature). */
export function isBase58Signature(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const decoded = base58Decode(value);
  return decoded !== null && decoded.length === 64;
}

const SWAP_TYPES = new Set(['SWAP', 'JUPITER_SWAP', 'SWAP_BASE_IN', 'SWAP_BASE_OUT']);

/** Canonical wrapped-SOL mint. Never a skim target (see SOL-OUT decision above). */
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

function transfersOf(event: any): any[] {
  return Array.isArray(event?.tokenTransfers) ? event.tokenTransfers : [];
}

function nativeTransfersOf(event: any): any[] {
  return Array.isArray(event?.nativeTransfers) ? event.nativeTransfers : [];
}

function accountDataOf(event: any): any[] {
  return Array.isArray(event?.accountData) ? event.accountData : [];
}

/** Coerce an UNSIGNED lamport value (number | decimal string) to bigint, or undefined. */
function toLamports(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  return undefined;
}

/** Coerce a SIGNED lamport value (nativeBalanceChange) to bigint, or undefined. */
function toSignedLamports(value: unknown): bigint | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return BigInt(value);
  if (typeof value === 'string' && /^-?[0-9]+$/.test(value)) return BigInt(value);
  return undefined;
}

interface NativeOutgoing {
  /** True when `nativeTransfers` shows the fee payer sending > 0 lamports. */
  fromTransfers: boolean;
  /** Total lamports the fee payer explicitly sent (from nativeTransfers). */
  spentLamports: bigint;
  /** Supporting signal: fee-payer native balance dropped by more than the fee. */
  fromBalanceDelta: boolean;
}

/**
 * Detect whether the fee payer spent native SOL.
 *
 * Primary signal: an explicit `nativeTransfers` entry from the fee payer with a
 * positive lamport amount.
 *
 * Supporting signal (used only when there is no explicit transfer): the fee payer's
 * `accountData[].nativeBalanceChange` is negative by MORE than `event.fee`. The fee
 * itself is always deducted from the payer, so a purely fee-paying recipient must
 * NOT be mistaken for someone who traded SOL — requiring the drop to exceed the fee
 * is what preserves the airdrop/claim/transfer-in rejection.
 */
function computeNativeOutgoing(event: any, feePayer: string): NativeOutgoing {
  let spentLamports = 0n;
  let fromTransfers = false;
  for (const nt of nativeTransfersOf(event)) {
    if (nt?.fromUserAccount !== feePayer) continue;
    const amount = toLamports(nt?.amount);
    if (amount !== undefined && amount > 0n) {
      spentLamports += amount;
      fromTransfers = true;
    }
  }

  let fromBalanceDelta = false;
  if (!fromTransfers) {
    const account = accountDataOf(event).find((a: any) => a?.account === feePayer);
    const delta = toSignedLamports(account?.nativeBalanceChange);
    const fee = toLamports(event?.fee) ?? 0n;
    if (delta !== undefined && delta < 0n && delta < -fee) fromBalanceDelta = true;
  }

  return { fromTransfers, spentLamports, fromBalanceDelta };
}

function pickDecimals(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 36) return v;
  }
  return undefined;
}

/** Look for a decimals value anywhere the event plausibly carries token metadata. */
function resolveDecimals(event: any, mint: string, transfer: any): number | undefined {
  const maps = [event?.tokenMetadata, event?.meta?.tokenMetadata, event?.tokens];
  let fromMap: number | undefined;
  for (const map of maps) {
    if (map && typeof map === 'object') {
      const entry = map[mint];
      fromMap = pickDecimals(entry?.decimals, typeof entry === 'number' ? entry : undefined);
      if (fromMap !== undefined) break;
    }
  }

  let fromAccount: number | undefined;
  if (Array.isArray(event?.accountData)) {
    const account = event.accountData.find((a: any) => a?.account === mint);
    if (account) {
      const changes = Array.isArray(account.tokenBalanceChanges) ? account.tokenBalanceChanges : [];
      fromAccount = pickDecimals(account.decimals, changes[0]?.decimals);
    }
  }

  return pickDecimals(transfer?.rawTokenAmount?.decimals, transfer?.decimals, fromMap, fromAccount);
}

/** Base-unit (raw) amount as a decimal string, when the event carries one. */
function rawAmountOf(transfer: any): string | undefined {
  const candidates = [transfer?.rawTokenAmount?.tokenAmount, transfer?.tokenAmountRaw, transfer?.rawAmount];
  for (const c of candidates) {
    if (typeof c === 'string' && /^[0-9]+$/.test(c)) return c;
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0) return String(c);
  }
  return undefined;
}

/** Relative ranking key used only to prefer the largest incoming leg. */
function rankOf(transfer: any): bigint {
  const raw = rawAmountOf(transfer);
  if (raw !== undefined) return BigInt(raw);
  const human = transfer?.tokenAmount;
  if (typeof human === 'number' && Number.isFinite(human) && human > 0) {
    return BigInt(Math.round(human * 1e6));
  }
  return 0n;
}

/**
 * Parse a Helius SWAP webhook event into a skim job. Returns null for anything that
 * is not a genuine swap output (transfer-ins, airdrops, claims, reverted txs,
 * multi-hop-only intermediates, wraps/unwraps of SOL, SOL-out sells, missing
 * metadata, malformed keys).
 */
export function parseSwapEvent(event: any, opts: ParseOptions = {}): ParsedSwap | null {
  const log = opts.log ?? (() => {});

  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;

  // 1. Reverted transactions are never skimmable.
  if (event.transactionError) return null;

  // 2. Validate identity fields up front — never pass garbage to the keeper.
  if (!isBase58Signature(event.signature)) return null;
  const feePayer = event.feePayer;
  if (!isBase58Pubkey(feePayer)) return null;

  // 3. Swap-shape guard: the fee payer must have BOTH an incoming SPL leg and an
  //    outgoing leg (SPL token OR native SOL). A pure transfer-in / airdrop /
  //    claim / receive has no outgoing leg of either kind and is rejected; so is
  //    a plain outgoing send with nothing received.
  const transfers = transfersOf(event);
  const incoming = transfers.filter((t: any) => t?.toUserAccount === feePayer);
  const outgoingSpl = transfers.filter((t: any) => t?.fromUserAccount === feePayer);
  const native = computeNativeOutgoing(event, feePayer);

  const hasIncomingSpl = incoming.length > 0;
  const hasOutgoing = outgoingSpl.length > 0 || native.fromTransfers || native.fromBalanceDelta;
  if (!hasIncomingSpl || !hasOutgoing) return null;

  if (native.fromBalanceDelta && !native.fromTransfers) {
    // Fallback path taken (no explicit nativeTransfers entry): record for observability.
    log('native SOL leg inferred from accountData balance change', {
      signature: event.signature,
      feePayer,
    });
  }

  const typeIsSwap = typeof event.type === 'string' && SWAP_TYPES.has(event.type);
  if (!typeIsSwap) {
    // Token flow is unambiguous, but record the unusual typing for observability.
    log('swap-shaped event without a SWAP type', { signature: event.signature, type: event.type });
  }

  // 4. NET OUTPUT leg: an incoming token the fee payer did NOT also send out.
  //    This rejects multi-hop intermediates that merely pass through the wallet.
  //    Wrapped SOL is excluded: a pure wrap/unwrap (or a router's WSOL hop) is not
  //    an SPL skim target, and v1 does not skim SOL out.
  const sentMints = new Set(outgoingSpl.map((t: any) => t?.mint));
  const candidates = incoming.filter(
    (t: any) => typeof t?.mint === 'string' && t.mint !== WSOL_MINT && !sentMints.has(t.mint),
  );
  if (candidates.length === 0) return null;

  // Prefer the largest genuine incoming leg.
  const chosen = candidates.reduce((best: any, cur: any) => (rankOf(cur) > rankOf(best) ? cur : best));

  if (!isBase58Pubkey(chosen.mint)) return null;

  // 5. Decimals are required and must come from metadata — never invented.
  const decimals = resolveDecimals(event, chosen.mint, chosen);
  if (decimals === undefined) {
    log('dropping job: decimals unavailable', { signature: event.signature, mint: chosen.mint });
    return null;
  }

  // 6. Base-unit amount.
  let amountStr = rawAmountOf(chosen);
  let confidence: 'high' | 'low' = 'high';
  if (amountStr === undefined) {
    const human = chosen?.tokenAmount;
    if (typeof human === 'number' && Number.isFinite(human) && human > 0) {
      const scaled = Math.round(human * 10 ** decimals);
      if (Number.isSafeInteger(scaled)) {
        amountStr = String(scaled);
        confidence = 'low';
      }
    }
  }
  if (amountStr === undefined) return null;

  const amount = BigInt(amountStr);
  if (amount <= 0n) return null;

  return {
    signature: event.signature,
    user: feePayer,
    mint: chosen.mint,
    outputAmount: amount.toString(),
    decimals,
    confidence,
  };
}
