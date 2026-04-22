/**
 * Flow A — silence-approve (docs/design.md §4.2).
 *
 * createJob → registerJob → setBudget → fund → submit → wait past window →
 * settle → job Completed; provider receives net, treasury receives fee.
 */

import { getAddress } from "viem";

import type { E2EContext } from "../context.js";
import type { FlowResult } from "./index.js";
import {
  aggregateDeltas,
  expectBalanceDelta,
  expectJobStatus,
  JobStatus,
} from "../lib/assertions.js";
import { waitForReceipt } from "../lib/wait.js";
import { prepareJob } from "./_helpers.js";

const LABEL = "happy";

export async function runHappy(ctx: E2EContext): Promise<FlowResult> {
  const { commerce, router, token, wallets, publicClient, log, budget, cfg } = ctx;
  const clientAddr = getAddress(wallets.client.account!.address);
  const providerAddr = getAddress(wallets.provider.account!.address);
  const treasuryAddr = getAddress((await commerce.read.platformTreasury()) as `0x${string}`);
  const feeBP = (await commerce.read.platformFeeBP()) as bigint;
  const fee = (budget * feeBP) / 10_000n;
  const net = budget - fee;

  // Three logical balance moves happen in this flow:
  //   client   : −budget         (fund)
  //   provider : +net            (complete)
  //   treasury : +fee            (complete)
  // `aggregateDeltas` sums these by distinct address so a single EOA acting
  // as multiple roles (e.g. client == provider in the 1-key testnet setup)
  // gets the algebraically correct combined delta.
  const expected = aggregateDeltas([
    [clientAddr, -budget],
    [providerAddr, net],
    [treasuryAddr, fee],
  ]);

  const before = new Map<`0x${string}`, bigint>();
  for (const addr of expected.keys()) {
    before.set(addr, (await token.read.balanceOf([addr])) as bigint);
  }

  const { jobId } = await prepareJob(ctx, LABEL);

  log.step(LABEL, `wait ${cfg.disputeWindowSeconds + cfg.slackSeconds}s past dispute window`);
  await ctx.time.advanceSeconds(cfg.disputeWindowSeconds + cfg.slackSeconds);

  const settleHash = await router.write.settle([jobId, "0x"]);
  await waitForReceipt(publicClient, settleHash);
  log.tx(settleHash, "settle");

  await expectJobStatus(commerce, jobId, JobStatus.Completed, `${LABEL}/status`);

  for (const [addr, delta] of expected) {
    await expectBalanceDelta(token, addr, before.get(addr)!, delta, `${LABEL}/${addr}`);
  }

  return { name: LABEL, passed: true, jobId };
}
