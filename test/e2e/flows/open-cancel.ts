/**
 * Flow D — cancel while Open (docs/design.md §4.5).
 *
 * createJob (no register, no fund) → client calls reject → job Rejected.
 * No escrow ever moved, so no balance assertions are needed; we only verify
 * the terminal status.
 */

import type { E2EContext } from "../context.js";
import type { FlowResult } from "./index.js";
import { expectJobStatus, JobStatus } from "../lib/assertions.js";
import { waitForReceipt } from "../lib/wait.js";

const LABEL = "open-cancel";
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

export async function runOpenCancel(ctx: E2EContext): Promise<FlowResult> {
  const { commerce, router, wallets, publicClient, log, cfg } = ctx;

  const commerceAsClient = await ctx.asCommerce(wallets.client);

  const now = await ctx.time.now();
  const expiredAt = now + BigInt(cfg.jobExpirySeconds);
  const createHash = await commerceAsClient.write.createJob([
    wallets.provider.account!.address,
    router.address,
    expiredAt,
    `E2E ${LABEL}`,
    router.address,
  ]);
  await waitForReceipt(publicClient, createHash);
  const jobId = (await commerce.read.jobCounter()) as bigint;
  log.step(LABEL, `createJob jobId=${jobId}`);
  log.tx(createHash, "createJob");

  const rejectHash = await commerceAsClient.write.reject([jobId, ZERO_BYTES32, "0x"]);
  await waitForReceipt(publicClient, rejectHash);
  log.tx(rejectHash, "reject (Open)");

  await expectJobStatus(commerce, jobId, JobStatus.Rejected, `${LABEL}/status`);
  return { name: LABEL, passed: true, jobId };
}
