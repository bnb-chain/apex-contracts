/**
 * Flow E — funded but provider never submits (docs/design.md §4.6).
 *
 * createJob → registerJob → setBudget → fund → (no submit) → wait past
 * expiredAt → claimRefund → Expired; client fully refunded.
 */

import { getAddress } from "viem";

import type { E2EContext } from "../context.js";
import type { FlowResult } from "./index.js";
import { expectBalanceDelta, expectJobStatus, JobStatus } from "../lib/assertions.js";
import { waitForReceipt } from "../lib/wait.js";
import { prepareJob } from "./_helpers.js";

const LABEL = "never-submit";

export async function runNeverSubmit(ctx: E2EContext): Promise<FlowResult> {
  const { commerce, token, wallets, publicClient, log } = ctx;
  const clientAddr = getAddress(wallets.client.account!.address);

  const clientBefore = (await token.read.balanceOf([clientAddr])) as bigint;

  const { jobId, expiredAt } = await prepareJob(ctx, LABEL, { submit: false });

  log.step(LABEL, `wait until expiredAt=${expiredAt}`);
  await ctx.time.waitUntilTs(expiredAt + 1n, LABEL);

  const refundHash = await commerce.write.claimRefund([jobId]);
  await waitForReceipt(publicClient, refundHash);
  log.tx(refundHash, "claimRefund");

  await expectJobStatus(commerce, jobId, JobStatus.Expired, `${LABEL}/status`);
  await expectBalanceDelta(token, clientAddr, clientBefore, 0n, `${LABEL}/client`);

  return { name: LABEL, passed: true, jobId };
}
