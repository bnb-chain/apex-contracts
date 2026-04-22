/**
 * Minimal assertion helpers for the E2E runner. Errors use a dedicated class
 * so the runner can distinguish "flow business logic failed" from "RPC /
 * wallet / config issue".
 */

import { getAddress } from "viem";

export class E2EAssertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2EAssertError";
  }
}

export const JobStatus = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

export type JobStatusName = keyof typeof JobStatus;

export async function expectJobStatus(
  commerce: any,
  jobId: bigint,
  expected: (typeof JobStatus)[JobStatusName],
  label: string,
): Promise<void> {
  const job = await commerce.read.getJob([jobId]);
  if (job.status !== expected) {
    throw new E2EAssertError(
      `${label}: expected status=${expected} but got ${job.status} for jobId=${jobId}`,
    );
  }
}

export async function expectBalanceDelta(
  token: any,
  addr: `0x${string}`,
  before: bigint,
  expectedDelta: bigint,
  label: string,
): Promise<bigint> {
  const after = (await token.read.balanceOf([getAddress(addr)])) as bigint;
  const actual = after - before;
  if (actual !== expectedDelta) {
    throw new E2EAssertError(
      `${label}: balance delta for ${addr} expected=${expectedDelta} actual=${actual}`,
    );
  }
  return after;
}

/**
 * Build a per-address expected-delta map from `(addr, delta)` contributions.
 * Addresses that appear multiple times (because a single EOA plays multiple
 * roles — client == provider, treasury == owner, etc.) get their deltas
 * summed, so the assertion remains correct under any role collapse.
 */
export function aggregateDeltas(
  contributions: Array<[`0x${string}`, bigint]>,
): Map<`0x${string}`, bigint> {
  const out = new Map<`0x${string}`, bigint>();
  for (const [raw, d] of contributions) {
    const addr = getAddress(raw);
    out.set(addr, (out.get(addr) ?? 0n) + d);
  }
  return out;
}

export function expectEq<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new E2EAssertError(`${label}: expected=${expected} actual=${actual}`);
  }
}
