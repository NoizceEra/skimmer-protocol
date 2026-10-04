/**
 * Deterministic, fully-offline simulation harness.
 *
 *   npm run simulate                      # runs the committed fixtures
 *   npm run simulate -- path/to/scn.json  # or a directory of *.json
 *
 * It prints the FULL computed plan — request, resolved config, skim, fee, the
 * exact instruction sequence and the resulting balances — with ZERO network
 * calls, so the engine can be proven before the chain is funded.
 *
 * Scenario shape:
 * {
 *   "name": "...",
 *   "keeper":   { "pubkey": "<base58>", "solLamports": 50000000 },
 *   "treasury": "<base58>",
 *   "config":   { "minKeeperLamports": 5000000, "computeUnitLimit": 200000,
 *                 "priorityFeeMicroLamports": "1000" },
 *   "userStore": { "<chatId>": { authority, savingsBps, destination, delegate,
 *                                paused, approvedMints } },
 *   "chain":    { "sourceAmount": "1000000000",
 *                 "sourceDelegate": "keeper",         // or a base58 pubkey
 *                 "sourceDelegatedAmount": "500000000",
 *                 "destinationAmount": "0", "treasuryAmount": "0" },
 *   "request":  { "user": "<authority>", "mint": "<base58>",
 *                 "outputAmount": "1000000000", "decimals": 6,
 *                 "signature": "<swap sig>" }
 * }
 */
import * as fs from 'fs';
import * as path from 'path';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { UserRecord, resolveFromStore } from './store';
import {
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_MIN_KEEPER_LAMPORTS,
  DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
  SweepPlan,
  buildSweepPlan,
  computeAmounts,
  processSkim,
} from './engine';
import { InMemoryDedupe } from './dedupe';
import { InMemoryDeadLetter } from './deadletter';
import { createMockConnection, offlineKeeper } from './mocks';

interface Scenario {
  name: string;
  description?: string;
  keeper: { pubkey: string; secretKey?: number[]; solLamports: number };
  treasury: string;
  config?: {
    minKeeperLamports?: number;
    computeUnitLimit?: number;
    priorityFeeMicroLamports?: string | number;
  };
  userStore: Record<string, UserRecord>;
  chain?: {
    sourceAmount?: string;
    sourceDelegate?: string;
    sourceDelegatedAmount?: string;
    sourceMissing?: boolean;
    destinationAmount?: string;
    treasuryAmount?: string;
    sourceTokenProgram?: string;
  };
  request: {
    user: string;
    mint: string;
    outputAmount: string;
    decimals: number;
    signature: string;
  };
}

function describeInstruction(ix: TransactionInstruction): Record<string, unknown> {
  return {
    programId: ix.programId.toBase58(),
    keys: ix.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      signer: k.isSigner,
      writable: k.isWritable,
    })),
    dataBase64: Buffer.from(ix.data).toString('base64'),
  };
}

