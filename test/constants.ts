export const JobStatus = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

export const DEFAULT_BUDGET = BigInt(10_000_000);
export const TRUSTED_FORWARDER = "0x0000000000000000000000000000000000000001" as const;

// OptimisticPolicy defaults (used by tests)
export const DISPUTE_WINDOW_SECONDS = BigInt(3 * 24 * 3600);   // 3 days
export const VOTE_QUORUM = 3;

// Verdict values from IPolicy
export const Verdict = {
  Pending: 0,
  Approve: 1,
  Reject: 2,
} as const;
