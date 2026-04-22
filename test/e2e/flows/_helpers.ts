/**
 * Flow-shared helpers: job creation up to the Open / Funded / Submitted state.
 *
 * Each flow calls `createJob(ctx, { fund, submit })` to get a fresh job id in
 * the requested state. Balances are snapshotted inside individual flows so
 * testnet noise between flows can't pollute assertions.
 */

import { getAddress, keccak256, toBytes } from "viem";

import { waitForReceipt } from "../lib/wait.js";
import type { E2EContext } from "../context.js";

export interface PreparedJob {
  jobId: bigint;
  expiredAt: bigint;
  deliverable: `0x${string}`;
}

export interface PrepareOptions {
  description?: string;
  fund?: boolean;
  submit?: boolean;
}

/**
 * Drive the kernel state machine:
 *   createJob → registerJob → setBudget → [fund] → [submit]
 * Stops before any policy interaction (dispute / vote / settle).
 */
export async function prepareJob(
  ctx: E2EContext,
  flowLabel: string,
  opts: PrepareOptions = {},
): Promise<PreparedJob> {
  const { commerce, router, policy, wallets, publicClient, log, budget } = ctx;
  const providerAddr = getAddress(wallets.provider.account!.address);
  const fund = opts.fund ?? true;
  const submit = opts.submit ?? true;

  const commerceAsClient = await ctx.asCommerce(wallets.client);
  const routerAsClient = await ctx.asRouter(wallets.client);
  const tokenAsClient = await ctx.asToken(wallets.client);
  const commerceAsProvider = await ctx.asCommerce(wallets.provider);

  // createJob
  const now = await ctx.time.now();
  const expiredAt = now + BigInt(ctx.cfg.jobExpirySeconds);
  const createHash = await commerceAsClient.write.createJob([
    providerAddr,
    router.address,
    expiredAt,
    opts.description ?? `E2E ${flowLabel}`,
    router.address,
  ]);
  const createRc = await waitForReceipt(publicClient, createHash);
  const jobId = await extractJobId(ctx, createRc);
  log.step(flowLabel, `createJob jobId=${jobId} expiredAt=${expiredAt}`);
  log.tx(createHash, "createJob");

  // registerJob
  const regHash = await routerAsClient.write.registerJob([jobId, policy.address]);
  await waitForReceipt(publicClient, regHash);
  log.tx(regHash, "registerJob");

  // setBudget
  const budgetHash = await commerceAsClient.write.setBudget([jobId, budget, "0x"]);
  await waitForReceipt(publicClient, budgetHash);
  log.tx(budgetHash, "setBudget");

  if (!fund) {
    return { jobId, expiredAt, deliverable: "0x" as `0x${string}` };
  }

  // fund. Client token balance is assumed pre-loaded: local mints upfront
  // during context build; testnet requires user-side top-up (see preflight).
  const approveHash = await tokenAsClient.write.approve([commerce.address, budget]);
  await waitForReceipt(publicClient, approveHash);
  log.tx(approveHash, "approve");

  const fundHash = await commerceAsClient.write.fund([jobId, budget, "0x"]);
  await waitForReceipt(publicClient, fundHash);
  log.tx(fundHash, "fund");

  if (!submit) {
    return { jobId, expiredAt, deliverable: "0x" as `0x${string}` };
  }

  const deliverable = keccak256(toBytes(`${flowLabel}-deliverable-${jobId}`));
  const submitHash = await commerceAsProvider.write.submit([jobId, deliverable, "0x"]);
  await waitForReceipt(publicClient, submitHash);
  log.tx(submitHash, "submit");

  return { jobId, expiredAt, deliverable };
}

/**
 * Extract the jobId from a createJob receipt by reading the next jobCounter.
 * createJob emits jobId = commerce.jobCounter after increment, so we can just
 * ask the kernel for it. Works uniformly on local + testnet.
 */
async function extractJobId(ctx: E2EContext, _receipt: unknown): Promise<bigint> {
  // Each createJob increments jobCounter then emits with the new value, so
  // the freshly-queried jobCounter IS the created jobId until the next
  // createJob runs. Our runner serialises flows, so this is race-free.
  return (await ctx.commerce.read.jobCounter()) as bigint;
}
