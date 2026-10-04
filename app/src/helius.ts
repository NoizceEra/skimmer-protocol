/**
 * Helius webhook watched-address registration.
 *
 * Helius transaction webhooks are ADDRESS-SCOPED: the webhook only fires for the
 * account addresses listed in its `accountAddresses` array. So every onboarded
 * wallet's authority pubkey must be added to that array, or the listener never
 * hears about that user's trades (queueDepth stays 0 forever). This module is the
 * ONLY place that talks to the Helius management API.
 *
 * Guarantees:
 *  - IDEMPOTENT       — adding an address already present performs no write.
 *  - NON-DESTRUCTIVE  — it READS the current set, merges the new address(es), and
 *                       writes the UNION back. Adding one user can never unwatch
 *                       another (a naive single-element PUT would).
 *  - BEST-EFFORT      — it never throws. Any Helius/network failure is logged and
 *                       swallowed, so onboarding is never blocked or delayed.
 *  - SECRET-SAFE      — the api-key appears only in the request URL and is
 *                       redacted from every log line.
 *
 * Endpoints (verified against the Helius webhooks API reference — see
 * docs/RUN_V1.md §9 for the citation):
 *   GET {base}/v0/webhooks/{webhookId}?api-key=<key>  -> webhook object
 *   PUT {base}/v0/webhooks/{webhookId}?api-key=<key>  -> updated webhook object
 * `base` defaults to https://api.helius.xyz (the domain named in the task); the
 * newer docs also list https://api-mainnet.helius-rpc.com — identical paths/shape.
 */

export interface HeliusWebhookObject {
  webhookID?: string;
  webhookURL?: string;
  webhookType?: string;
  accountAddresses?: unknown[];
  transactionTypes?: string[];
  authHeader?: string;
  encoding?: string;
  txnStatus?: string;
  [key: string]: unknown;
}

export interface HeliusLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** Result of registering a single authority address. */
export interface RegisterResult {
  status: 'added' | 'present' | 'skipped' | 'error';
  added: number;
  /** Watched-address count after the call (0 when we could not read the webhook). */
  total: number;
  reason?: string;
}

/** Result of a batched (backfill) registration. */
export interface SyncResult {
  status: 'ok' | 'skipped' | 'error';
  /** Addresses already watched before this call. */
  before: number;
  /** Addresses watched after this call. */
  after: number;
  /** Net-new addresses added by this call. */
  added: number;
  /** Distinct addresses requested. */
  requested: number;
}

export interface HeliusRegistrar {
  /** True only when both HELIUS_API_KEY and HELIUS_WEBHOOK_ID are configured. */
  readonly enabled: boolean;
  registerAddress(address: string): Promise<RegisterResult>;
  registerAddresses(addresses: string[]): Promise<SyncResult>;
}

