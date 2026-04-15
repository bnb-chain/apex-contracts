export const JobStatus = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

export const DEFAULT_BUDGET = BigInt(10_000_000);
export const DEFAULT_LIVENESS = BigInt(1800);
export const DEFAULT_BOND = BigInt(1_000_000_000_000_000_000);
export const TRUSTED_FORWARDER = "0x0000000000000000000000000000000000000001" as const;
