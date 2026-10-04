/**
 * Skim Protocol v1 — single-process runner entrypoint.
 *
 * Boots ONE process that runs the Telegram bot, the listener webhook (one public
 * port) and the keeper engine (in-process). Fails fast with a clear message when
 * a required env var is missing.
 */
import * as path from 'path';
import dotenv from 'dotenv';

import { ConfigError, REQUIRED_VARS, loadConfig } from './config';
import { buildRunner } from './runner';

function loadEnvFile(): void {
  // app/.env works from both src/ and dist/ (both are one level under app/).
  dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
  // Fall back to a .env in the current working directory.
  dotenv.config();
}

async function main(): Promise<void> {
  loadEnvFile();

  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    const detail = err instanceof ConfigError ? err.message : (err as Error).message;
    console.error(`[skim-v1] FATAL configuration error: ${detail}`);
    console.error(`[skim-v1] required env: ${REQUIRED_VARS.join(', ')} (see app/.env.example)`);
    process.exit(1);
  }

  // Make the single env surface authoritative for the bot module, which reads
  // these at import time. (dotenv loaded app/.env above.)
  process.env.PROGRAM_ID = config.programId;
  process.env.PROTOCOL_FEE_BPS = String(config.protocolFeeBps);
  process.env.RPC_URL = config.rpcUrl;
  process.env.TREASURY = config.treasury.toBase58();
  process.env.USER_STORE_PATH = config.userStorePath;

  const runner = buildRunner(config, { logger: console });

  const { port } = await runner.start();
  console.log('──────────────────────────────────────────────');
  console.log('[skim-v1] single-process v1 is up');
  console.log(`[skim-v1] public port : ${port}  (GET /health, POST /webhook/tx)`);
  console.log(`[skim-v1] keeper pubkey: ${runner.keeperPubkey}`);
  console.log(`[skim-v1] user store  : ${config.userStorePath}`);
  console.log('[skim-v1] keeper engine: in-process (no HTTP hop)');

  try {
    const sol = await runner.keeperBalance();
    console.log(`[skim-v1] keeper SOL balance: ${sol} lamports`);
    if (sol < config.minKeeperLamports) {
      console.warn(
        `[skim-v1] WARNING: keeper SOL ${sol} < floor ${config.minKeeperLamports}; ` +
          'sweeps will return no-keeper-funds until funded.',
      );
    }
  } catch (err) {
    console.warn(`[skim-v1] could not read keeper SOL balance: ${(err as Error).message}`);
  }
  console.log('──────────────────────────────────────────────');

  let shuttingDown = false;
  const onSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[skim-v1] received ${signal}, shutting down`);
    void runner
      .shutdown()
      .then(() => process.exit(0))
      .catch((err) => {
        console.error(`[skim-v1] shutdown error: ${(err as Error).message}`);
        process.exit(1);
      });
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));
}

if (require.main === module) {
  void main();
}

export { main };