export async function simulateScenario(scenario: Scenario): Promise<Record<string, unknown>> {
  const keeperKeypair = scenario.keeper.secretKey
    ? Keypair.fromSecretKey(Uint8Array.from(scenario.keeper.secretKey))
    : offlineKeeper();
  const keeper = keeperKeypair.publicKey;
  if (scenario.keeper.pubkey && scenario.keeper.pubkey !== keeper.toBase58()) {
    throw new Error(
      `scenario keeper.pubkey ${scenario.keeper.pubkey} does not match the provided secretKey (${keeper.toBase58()})`,
    );
  }
  const treasury = new PublicKey(scenario.treasury);
  const user = new PublicKey(scenario.request.user);
  const mint = new PublicKey(scenario.request.mint);
  const outputAmount = BigInt(scenario.request.outputAmount);
  const tokenProgram = scenario.chain?.sourceTokenProgram
    ? new PublicKey(scenario.chain.sourceTokenProgram)
    : TOKEN_PROGRAM_ID;
  const config = scenario.config ?? {};
  const minKeeperLamports = config.minKeeperLamports ?? DEFAULT_MIN_KEEPER_LAMPORTS;
  const computeUnitLimit = config.computeUnitLimit ?? DEFAULT_COMPUTE_UNIT_LIMIT;
  const priorityFee = BigInt(
    config.priorityFeeMicroLamports ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
  );

  const resolved = resolveFromStore(scenario.userStore, scenario.request.user);
  const amounts = resolved ? computeAmounts(outputAmount, resolved.savingsBps) : null;

  const sourceAta = getAssociatedTokenAddressSync(mint, user, false, tokenProgram);
  const destinationAta = resolved
    ? getAssociatedTokenAddressSync(mint, new PublicKey(resolved.destination), false, tokenProgram)
    : null;
  const treasuryAta = getAssociatedTokenAddressSync(mint, treasury, false, tokenProgram);

  const sourceBalance = BigInt(scenario.chain?.sourceAmount ?? '0');
  const destinationBalance = BigInt(scenario.chain?.destinationAmount ?? '0');
  const treasuryBalance = BigInt(scenario.chain?.treasuryAmount ?? '0');

  // Build the plan (pure, no network).
  let plan: SweepPlan | null = null;
  if (resolved && !resolved.paused && resolved.savingsBps > 0) {
    plan = buildSweepPlan({
      keeper,
      treasury,
      userAuthority: user,
      savingsDestination: new PublicKey(resolved.destination),
      mint,
      decimals: scenario.request.decimals,
      outputAmount,
      savingsBps: resolved.savingsBps,
      tokenProgram,
      computeUnitLimit,
      computeUnitPriceMicroLamports: priorityFee,
    });
  }

  // Build an offline mock chain that mirrors the scenario balances.
  const accounts: Record<string, any> = {};
  if (!scenario.chain?.sourceMissing) {
    const delegate =
      scenario.chain?.sourceDelegate === 'keeper' || scenario.chain?.sourceDelegate === undefined
        ? keeper
        : new PublicKey(scenario.chain.sourceDelegate);
    accounts[sourceAta.toBase58()] = {
      mint,
      owner: user,
      amount: sourceBalance,
      delegate,
      delegatedAmount: BigInt(scenario.chain?.sourceDelegatedAmount ?? sourceBalance),
    };
  }
  if (destinationAta) {
    accounts[destinationAta.toBase58()] = {
      mint,
      owner: new PublicKey(resolved ? resolved.destination : user.toBase58()),
      amount: destinationBalance,
    };
  }
  accounts[treasuryAta.toBase58()] = { mint, owner: treasury, amount: treasuryBalance };

  const mock = createMockConnection({
    keeper,
    keeperSol: scenario.keeper.solLamports,
    accounts,
    mintPrograms: { [mint.toBase58()]: tokenProgram.toBase58() },
  });

  const deadletter = new InMemoryDeadLetter();
  const outcome = await processSkim({
    // The mock satisfies every Connection method the engine uses; no network.
    connection: mock.connection,
    keeper: keeperKeypair,
    treasury,
    user,
    mint,
    outputAmount,
    decimals: scenario.request.decimals,
    swapSignature: scenario.request.signature,
    resolveUser: (authority) => resolveFromStore(scenario.userStore, authority),
    dedupe: new InMemoryDedupe(24 * 3600 * 1000),
    deadletter,
    minKeeperLamports,
    computeUnitLimit,
    computeUnitPriceMicroLamports: priorityFee,
    tokenProgram,
  });

  const swept = outcome.status === 'swept';
  const skim = plan?.skim ?? 0n;
  const fee = plan?.fee ?? 0n;
  const balancesAfter = {
    source: (sourceBalance - (swept ? skim + fee : 0n)).toString(),
    destination: (destinationBalance + (swept ? skim : 0n)).toString(),
    treasury: (treasuryBalance + (swept ? fee : 0n)).toString(),
    keeperSolLamports: scenario.keeper.solLamports,
  };

  return {
    scenario: scenario.name,
    description: scenario.description,
    network: 'OFFLINE (0 RPC calls)',
    request: {
      user: scenario.request.user,
      mint: scenario.request.mint,
      outputAmount: scenario.request.outputAmount,
      decimals: scenario.request.decimals,
      signature: scenario.request.signature,
    },
    resolvedUser: resolved
      ? {
          chatId: resolved.chatId,
          authority: resolved.authority,
          savingsBps: resolved.savingsBps,
          destination: resolved.destination,
          delegate: resolved.delegate,
          paused: resolved.paused,
        }
      : null,
    amounts: amounts
      ? { skim: amounts.skim.toString(), fee: amounts.fee.toString() }
      : null,
    accounts: {
      sourceAta: sourceAta.toBase58(),
      destinationAta: destinationAta ? destinationAta.toBase58() : null,
      treasuryAta: treasuryAta.toBase58(),
      mint: mint.toBase58(),
      tokenProgram: tokenProgram.toBase58(),
    },
    plan: plan
      ? {
          skim: plan.skim.toString(),
          fee: plan.fee.toString(),
          totalDebited: plan.totalDebited.toString(),
          instructions: plan.instructions.map((item) => ({
            step: item.name,
            ...describeInstruction(item.instruction),
          })),
        }
      : null,
    instructionSequence: plan ? plan.instructions.map((i) => i.name) : [],
    outcome,
    balancesBefore: {
      source: sourceBalance.toString(),
      destination: destinationBalance.toString(),
      treasury: treasuryBalance.toString(),
      keeperSolLamports: scenario.keeper.solLamports,
    },
    balancesAfter,
    deadLetters: deadletter.list(),
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let files: string[] = [];
  if (args.length === 0) {
    const fixturesDir = path.join(__dirname, '..', 'test', 'fixtures');
    files = fs
      .readdirSync(fixturesDir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => path.join(fixturesDir, f));
  } else {
    for (const arg of args) {
      const resolved = path.resolve(arg);
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        for (const f of fs.readdirSync(resolved).filter((f) => f.endsWith('.json')).sort()) {
          files.push(path.join(resolved, f));
        }
      } else {
        files.push(resolved);
      }
    }
  }

  if (files.length === 0) {
    console.error('no scenario files found');
    process.exit(1);
  }

  const results: Record<string, unknown>[] = [];
  for (const file of files) {
    const scenario = JSON.parse(fs.readFileSync(file, 'utf8')) as Scenario;
    results.push(await simulateScenario(scenario));
  }

  process.stdout.write(
    JSON.stringify(results.length === 1 ? results[0] : results, null, 2) + '\n',
  );
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`simulate failed: ${(err as Error).stack ?? err}`);
    process.exit(1);
  });
}
