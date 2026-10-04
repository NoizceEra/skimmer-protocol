import { Connection, PublicKey } from '@solana/web3.js';
import * as path from 'node:path';

/**
 * Bounded, user-signed setup transaction delivery.
 *
 * The bot NEVER holds keys and NEVER signs. It builds an UNSIGNED SPL `Approve`
 * for the keeper delegate on the user's own ATA (via the skim-sdk's
 * `buildSetupBlob`), serialises it to base64, and hands the user something they
 * can sign in their own wallet. Nothing here can move funds on its own.
 */

let sdkCache: any = null;

/** Resolve the built skim-sdk (dist/index.js) without a workspace install. */
export function loadSdk(): any {
  if (sdkCache) return sdkCache;
  const candidates: string[] = [];
  if (process.env.SKIM_SDK_PATH) candidates.push(process.env.SKIM_SDK_PATH);
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, 'sdk', 'dist', 'index.js'));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const abs = path.resolve(candidate);
    if (seen.has(abs)) continue;
    seen.add(abs);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      sdkCache = require(abs);
      return sdkCache;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    'skim-sdk is not built — run `npm --prefix sdk run build` (or set SKIM_SDK_PATH to sdk/dist/index.js)',
  );
}

export function sdkAvailable(): boolean {
  try {
    loadSdk();
    return true;
  } catch {
    return false;
  }
}

export interface MintSetupPlan {
  mint: string;
  decimals: number;
  base64: string;
  bytesLen: number;
  allowanceBaseUnits: string;
  expectedTradeSize: string;
  topUps: number;
}

export interface BuildSetupParams {
  user: string;
  keeperDelegate: string;
  savingsBps: number;
  mints: string[];
  topUps?: number;
  maxUiAmount?: string;
}

/** Read a mint's decimals on-chain (needed for a decimals-aware allowance). */
export async function fetchMintDecimals(connection: Connection, mint: string): Promise<number> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const data: any = (info as any)?.value?.data;
  const decimals =
    data && typeof data === 'object' && 'parsed' in data ? data.parsed?.info?.decimals : undefined;
  if (typeof decimals !== 'number') {
    throw new Error(`could not read decimals for mint ${mint} — is it a valid SPL mint?`);
  }
  return decimals;
}

/** Build one unsigned approval tx per mint, as base64 for the user to sign. */
export async function buildSetupPlans(
  connection: Connection,
  p: BuildSetupParams,
): Promise<MintSetupPlan[]> {
  const sdk = loadSdk();
  const out: MintSetupPlan[] = [];
  for (const mint of p.mints) {
    const decimals = await fetchMintDecimals(connection, mint);
    const blob = await sdk.buildSetupBlob(
      {
        user: new PublicKey(p.user),
        keeperDelegate: new PublicKey(p.keeperDelegate),
        mint: new PublicKey(mint),
        decimals,
        savingsBps: p.savingsBps,
        topUps: p.topUps,
        maxUiAmount: p.maxUiAmount,
      },
      connection,
    );
    out.push({
      mint,
      decimals,
      base64: blob.base64,
      bytesLen: blob.bytesLen,
      allowanceBaseUnits: blob.allowance.toString(),
      expectedTradeSize: blob.expectedTradeSize.toString(),
      topUps: blob.topUps,
    });
  }
  return out;
}

