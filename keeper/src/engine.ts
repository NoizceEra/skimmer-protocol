/**
 * The Skimmer sweep engine.
 *
 * `buildSweepPlan` is PURE and deterministic: it computes the skim/fee amounts
 * and constructs the exact instruction sequence, touching no network. Both the
 * live `processSkim` path and the offline simulation harness use it, so the
 * simulated plan is provably the same plan that would be sent.
 *
 * `processSkim` is the hardened engine. It is exported under its original name
 * and remains callable as a plain function (unit-testable), while the HTTP
 * entry point wraps it in the persistent retry queue (see queue.ts).
 *
 * Money math matches the on-chain program exactly:
 *   skim = outputAmount * savingsBps / 10000   (integer division, BigInt)
 *   fee  = outputAmount * 40        / 10000    (0.4% = 40 bps protocol fee)
 */
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import type { ResolvedUser } from './store';
import type { DedupeLike } from './dedupe';
import type { DeadLetterLike } from './deadletter';

export const PROTOCOL_FEE_BPS = 40; // 0.4%
export const MAX_SAVINGS_BPS = 1000; // 10% — matches MAX_SAVINGS_BPS in the program
export const BPS_DENOM = 10000n;
export const DEFAULT_MIN_KEEPER_LAMPORTS = 5_000_000;
export const DEFAULT_COMPUTE_UNIT_LIMIT = 200_000;
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS = 1_000n;

export type SkipReason =
  | 'paused'
  | 'not-configured'
  | 'no-delegate'
  | 'allowance-too-low'
  | 'dust'
  | 'duplicate'
  | 'no-keeper-funds';

export type SweepResult =
  | { status: 'swept'; signature: string; skim: string; fee: string }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'duplicate' };

/** Thrown only for transient failures (RPC/network/blockhash expiry). */
export class SweepTransientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SweepTransientError';
  }
}

export function skimFor(output: bigint, bps: number): bigint {
  return (output * BigInt(bps)) / BPS_DENOM;
}

export function computeAmounts(
  output: bigint,
  savingsBps: number,
): { skim: bigint; fee: bigint } {
  return { skim: skimFor(output, savingsBps), fee: skimFor(output, PROTOCOL_FEE_BPS) };
}

// ---------------------------------------------------------------------------
// Pure planner
// ---------------------------------------------------------------------------

export interface NamedInstruction {
  name: string;
  programId: string;
  instruction: TransactionInstruction;
}

export interface SweepPlan {
  skim: bigint;
  fee: bigint;
  totalDebited: bigint;
  sourceAta: PublicKey;
  destinationAta: PublicKey;
  treasuryAta: PublicKey;
  tokenProgram: PublicKey;
  instructions: NamedInstruction[];
}

export interface BuildPlanInput {
  keeper: PublicKey;
  treasury: PublicKey;
  /** Owner of the source ATA — the user's authority / smart wallet. */
  userAuthority: PublicKey;
  savingsDestination: PublicKey;
  mint: PublicKey;
  decimals: number;
  outputAmount: bigint;
  savingsBps: number;
  tokenProgram?: PublicKey;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
}

/**
 * Deterministically build the instruction sequence:
 *   [setComputeUnitLimit, setComputeUnitPrice?]
 *   createDestinationAta, createTreasuryAta,   <- idempotent, ALWAYS present
 *   transferSkim, transferFee?                 <- authorised by the keeper (SPL delegate)
 */
