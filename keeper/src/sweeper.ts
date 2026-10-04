/**
 * Backwards-compatibility shim.
 *
 * The sweep engine now lives in ./engine.ts. This module keeps the historical
 * import path (`keeper/src/sweeper`) working and re-exports the original public
 * names. The old flat `processSkim({...})` call shape remains valid: `engine`'s
 * `processSkim` accepts the same fields (plus optional infrastructure).
 *
 * Prefer importing from './engine' in new code.
 */
export {
  PROTOCOL_FEE_BPS,
  BPS_DENOM,
  MAX_SAVINGS_BPS,
  DEFAULT_MIN_KEEPER_LAMPORTS,
  DEFAULT_COMPUTE_UNIT_LIMIT,
  DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
  SweepTransientError,
  skimFor,
  computeAmounts,
  buildSweepPlan,
  buildTransactionFromPlan,
  processSkim,
} from './engine';
export type {
  SkipReason,
  SweepResult,
  NamedInstruction,
  SweepPlan,
  BuildPlanInput,
  ProcessSkimParams,
  TokenAccountView,
} from './engine';

/** In-memory dedupe for callers that have no on-disk store configured. */
export { InMemoryDedupe } from './dedupe';
