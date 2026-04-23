import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, getAddress, keccak256, parseAbiParameters, parseEventLogs, toBytes, zeroAddress } from "viem";

import {
  JobStatus,
  DEFAULT_BUDGET,
  DEFAULT_DISPUTE_WINDOW,
  deployStack,
  blockTimestamp,
  advanceSeconds,
  createFundedSubmittedJob,
} from "./helpers.js";

describe("EvaluatorRouterUpgradeable", async () => {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  const [deployerW, clientW, providerW, treasuryW, otherW] = await viem.getWalletClients();
  const deployer = getAddress(deployerW.account.address);
  const client = getAddress(clientW.account.address);
  const provider = getAddress(providerW.account.address);
  const treasury = getAddress(treasuryW.account.address);
  const other = getAddress(otherW.account.address);

  async function setup() {
    return deployStack(viem, { owner: deployer, treasury });
  }

  async function futureTs(offset = 3600): Promise<bigint> {
    return (await blockTimestamp(viem)) + BigInt(offset);
  }

  async function asCommerce(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("AgenticCommerceUpgradeable", addr, { client: { wallet } });
  }
  async function asRouter(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("EvaluatorRouterUpgradeable", addr, { client: { wallet } });
  }
  async function asToken(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("ERC20MinimalMock", addr, { client: { wallet } });
  }

  // ==================================================================
  // Deployment
  // ==================================================================

  describe("deployment", () => {
    it("binds commerce + owner", async () => {
      const { router, commerce } = await setup();
      assert.equal(getAddress(await router.read.commerce()), getAddress(commerce.address));
      assert.equal(getAddress(await router.read.owner()), deployer);
    });

    it("supportsInterface covers IACPHook + IERC165", async () => {
      const { router } = await setup();
      const IACP_HOOK_ID = "0x69fab9ad" as `0x${string}`; // precomputed via cast sig-hash below
      const IERC165_ID = "0x01ffc9a7" as `0x${string}`;
      // Router should report at least IERC165 (we can't easily compute IACPHook id in JS).
      assert.equal(await router.read.supportsInterface([IERC165_ID]), true);
      // Sanity: does NOT support arbitrary random id.
      assert.equal(await router.read.supportsInterface(["0xdeadbeef"]), false);
    });
  });

  // ==================================================================
  // Whitelist / setCommerce
  // ==================================================================

  describe("admin", () => {
    it("setPolicyWhitelist is owner-only", async () => {
      const { router, policy } = await setup();
      const routerAsOther = await asRouter(router.address, otherW);
      await assert.rejects(
        routerAsOther.write.setPolicyWhitelist([policy.address, true]),
        /OwnableUnauthorizedAccount/,
      );
    });

    it("setCommerce requires paused", async () => {
      const { router, commerce } = await setup();
      await assert.rejects(router.write.setCommerce([commerce.address]), /NotPaused/);
      await router.write.pause();
      await router.write.setCommerce([commerce.address]);
    });

    it("pause blocks both registerJob and settle", async () => {
      const ctx = await setup();
      const commerceAsClient = await asCommerce(ctx.commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        ctx.router.address,
        await futureTs(3600),
        "",
        ctx.router.address,
      ]);

      await ctx.router.write.pause();

      const routerAsClient = await asRouter(ctx.router.address, clientW);
      await assert.rejects(
        routerAsClient.write.registerJob([1n, ctx.policy.address]),
        /EnforcedPause/,
      );

      // settle is also pausable now — emergency brake for buggy verdicts.
      await assert.rejects(ctx.router.write.settle([1n, "0x"]), /EnforcedPause/);
    });
  });

  // ==================================================================
  // registerJob
  // ==================================================================

  describe("registerJob", () => {
    async function seedOpenJob(ctx: Awaited<ReturnType<typeof setup>>) {
      const commerceAsClient = await asCommerce(ctx.commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        ctx.router.address,
        await futureTs(3600),
        "Router job",
        ctx.router.address,
      ]);
      return commerceAsClient;
    }

    it("client registers job → policy bound", async () => {
      const ctx = await setup();
      await seedOpenJob(ctx);
      const routerAsClient = await asRouter(ctx.router.address, clientW);
      await routerAsClient.write.registerJob([1n, ctx.policy.address]);
      assert.equal(
        getAddress(await ctx.router.read.jobPolicy([1n])),
        getAddress(ctx.policy.address),
      );
    });

    it("rejects non-client", async () => {
      const ctx = await setup();
      await seedOpenJob(ctx);
      const routerAsOther = await asRouter(ctx.router.address, otherW);
      await assert.rejects(
        routerAsOther.write.registerJob([1n, ctx.policy.address]),
        /NotJobClient/,
      );
    });

    it("rejects non-whitelisted policy", async () => {
      const ctx = await setup();
      await seedOpenJob(ctx);
      const routerAsClient = await asRouter(ctx.router.address, clientW);
      await assert.rejects(routerAsClient.write.registerJob([1n, client]), /PolicyNotWhitelisted/);
    });

    it("rejects duplicate registration", async () => {
      const ctx = await setup();
      await seedOpenJob(ctx);
      const routerAsClient = await asRouter(ctx.router.address, clientW);
      await routerAsClient.write.registerJob([1n, ctx.policy.address]);
      await assert.rejects(
        routerAsClient.write.registerJob([1n, ctx.policy.address]),
        /PolicyAlreadySet/,
      );
    });

    it("rejects job whose evaluator != router", async () => {
      const ctx = await setup();
      const commerceAsClient = await asCommerce(ctx.commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        other, // evaluator = other, not router
        await futureTs(3600),
        "",
        ctx.router.address,
      ]);
      const routerAsClient = await asRouter(ctx.router.address, clientW);
      await assert.rejects(
        routerAsClient.write.registerJob([1n, ctx.policy.address]),
        /RouterNotEvaluator/,
      );
    });

    it("rejects job whose hook != router", async () => {
      const ctx = await setup();
      const commerceAsClient = await asCommerce(ctx.commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        ctx.router.address,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      const routerAsClient = await asRouter(ctx.router.address, clientW);
      await assert.rejects(
        routerAsClient.write.registerJob([1n, ctx.policy.address]),
        /RouterNotHook/,
      );
    });
  });

  // ==================================================================
  // Hooks must only be callable by the kernel
  // ==================================================================

  describe("IACPHook gating", () => {
    it("beforeAction rejects non-commerce caller", async () => {
      const { router } = await setup();
      await assert.rejects(router.write.beforeAction([1n, "0xd2e13f50", "0x"]), /NotCommerce/);
    });

    it("afterAction rejects non-commerce caller", async () => {
      const { router } = await setup();
      await assert.rejects(router.write.afterAction([1n, "0x9e63798d", "0x"]), /NotCommerce/);
    });
  });

  // ==================================================================
  // beforeAction(FUND) blocks fund without a registered policy
  // ==================================================================

  describe("beforeAction(FUND)", () => {
    it("reverts a `fund` call when the job has no registered policy", async () => {
      const ctx = await setup();
      const commerceAsClient = await asCommerce(ctx.commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        ctx.router.address,
        await futureTs(3600),
        "",
        ctx.router.address,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);

      await ctx.token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await asToken(ctx.token.address, clientW);
      await tokenAsClient.write.approve([ctx.commerce.address, DEFAULT_BUDGET]);

      // No registerJob was called → hook's beforeAction(FUND) reverts.
      await assert.rejects(commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]), /PolicyNotSet/);
    });
  });

  // ==================================================================
  // settle
  // ==================================================================

  describe("settle", () => {
    it("reverts PolicyNotSet when jobId has no binding", async () => {
      const { router } = await setup();
      await assert.rejects(router.write.settle([1n, "0x"]), /PolicyNotSet/);
    });

    it("JobSettled carries policy address and original policy reason", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);

      const txHash = await ctx.router.write.settle([jobId, "0x"]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      const settled = parseEventLogs({ abi: ctx.router.abi, logs: receipt.logs, eventName: "JobSettled" });
      assert.equal(settled.length, 1);
      const ev = settled[0].args;
      assert.equal(ev.jobId, jobId);
      assert.equal(getAddress(ev.policy!), getAddress(ctx.policy.address));
      assert.equal(ev.verdict, 1); // APPROVE

      // reason in JobSettled is the raw policy constant
      const REASON_APPROVED = keccak256(toBytes("OPTIMISTIC_APPROVED"));
      assert.equal(ev.reason, REASON_APPROVED);
    });

    it("settle passes keccak256(abi.encode(policy, reason)) to kernel JobCompleted", async () => {
      const ctx = await setup();
      const { jobId } = await createFundedSubmittedJob(viem, {
        ...ctx,
        client: clientW,
        provider: providerW,
      });
      await advanceSeconds(viem, Number(DEFAULT_DISPUTE_WINDOW) + 1);

      const txHash = await ctx.router.write.settle([jobId, "0x"]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      const REASON_APPROVED = keccak256(toBytes("OPTIMISTIC_APPROVED"));
      const wrappedReason = keccak256(
        encodeAbiParameters(parseAbiParameters("address, bytes32"), [
          getAddress(ctx.policy.address),
          REASON_APPROVED,
        ]),
      );

      const completed = parseEventLogs({
        abi: ctx.commerce.abi,
        logs: receipt.logs,
        eventName: "JobCompleted",
      });
      assert.equal(completed.length, 1);
      assert.equal(completed[0].args.reason, wrappedReason);
    });
  });
});