export function buildSweepPlan(input: BuildPlanInput): SweepPlan {
  const tokenProgram = input.tokenProgram ?? TOKEN_PROGRAM_ID;
  const { skim, fee } = computeAmounts(input.outputAmount, input.savingsBps);

  const sourceAta = getAssociatedTokenAddressSync(
    input.mint,
    input.userAuthority,
    false,
    tokenProgram,
  );
  const destinationAta = getAssociatedTokenAddressSync(
    input.mint,
    input.savingsDestination,
    false,
    tokenProgram,
  );
  const treasuryAta = getAssociatedTokenAddressSync(
    input.mint,
    input.treasury,
    false,
    tokenProgram,
  );

  const instructions: NamedInstruction[] = [];
  const push = (name: string, instruction: TransactionInstruction) =>
    instructions.push({ name, programId: instruction.programId.toBase58(), instruction });

  if (input.computeUnitLimit && input.computeUnitLimit > 0) {
    push(
      'setComputeUnitLimit',
      ComputeBudgetProgram.setComputeUnitLimit({ units: input.computeUnitLimit }),
    );
  }
  if (input.computeUnitPriceMicroLamports && input.computeUnitPriceMicroLamports > 0n) {
    push(
      'setComputeUnitPrice',
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: input.computeUnitPriceMicroLamports,
      }),
    );
  }

  // Both ATAs are ensured with the idempotent instruction BEFORE any transfer.
  // A missing treasury ATA therefore can never fail the whole sweep.
  push(
    'createDestinationAta',
    createAssociatedTokenAccountIdempotentInstruction(
      input.keeper,
      destinationAta,
      input.savingsDestination,
      input.mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );
  push(
    'createTreasuryAta',
    createAssociatedTokenAccountIdempotentInstruction(
      input.keeper,
      treasuryAta,
      input.treasury,
      input.mint,
      tokenProgram,
      ASSOCIATED_TOKEN_PROGRAM_ID,
    ),
  );

  push(
    'transferSkim',
    createTransferCheckedInstruction(
      sourceAta,
      input.mint,
      destinationAta,
      input.keeper, // SPL delegate authority
      skim,
      input.decimals,
      [],
      tokenProgram,
    ),
  );
  if (fee > 0n) {
    push(
      'transferFee',
      createTransferCheckedInstruction(
        sourceAta,
        input.mint,
        treasuryAta,
        input.keeper,
        fee,
        input.decimals,
        [],
        tokenProgram,
      ),
    );
  }

  return {
    skim,
    fee,
    totalDebited: skim + fee,
    sourceAta,
    destinationAta,
    treasuryAta,
    tokenProgram,
    instructions,
  };
}

export function buildTransactionFromPlan(
  plan: SweepPlan,
  payer: PublicKey,
): Transaction {
  const tx = new Transaction();
  for (const item of plan.instructions) tx.add(item.instruction);
  tx.feePayer = payer;
  return tx;
}

// ---------------------------------------------------------------------------
// Token program detection (Token-2022 safety)
// ---------------------------------------------------------------------------

export const SUPPORTED_TOKEN_PROGRAMS = [
  TOKEN_PROGRAM_ID.toBase58(),
  TOKEN_2022_PROGRAM_ID.toBase58(),
];

export type MintProgramReader = (mint: PublicKey) => Promise<string | null>;

/**
 * Read the mint's owning program and return the matching token program.
 * Falls back to the legacy program when the owner is unknown/unreadable or is
 * not one of the two SPL token programs (never invents a program id).
 */
