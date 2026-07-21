import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, toBytes } from "viem";

import {
  JobStatus,
  DEFAULT_BUDGET,
  DEFAULT_DISPUTE_WINDOW,
  deployStack,
  advanceSeconds,
  createFundedSubmittedJob,
} from "./helpers.js";

// Top-level await, NOT an async describe: bun's collector does not await an
// async describe callback, so tests registered after its first `await` are
// silently dropped when multiple test files load in parallel.
const { viem } = await network.connect();
const [deployerW, clientW, providerW, treasuryW, voter1W, voter2W] =
  await viem.getWalletClients();
const deployer = getAddress(deployerW.account.address);
const client = getAddress(clientW.account.address);
const provider = getAddress(providerW.account.address);
const treasury = getAddress(treasuryW.account.address);
const voter1 = getAddress(voter1W.account.address);
const voter2 = getAddress(voter2W.account.address);

describe("End-to-end lifecycle", () => {

  async function setup(platformFeeBP: bigint = 0n) {
    const ctx = await deployStack(viem, {
      owner: deployer,
      treasury,
      voters: [voter1, voter2],
    });
    if (platformFeeBP > 0n) {
      await ctx.commerce.write.setPlatformFee([platformFeeBP, treasury]);
    }
    return ctx;
  }

  async function asCommerce(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("AgenticCommerceUpgradeable", addr, { client: { wallet } });
  }
  async function asRouter(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("EvaluatorRouterUpgradeable", addr, { client: { wallet } });
  }
  async function asPolicy(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("OptimisticPolicy", addr, { client: { wallet } });
  }

  // ==================================================================
  // Happy path: silent approval
  // ==================================================================

  it("Approve path: create → register → fund → submit → wait → settle → provider paid", async () => {
    const ctx = await setup(250n); // 2.5% platform fee
    const { jobId } = await createFundedSubmittedJob(viem, {
      ...ctx,
      client: clientW,
      provider: providerW,
    });

    // Silence for the duration of the window triggers auto-approve.
    await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);
    await ctx.router.write.settle([jobId, "0x"]);

    const fee = (DEFAULT_BUDGET * 250n) / 10_000n;
    const net = DEFAULT_BUDGET - fee;
    assert.equal(await ctx.token.read.balanceOf([provider]), net);
    assert.equal(await ctx.token.read.balanceOf([treasury]), fee);
    assert.equal((await ctx.commerce.read.getJob([jobId])).status, JobStatus.Completed);
  });

  // ==================================================================
  // Disputed path: quorum reject
  // ==================================================================

  it("Reject path: dispute + quorum of reject votes → client refunded", async () => {
    const ctx = await setup();
    const { jobId } = await createFundedSubmittedJob(viem, {
      ...ctx,
      client: clientW,
      provider: providerW,
    });

    const policyAsClient = await asPolicy(ctx.policy.address, clientW);
    await policyAsClient.write.dispute([jobId]);

    const policyAsV1 = await asPolicy(ctx.policy.address, voter1W);
    const policyAsV2 = await asPolicy(ctx.policy.address, voter2W);
    await policyAsV1.write.voteReject([jobId]);
    await policyAsV2.write.voteReject([jobId]);

    // Settle from anyone (permissionless).
    await ctx.router.write.settle([jobId, "0x"]);

    assert.equal(await ctx.token.read.balanceOf([client]), DEFAULT_BUDGET);
    assert.equal((await ctx.commerce.read.getJob([jobId])).status, JobStatus.Rejected);
  });

  // ==================================================================
  // Pending: settle reverts with NotDecided
  // ==================================================================

  it("NotDecided: dispute raised but quorum not reached → settle reverts", async () => {
    const ctx = await setup();
    const { jobId } = await createFundedSubmittedJob(viem, {
      ...ctx,
      client: clientW,
      provider: providerW,
    });

    const policyAsClient = await asPolicy(ctx.policy.address, clientW);
    await policyAsClient.write.dispute([jobId]);
    const policyAsV1 = await asPolicy(ctx.policy.address, voter1W);
    await policyAsV1.write.voteReject([jobId]); // 1 < quorum of 2

    await assert.rejects(ctx.router.write.settle([jobId, "0x"]), /NotDecided/);
  });

  // ==================================================================
  // Expiry escape hatch
  // ==================================================================

  it("Expiry escape hatch: claimRefund returns funds without router involvement", async () => {
    const ctx = await setup();
    // `expiresIn` MUST satisfy `now + disputeWindow <= expiredAt` after the
    // audit L07 fix in {OptimisticPolicy.onSubmitted}. Use 2x default
    // disputeWindow so submission succeeds and we still race past expiry.
    const expiresIn = DEFAULT_DISPUTE_WINDOW * 2n;
    const { jobId } = await createFundedSubmittedJob(viem, {
      ...ctx,
      client: clientW,
      provider: providerW,
      expiresIn,
    });
    // Don't settle; fast-forward past expiry.
    await advanceSeconds(viem, Number(expiresIn) + 100);

    // Even paused Router + paused Commerce cannot block this call per plan §6 R6.
    await ctx.router.write.pause();
    await ctx.commerce.write.pause();

    await ctx.commerce.write.claimRefund([jobId]);
    assert.equal(await ctx.token.read.balanceOf([client]), DEFAULT_BUDGET);
  });

  // ==================================================================
  // Router pause is an emergency brake for settle + registerJob
  // ==================================================================

  it("Router pause mid-flight: settle and new registrations are both blocked; unpause restores flow", async () => {
    const ctx = await setup();
    const { jobId } = await createFundedSubmittedJob(viem, {
      ...ctx,
      client: clientW,
      provider: providerW,
    });
    await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);

    await ctx.router.write.pause();

    // settle is blocked while paused (emergency brake for buggy verdicts).
    await assert.rejects(ctx.router.write.settle([jobId, "0x"]), /EnforcedPause/);

    // New registrations are also blocked.
    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();
    const commerceAsClient = await asCommerce(ctx.commerce.address, clientW);
    await commerceAsClient.write.createJob([
      provider,
      ctx.router.address,
      block.timestamp + 3600n,
      "",
      ctx.router.address,
    ]);
    const routerAsClient = await asRouter(ctx.router.address, clientW);
    await assert.rejects(
      routerAsClient.write.registerJob([2n, ctx.policy.address]),
      /EnforcedPause/,
    );

    // Kernel hooks (beforeAction/afterAction) remain operational, so submit on
    // a second already-registered job still succeeds while router is paused.
    // (Covered implicitly by the happy/dispute paths above; not repeated here.)

    // Unpause → in-flight job settles normally.
    await ctx.router.write.unpause();
    await ctx.router.write.settle([jobId, "0x"]);
    assert.equal((await ctx.commerce.read.getJob([jobId])).status, JobStatus.Completed);
  });

  // ==================================================================
  // Seller-side zero price through the full Router / Policy stack.
  // Proves the Route A design claim: a free job stays on the normal
  // Funded main-trunk, keeps the Router's beforeAction(FUND) gate on
  // path, and reconciles jobInflightCount via the existing terminal
  // paths — no Router / Policy / claimRefund change needed.
  // ==================================================================

  async function createRoutedZeroPriceJob(ctx: any, expiresIn: bigint = 86_400n) {
    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();
    const expiredAt = block.timestamp + expiresIn;

    const commerceAsClient = await asCommerce(ctx.commerce.address, clientW);
    const routerAsClient = await asRouter(ctx.router.address, clientW);
    await commerceAsClient.write.createJob([
      provider,
      ctx.router.address,
      expiredAt,
      "Zero-price integration job",
      ctx.router.address,
    ]);
    const jobId = 1n;
    await routerAsClient.write.registerJob([jobId, ctx.policy.address]);

    // Provider offers the job for free; client then funds it WITHOUT any
    // token mint or approval — a zero-price fund must move no tokens.
    const commerceAsProvider = await asCommerce(ctx.commerce.address, providerW);
    await commerceAsProvider.write.setBudget([jobId, 0n, "0x"]);
    await commerceAsClient.write.fund([jobId, 0n, "0x"]);
    return { jobId, expiredAt };
  }

  it("Zero-price approve path: routed free job funds (no transfer), submits, settles to Completed", async () => {
    // Non-zero fee to prove the fee math zeroes out for a free job.
    const ctx = await setup(500n);
    const { jobId } = await createRoutedZeroPriceJob(ctx);

    // fund moved to Funded with no escrow, and the Router counted it in-flight.
    assert.equal((await ctx.commerce.read.getJob([jobId])).status, JobStatus.Funded);
    assert.equal(await ctx.token.read.balanceOf([ctx.commerce.address]), 0n);
    assert.equal(await ctx.router.read.inflightJobCount(), 1n);

    const commerceAsProvider = await asCommerce(ctx.commerce.address, providerW);
    await commerceAsProvider.write.submit([jobId, keccak256(toBytes("free-deliverable")), "0x"]);

    await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);
    await ctx.router.write.settle([jobId, "0x"]);

    assert.equal((await ctx.commerce.read.getJob([jobId])).status, JobStatus.Completed);
    assert.equal(await ctx.token.read.balanceOf([provider]), 0n);
    assert.equal(await ctx.token.read.balanceOf([treasury]), 0n);
    // afterAction(complete) reconciled Router bookkeeping (audit L03).
    assert.equal(await ctx.router.read.inflightJobCount(), 0n);
  });

  it("Zero-price expiry path: unsubmitted free job → claimRefund → markExpired clears inflight", async () => {
    const ctx = await setup();
    const expiresIn = 3600n;
    const { jobId } = await createRoutedZeroPriceJob(ctx, expiresIn);
    assert.equal(await ctx.router.read.inflightJobCount(), 1n);

    // Provider never submits; the free job must still reach a terminal state
    // instead of stranding the Router's inflight counter (the failure mode
    // that Route B would have introduced).
    await advanceSeconds(viem, Number(expiresIn) + 100);
    await ctx.commerce.write.claimRefund([jobId]);
    assert.equal((await ctx.commerce.read.getJob([jobId])).status, JobStatus.Expired);
    assert.equal(await ctx.token.read.balanceOf([client]), 0n);

    // claimRefund is not hookable → reconcile Router state via markExpired.
    await ctx.router.write.markExpired([jobId]);
    assert.equal(await ctx.router.read.inflightJobCount(), 0n);
  });
});
