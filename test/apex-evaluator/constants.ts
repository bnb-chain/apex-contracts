// Re-exports V1 shared constants and adds UMA-only constants for legacy tests.
// Legacy UMA-based evaluator — not used by V1 Router path.

export { JobStatus, DEFAULT_BUDGET, TRUSTED_FORWARDER } from "../constants.js";

export const DEFAULT_LIVENESS = BigInt(1800);
export const DEFAULT_BOND = BigInt(1_000_000_000_000_000_000);