export async function detectTokenProgram(
  readOwner: MintProgramReader,
  mint: PublicKey,
): Promise<PublicKey> {
  let owner: string | null = null;
  try {
    owner = await readOwner(mint);
  } catch {
    owner = null;
  }
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

export function makeMintProgramReader(
  connection: Connection,
  cacheMs = 5 * 60 * 1000,
  now: () => number = Date.now,
): MintProgramReader {
  const cache = new Map<string, { owner: string; at: number }>();
  return async (mint: PublicKey) => {
    const key = mint.toBase58();
    const hit = cache.get(key);
    if (hit && now() - hit.at < cacheMs) return hit.owner;
    const info = await connection.getAccountInfo(mint);
    const owner = info ? info.owner.toBase58() : null;
    if (owner) cache.set(key, { owner, at: now() });
    return owner;
  };
}

// ---------------------------------------------------------------------------
// Hardened engine
// ---------------------------------------------------------------------------

export interface TokenAccountView {
  delegate: PublicKey | null;
  delegatedAmount: bigint;
  amount: bigint;
}

export interface ProcessSkimParams {
  connection: Connection;
  keeper: Keypair;
  treasury: PublicKey;
  /** Requested user authority pubkey (the source ATA owner). */
  user: PublicKey;
  mint: PublicKey;
  outputAmount: bigint;
  decimals: number;
  swapSignature: string;

  // --- config resolution (FROZEN store lookup OR explicit legacy values) ---
  resolveUser?: (authority: string) => ResolvedUser | null;
  savingsBps?: number;
  savingsDestination?: PublicKey;
  paused?: boolean;
  /** Explicit delegate to require on the source ATA (defaults to keeper). */
  requiredDelegate?: PublicKey;

  // --- infrastructure ---
  dedupe?: DedupeLike;
  deadletter?: DeadLetterLike;
  /** True when the caller (queue) already holds the dedupe claim for this sig. */
  dedupeHeld?: boolean;
  minKeeperLamports?: number;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
  tokenProgram?: PublicKey;
  resolveTokenProgram?: () => Promise<PublicKey>;
  now?: () => number;

  // --- test / offline seams ---
  fetchBalance?: (pubkey: PublicKey) => Promise<number>;
  fetchTokenAccount?: (ata: PublicKey) => Promise<TokenAccountView>;
  submitTransaction?: (tx: Transaction) => Promise<string>;
}

const TERMINAL_REASONS: ReadonlySet<SkipReason> = new Set<SkipReason>([
  'paused',
  'not-configured',
  'no-delegate',
  'allowance-too-low',
  'dust',
]);

/**
 * Sweep a single swap output. Returns a terminal result (swept / skipped /
 * duplicate). Throws SweepTransientError only for transient chain failures so
 * the retry queue can back off and try again.
 */
export async function processSkim(params: ProcessSkimParams): Promise<SweepResult> {
  const now = params.now ?? Date.now;
  const authorityStr = params.user.toBase58();

  // 1. Resolve the user's settings (explicit values win for backward compat).
  let savingsBps: number;
  let savingsDestination: PublicKey;
  let paused: boolean;
  if (
    params.savingsBps !== undefined &&
    params.savingsDestination !== undefined
  ) {
    savingsBps = params.savingsBps;
    savingsDestination = params.savingsDestination;
    paused = params.paused === true;
  } else {
    const resolved = params.resolveUser ? params.resolveUser(authorityStr) : null;
    if (!resolved) return { status: 'skipped', reason: 'not-configured' };
    if (resolved.paused) return { status: 'skipped', reason: 'paused' };
    // A record whose delegate is not our own pubkey is not ours to sweep.
    if (resolved.delegate !== params.keeper.publicKey.toBase58()) {
      return { status: 'skipped', reason: 'no-delegate' };
    }
    if (
      !Number.isInteger(resolved.savingsBps) ||
      resolved.savingsBps < 0 ||
      resolved.savingsBps > MAX_SAVINGS_BPS
    ) {
      return { status: 'skipped', reason: 'not-configured' };
    }
    savingsBps = resolved.savingsBps;
    try {
      savingsDestination = new PublicKey(resolved.destination);
    } catch {
      return { status: 'skipped', reason: 'not-configured' };
    }
    paused = false;
  }

  // 0 bps means "off" — nothing to save, treat as paused.
  if (paused || savingsBps <= 0) {
    return { status: 'skipped', reason: 'paused' };
  }

  // 2. Dedupe claim (persistent when a store is supplied).
  const ownsClaim = params.dedupe !== undefined && params.dedupeHeld !== true;
  if (ownsClaim && params.dedupe && !params.dedupe.claim(params.swapSignature)) {
    return { status: 'duplicate' };
  }
  const releaseClaim = () => {
    if (ownsClaim && params.dedupe) params.dedupe.release(params.swapSignature);
  };

  // 3. Dust guard.
  const { skim, fee } = computeAmounts(params.outputAmount, savingsBps);
  if (skim <= 0n) {
    recordDeadletter(params, now, 'dust', { skim: skim.toString(), fee: fee.toString() });
    return { status: 'skipped', reason: 'dust' };
  }

  // 4. Balance guard — refuse to spam failing transactions when gas is low.
  const minLamports = params.minKeeperLamports ?? DEFAULT_MIN_KEEPER_LAMPORTS;
  const balance = await getKeeperBalance(params);
  if (balance < minLamports) {
    // Transient-ish: the keeper can be topped up, so release the claim and let
    // a later replay of the same swap establish a fresh claim. Recorded so a
    // human / top-up flow can act on it.
    releaseClaim();
    recordDeadletter(params, now, 'no-keeper-funds', {
      keeperSolLamports: balance,
      minKeeperLamports: minLamports,
    });
    return { status: 'skipped', reason: 'no-keeper-funds' };
  }

  // 5. Resolve the token program (Token-2022 safe) and build the plan.
  let tokenProgram = params.tokenProgram;
  if (!tokenProgram && params.resolveTokenProgram) {
    tokenProgram = await params.resolveTokenProgram();
  }
  const plan = buildSweepPlan({
    keeper: params.keeper.publicKey,
    treasury: params.treasury,
    userAuthority: params.user,
    savingsDestination,
    mint: params.mint,
    decimals: params.decimals,
    outputAmount: params.outputAmount,
    savingsBps,
    tokenProgram,
    computeUnitLimit: params.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT,
    computeUnitPriceMicroLamports:
      params.computeUnitPriceMicroLamports ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
  });

  // 6. Delegate + allowance verification -> recorded skips, never throws.
  const requiredDelegate = params.requiredDelegate ?? params.keeper.publicKey;
  const source = await getTokenAccountView(params, plan.sourceAta);
  if (source === null || source.delegate === null) {
    recordDeadletter(params, now, 'no-delegate', { sourceAta: plan.sourceAta.toBase58() });
    return { status: 'skipped', reason: 'no-delegate' };
  }
  if (!source.delegate.equals(requiredDelegate)) {
    recordDeadletter(params, now, 'no-delegate', {
      actualDelegate: source.delegate.toBase58(),
      requiredDelegate: requiredDelegate.toBase58(),
    });
    return { status: 'skipped', reason: 'no-delegate' };
  }
  if (source.delegatedAmount < plan.totalDebited) {
    recordDeadletter(params, now, 'allowance-too-low', {
      delegatedAmount: source.delegatedAmount.toString(),
      required: plan.totalDebited.toString(),
    });
    return { status: 'skipped', reason: 'allowance-too-low' };
  }

  // 7. Sign, submit, confirm.
  const tx = buildTransactionFromPlan(plan, params.keeper.publicKey);
  let signature: string;
  try {
    if (params.submitTransaction) {
      signature = await params.submitTransaction(tx);
    } else {
      const { blockhash } = await params.connection.getLatestBlockhash('confirmed');
      tx.recentBlockhash = blockhash;
      tx.sign(params.keeper);
      signature = await params.connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: false,
      });
      await params.connection.confirmTransaction(signature, 'confirmed');
    }
  } catch (err) {
    // Transient: RPC hiccup, blockhash expiry, dropped connection. The claim is
    // released so the retry queue can re-enter processSkim.
    releaseClaim();
    throw new SweepTransientError(`submit failed: ${(err as Error).message}`);
  }

  return {
    status: 'swept',
    signature,
    skim: skim.toString(),
    fee: fee.toString(),
  };
}

