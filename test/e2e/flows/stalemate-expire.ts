/**
 * Flow C — stalemate → expired (docs/design.md §4.4).
 *
 * createJob → registerJob → setBudget → fund → submit → dispute (no votes) →
 * settle reverts NotDecided → wait past expiredAt → claimRefund → Expired.
 *
 * Verifies: policy stays Pending while disputed with 0 reject votes, and
 * the kernel's `claimRefund` escape hatch works even with a live (but
 * stuck) policy + router behind the job.
 */

import { getAddress } from "viem";

import type { E2EContext } from "../context.js";
import type { FlowResult } from "./index.js";
import { expectBalanceDelta, expectJobStatus, JobStatus } from "../lib/assertions.js";
import { waitForReceipt } from "../lib/wait.js";
import { prepareJob } from "./_helpers.js";

const LABEL = "stalemate-expire";

export async function runStalemateExpire(ctx: E2EContext): Promise<FlowResult> {
  const { commerce, router, token, wallets, publicClient, log } = ctx;
  const clientAddr = getAddress(wallets.client.account!.address);

  const clientBefore = (await token.read.balanceOf([clientAddr])) as bigint;

  const { jobId, expiredAt } = await prepareJob(ctx, LABEL);

  const policyAsClient = await ctx.asPolicy(wallets.client);
  const disputeHash = await policyAsClient.write.dispute([jobId]);
  await waitForReceipt(publicClient, disputeHash);
  log.tx(disputeHash, "dispute");

  // Settle with zero reject votes must revert NotDecided.
  try {
    await router.simulate.settle([jobId, "0x"]);
    throw new Error("settle should have reverted with NotDecided");
  } catch (err: any) {
    // viem buries the custom-error name in several places depending on the
    // transport; inspect all of them before giving up.
    const blob = JSON.stringify({
      short: err?.shortMessage,
      message: err?.message,
      cause: err?.cause?.message,
      details: err?.details,
      name: err?.cause?.data?.errorName ?? err?.data?.errorName,
    });
    if (!blob.includes("NotDecided")) {
      throw new Error(`expected NotDecided revert, got: ${blob}`);
    }
    log.step(LABEL, "settle correctly reverts NotDecided");
  }

  log.step(LABEL, `wait until expiredAt=${expiredAt}`);
  await ctx.time.waitUntilTs(expiredAt + 1n, LABEL);

  const refundHash = await commerce.write.claimRefund([jobId]);
  await waitForReceipt(publicClient, refundHash);
  log.tx(refundHash, "claimRefund");

  await expectJobStatus(commerce, jobId, JobStatus.Expired, `${LABEL}/status`);
  await expectBalanceDelta(token, clientAddr, clientBefore, 0n, `${LABEL}/client`);

  return { name: LABEL, passed: true, jobId };
}
