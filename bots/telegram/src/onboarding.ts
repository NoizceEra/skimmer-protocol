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