function recordDeadletter(
  params: ProcessSkimParams,
  now: () => number,
  reason: string,
  detail: Record<string, unknown>,
): void {
  if (!params.deadletter) return;
  params.deadletter.add({
    signature: params.swapSignature,
    user: params.user.toBase58(),
    mint: params.mint.toBase58(),
    outputAmount: params.outputAmount.toString(),
    reason,
    attempts: 1,
    at: now(),
    detail: JSON.stringify(detail),
  });
}

async function getKeeperBalance(params: ProcessSkimParams): Promise<number> {
  if (params.fetchBalance) return params.fetchBalance(params.keeper.publicKey);
  return params.connection.getBalance(params.keeper.publicKey, 'confirmed');
}

async function getTokenAccountView(
  params: ProcessSkimParams,
  sourceAta: PublicKey,
): Promise<TokenAccountView | null> {
  if (params.fetchTokenAccount) {
    try {
      return await params.fetchTokenAccount(sourceAta);
    } catch {
      return null;
    }
  }
  try {
    const acct = await getAccount(
      params.connection,
      sourceAta,
      'confirmed',
      params.tokenProgram ?? TOKEN_PROGRAM_ID,
    );
    return {
      delegate: acct.delegate,
      delegatedAmount: acct.delegatedAmount,
      amount: acct.amount,
    };
  } catch {
    // A missing/unreadable source account means there is no delegate to act on.
    return null;
  }
}