export interface HeliusRegistrarOptions {
  apiKey?: string | null;
  webhookId?: string | null;
  /** API base (no trailing slash). Defaults to https://api.helius.xyz. */
  apiBase?: string | null;
  fetchImpl?: typeof fetch;
  logger?: HeliusLogger;
  /** Env source; defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

export const DEFAULT_HELIUS_API_BASE = 'https://api.helius.xyz';

const NOOP_LOGGER: HeliusLogger = { info() {}, warn() {}, error() {} };

/** The writable webhook fields we echo back on PUT so an update never resets them. */
const PRESERVED_FIELDS = [
  'webhookURL',
  'webhookType',
  'transactionTypes',
  'authHeader',
  'encoding',
  'txnStatus',
] as const;

function s(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

export function createHeliusRegistrar(opts: HeliusRegistrarOptions = {}): HeliusRegistrar {
  const env = opts.env ?? process.env;
  const apiKey = s(opts.apiKey ?? env.HELIUS_API_KEY);
  const webhookId = s(opts.webhookId ?? env.HELIUS_WEBHOOK_ID);
  const apiBase = (s(opts.apiBase ?? env.HELIUS_API_BASE) || DEFAULT_HELIUS_API_BASE).replace(/\/+$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const logger = opts.logger ?? NOOP_LOGGER;
  const enabled = apiKey !== '' && webhookId !== '';

  /** Strip the api-key from anything we might log. */
  const redact = (text: string): string => (apiKey ? text.split(apiKey).join('<redacted>') : text);

  // The api-key lives ONLY here, inside the request URL — never in a log line.
  const webhookUrl = (): string =>
    `${apiBase}/v0/webhooks/${encodeURIComponent(webhookId)}?api-key=${encodeURIComponent(apiKey)}`;

  const unique = (addresses: string[]): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const rawAddr of addresses) {
      const addr = s(rawAddr);
      if (!addr || seen.has(addr)) continue;
      seen.add(addr);
      out.push(addr);
    }
    return out;
  };

  function preservedConfig(webhook: HeliusWebhookObject): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of PRESERVED_FIELDS) {
      if (webhook[key] !== undefined) out[key] = webhook[key];
    }
    return out;
  }

  async function readWebhook(): Promise<HeliusWebhookObject> {
    const res = await doFetch(webhookUrl(), { method: 'GET', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`GET webhook failed: HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error('GET webhook returned a non-object body');
    }
    return body as HeliusWebhookObject;
  }

  async function registerAddresses(addresses: string[]): Promise<SyncResult> {
    const requested = unique(addresses);
    if (!enabled) {
      logger.info(
        'helius: address registration skipped — set HELIUS_API_KEY and HELIUS_WEBHOOK_ID to enable',
        { requested: requested.length, webhookId: webhookId || null },
      );
      return { status: 'skipped', before: 0, after: 0, added: 0, requested: requested.length };
    }
    if (requested.length === 0) {
      return { status: 'ok', before: 0, after: 0, added: 0, requested: 0 };
    }

    try {
      const webhook = await readWebhook();
      // Preserve every existing address verbatim (never drop non-strings/others).
      const existing = Array.isArray(webhook.accountAddresses) ? webhook.accountAddresses : [];
      const existingStrings = existing.filter((a): a is string => typeof a === 'string');
      const known = new Set(existingStrings);
      const toAdd = requested.filter((a) => !known.has(a));

      if (toAdd.length === 0) {
        logger.info('helius: all requested addresses already watched (no change)', {
          webhookId,
          watched: existing.length,
          requested: requested.length,
        });
        return {
          status: 'ok',
          before: existing.length,
          after: existing.length,
          added: 0,
          requested: requested.length,
        };
      }

      const merged = [...existing, ...toAdd];
      const payload = { ...preservedConfig(webhook), accountAddresses: merged };
      const res = await doFetch(webhookUrl(), {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) throw new Error(`PUT webhook failed: HTTP ${res.status}`);

      logger.info('helius: watched addresses updated', {
        webhookId,
        added: toAdd.length,
        before: existing.length,
        after: merged.length,
      });
      return {
        status: 'ok',
        before: existing.length,
        after: merged.length,
        added: toAdd.length,
        requested: requested.length,
      };
    } catch (err) {
      logger.warn('helius: address registration failed (continuing; onboarding not blocked)', {
        webhookId,
        error: redact((err as Error)?.message ?? String(err)),
      });
      return { status: 'error', before: 0, after: 0, added: 0, requested: requested.length };
    }
  }

  async function registerAddress(address: string): Promise<RegisterResult> {
    const addr = s(address);
    if (!addr) {
      return { status: 'skipped', added: 0, total: 0, reason: 'empty address' };
    }
    const result = await registerAddresses([addr]);
    if (result.status === 'skipped') {
      return { status: 'skipped', added: 0, total: 0, reason: 'helius not configured' };
    }
    if (result.status === 'error') {
      return { status: 'error', added: 0, total: 0, reason: 'helius request failed' };
    }
    return { status: result.added > 0 ? 'added' : 'present', added: result.added, total: result.after };
  }

  return { enabled, registerAddress, registerAddresses };
}
