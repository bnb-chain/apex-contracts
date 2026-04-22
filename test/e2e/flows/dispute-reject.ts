/**
 * Flow B — disputed and rejected (docs/design.md §4.3).
 *
 * createJob → registerJob → setBudget → fund → submit → client dispute →
 * voters voteReject (≥ quorum) → settle → job Rejected; client fully refunded.
 */

import { getAddress } from "viem";

import type { E2EContext } from "../context.js";
import type { FlowResult } from "./index.js";
import { expectBalanceDelta, expectJobStatus, JobStatus } from "../lib/assertions.js";
import { waitForReceipt } from "../lib/wait.js";
import { prepareJob } from "./_helpers.js";

const LABEL = "dispute-reject";

export async function runDisputeReject(ctx: E2EContext): Promise<FlowResult> {
  const { commerce, router, token, wallets, publicClient, log, budget, cfg } = ctx;
  const clientAddr = getAddress(wallets.client.account!.address);

  const clientBefore = (await token.read.balanceOf([clientAddr])) as bigint;

  const { jobId } = await prepareJob(ctx, LABEL);

  // Client raises dispute.
  const policyAsClient = await ctx.asPolicy(wallets.client);
  const disputeHash = await policyAsClient.write.dispute([jobId]);
  await waitForReceipt(publicClient, disputeHash);
  log.tx(disputeHash, "dispute");

  // Voters cast up to `quorum` reject votes.
  const needed = cfg.initialQuorum;
  if (wallets.voters.length < needed) {
    throw new Error(
      `dispute-reject needs ${needed} voter(s); only ${wallets.voters.length} configured.`,
    );
  }
  for (let i = 0; i < needed; i++) {
    const policyAsVoter = await ctx.asPolicy(wallets.voters[i]);
    const voteHash = await policyAsVoter.write.voteReject([jobId]);
    await waitForReceipt(publicClient, voteHash);
    log.tx(voteHash, `voteReject(${i + 1}/${needed})`);
  }

  const settleHash = await router.write.settle([jobId, "0x"]);
  await waitForReceipt(publicClient, settleHash);
  log.tx(settleHash, "settle");

  await expectJobStatus(commerce, jobId, JobStatus.Rejected, `${LABEL}/status`);
  // Client paid `budget` in fund and received `budget` back in reject.
  await expectBalanceDelta(token, clientAddr, clientBefore, 0n, `${LABEL}/client`);

  return { name: LABEL, passed: true, jobId };
}