function baseUnitsToUi(amount: string, decimals: number): string {
  let a: bigint;
  try {
    a = BigInt(amount);
  } catch {
    return amount;
  }
  const scale = 10n ** BigInt(decimals);
  const whole = a / scale;
  const frac = a % scale;
  if (frac === 0n) return whole.toString();
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${whole}.${fracStr}`;
}

/** Plain-text message the bot sends (no Markdown entities — safe for base64). */
export function formatSetupMessage(
  plan: MintSetupPlan,
  ctx: { user: string; savingsBps: number; delegate: string },
): string {
  const savingsPct = ctx.savingsBps / 100;
  const ui = baseUnitsToUi(plan.allowanceBaseUnits, plan.decimals);
  return [
    `🚀 ONE-TIME APPROVAL — you sign this, Skimmer never does`,
    ``,
    `Mint: ${plan.mint} (${plan.decimals} decimals)`,
    `Delegate (keeper): ${ctx.delegate}`,
    `Bounded allowance: ${plan.allowanceBaseUnits} base units (~${ui} tokens)`,
    `Covers ~${plan.topUps} trades of 1 token: your ${savingsPct}% skim + the 0.4% protocol fee per trade.`,
    ``,
    `🔒 This is NOT unlimited (never u64::MAX) and it is REVOCABLE at any time.`,
    `🔑 The transaction is unsigned — your wallet is the only signer.`,
    ``,
    `Sign in any Solana wallet/tool that can sign a raw (base64) transaction:`,
    ``,
    plan.base64,
    ``,
    `To REVOKE later: sign an SPL Revoke (or approve 0) on this same token account, or re-run /spawn_wallet.`,
  ].join('\n');
}

export { baseUnitsToUi };

export interface WalletApprovalItem {
  mint: string;
  tokenAccount: string;
  decimals: number;
  allowanceBaseUnits: string;
}
export interface WalletApprovalTx {
  /** base64 of one UNSIGNED tx (fee payer = user) containing up to APPROVALS_PER_TX SPL Approves. */
  base64: string;
  items: WalletApprovalItem[];
}
export const APPROVALS_PER_TX = 6;

/**
 * "Trade any token" setup: scan EVERY classic-SPL token account the wallet owns and
 * build bounded, revocable Approves (one per account) for the keeper delegate,
 * batched into a few unsigned txs. SPL delegation is per token account, so a token
 * the wallet has never held can only be approved once its account exists — the app
 * prompts for that the first time such a token shows up (see keeper skip reason).
 * Pass `onlyMints` to approve just specific mints (used by that prompt).
 */
export async function buildWalletApprovals(
  connection: Connection,
  p: {
    user: string;
    keeperDelegate: string;
    savingsBps: number;
    topUps?: number;
    maxUiAmount?: string;
    onlyMints?: string[];
  },
): Promise<WalletApprovalTx[]> {
  const sdk = loadSdk();
  const owner = new PublicKey(p.user);
  const delegate = new PublicKey(p.keeperDelegate);
  const programId: PublicKey = sdk.TOKEN_PROGRAM_ID;
  const accounts = await connection.getParsedTokenAccountsByOwner(owner, { programId });
  const only = p.onlyMints ? new Set(p.onlyMints) : null;

  const planned: { item: WalletApprovalItem; ix: any }[] = [];
  const seen = new Set<string>();
  for (const { pubkey, account } of accounts.value) {
    const info: any = (account.data as any)?.parsed?.info;
    if (!info?.mint || typeof info.tokenAmount?.decimals !== 'number') continue;
    if (info.state === 'frozen') continue;
    if (only && !only.has(info.mint)) continue;
    const key = pubkey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    const plan = sdk.planSetup({
      user: owner,
      keeperDelegate: delegate,
      mint: new PublicKey(info.mint),
      userAta: pubkey,
      decimals: info.tokenAmount.decimals,
      savingsBps: p.savingsBps,
      topUps: p.topUps,
      maxUiAmount: p.maxUiAmount,
    });
    planned.push({
      item: {
        mint: info.mint,
        tokenAccount: key,
        decimals: info.tokenAmount.decimals,
        allowanceBaseUnits: plan.allowance.toString(),
      },
      ix: plan.transaction.instructions[0],
    });
  }
  if (planned.length === 0) return [];

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const { Transaction } = await import('@solana/web3.js');
  const out: WalletApprovalTx[] = [];
  for (let i = 0; i < planned.length; i += APPROVALS_PER_TX) {
    const chunk = planned.slice(i, i + APPROVALS_PER_TX);
    const tx = new Transaction();
    for (const c of chunk) tx.add(c.ix);
    tx.feePayer = owner;
    tx.recentBlockhash = blockhash;
    out.push({
      base64: tx
        .serialize({ requireAllSignatures: false, verifySignatures: false })
        .toString('base64'),
      items: chunk.map((c) => c.item),
    });
  }
  return out;
}
