/**
 * Centralised, dependency-light configuration for the skim-listener.
 *
 * Frozen interface contract v1 env var names:
 *   WEBHOOK_PORT          default 4000
 *   WEBHOOK_SECRET        shared secret the inbound Helius webhook must present
 *   KEEPER_URL            e.g. http://localhost:5001
 *   KEEPER_SHARED_SECRET  bearer secret sent to the keeper
 *   FORWARD_RETRIES       optional, default 5
 *
 * Optional extras (documented in .env.example, safe to omit):
 *   LISTENER_DATA_DIR     overrides where the durable queue files live
 *   WEBHOOK_RATE_LIMIT_PER_IP / WEBHOOK_RATE_LIMIT_GLOBAL / WEBHOOK_RATE_WINDOW_MS
 */

export interface AppConfig {
  webhookPort: number;
  webhookSecret: string;
  keeperUrl: string;
  keeperSharedSecret: string;
  forwardRetries: number;
  dataDir?: string;
  rateLimitPerIp: number;
  rateLimitGlobal: number;
  rateWindowMs: number;
}

function toInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const rawPort = env.WEBHOOK_PORT ?? env.PORT ?? '4000';
  const rawRetries = env.FORWARD_RETRIES ?? '5';
  return {
    webhookPort: toInt(rawPort, 4000, 1, 65535),
    webhookSecret: typeof env.WEBHOOK_SECRET === 'string' ? env.WEBHOOK_SECRET : '',
    keeperUrl: stripTrailingSlashes(typeof env.KEEPER_URL === 'string' ? env.KEEPER_URL : ''),
    keeperSharedSecret:
      typeof env.KEEPER_SHARED_SECRET === 'string' ? env.KEEPER_SHARED_SECRET : '',
    forwardRetries: toInt(rawRetries, 5, 1, 50),
    dataDir: typeof env.LISTENER_DATA_DIR === 'string' && env.LISTENER_DATA_DIR ? env.LISTENER_DATA_DIR : undefined,
    rateLimitPerIp: toInt(env.WEBHOOK_RATE_LIMIT_PER_IP ?? '60', 60, 1, 100000),
    rateLimitGlobal: toInt(env.WEBHOOK_RATE_LIMIT_GLOBAL ?? '600', 600, 1, 1000000),
    rateWindowMs: toInt(env.WEBHOOK_RATE_WINDOW_MS ?? '60000', 60000, 1000, 3600000),
  };
}
