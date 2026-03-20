export const Status = {
  None: 0,
  Open: 1,
  Funded: 2,
  Submitted: 3,
  Completed: 4,
  Rejected: 5,
  Expired: 6,
} as const;

export const MIN_BUDGET = BigInt(1_000_000);
export const DEFAULT_BUDGET = BigInt(10_000_000);
export const DEFAULT_LIVENESS = BigInt(1800); // 30 minutes
export const DEFAULT_BOND = BigInt(1_000_000_000_000_000_000); // 1e18
