import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, keccak256, toBytes } from "viem";

import {
  DEFAULT_BUDGET,
  JobStatus,
  deployCommerce,
  deployMockToken,
  deployNoopHook,
  deployRouter,
  blockTimestamp,
  advanceSeconds,
} from "./helpers.js";

/**
 * Executable UUPS compatibility proofs: Commerce upgrades from the frozen
 * pre-multi-token flat layout while live escrow exists; Router retains its
 * independent namespaced-storage upgrade regression coverage.
 */
// Top-level await, NOT an async describe: bun's collector does not await an
// async describe callback, so tests registered after its first `await` are
// silently dropped when multiple test files load in parallel.
const { viem } = await network.connect();

const [deployerW, clientW, providerW, evaluatorW, treasuryW] = await viem.getWalletClients();
const deployer = getAddress(deployerW.account.address);
const client = getAddress(clientW.account.address);
const provider = getAddress(providerW.account.address);
const evaluator = getAddress(evaluatorW.account.address);
const treasury = getAddress(treasuryW.account.address);

describe("UUPS upgrades", () => {
  describe("AgenticCommerceUpgradeable", () => {
    async function deployLegacyFixture() {
      const defaultToken = await deployMockToken(viem, 18);
      const token6 = await deployMockToken(viem, 6);
      const token18 = await deployMockToken(viem, 18);
      const legacyImpl = await viem.deployContract("AgenticCommerceLegacyMock", []);
      const initData = encodeFunctionData({
        abi: legacyImpl.abi,
        functionName: "initialize",
        args: [defaultToken.address, treasury, deployer],
      });
      const proxy = await viem.deployContract("ERC1967Proxy", [legacyImpl.address, initData]);
      const legacy = await viem.getContractAt("AgenticCommerceLegacyMock", proxy.address);
      const legacyAsClient = await viem.getContractAt("AgenticCommerceLegacyMock", proxy.address, {
        client: { wallet: clientW },
      });
      const legacyAsProvider = await viem.getContractAt(
        "AgenticCommerceLegacyMock",
        proxy.address,
        { client: { wallet: providerW } },
      );
      const noopHook = await deployNoopHook(viem);
      const expiredAt = (await blockTimestamp(viem)) + 3_600n;

      for (const description of [
        "legacy-open",
        "legacy-funded",
        "legacy-complete",
        "legacy-refund",
      ]) {
        await legacyAsClient.write.createJob([
          provider,
          evaluator,
          expiredAt,
          description,
          noopHook.address,
        ]);
      }

      await defaultToken.write.mint([client, DEFAULT_BUDGET * 3n]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", defaultToken.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([proxy.address, DEFAULT_BUDGET * 3n]);

      for (const jobId of [2n, 3n, 4n]) {
        await legacyAsClient.write.setBudget([jobId, DEFAULT_BUDGET, "0x"]);
        await legacyAsClient.write.fund([jobId, DEFAULT_BUDGET, "0x"]);
      }
      await legacyAsProvider.write.submit([3n, keccak256(toBytes("legacy-complete")), "0x"]);
      await legacyAsProvider.write.submit([4n, keccak256(toBytes("legacy-refund")), "0x"]);
      await legacy.write.setPlatformFee([250n, treasury]);

      const jobIds = [1n, 2n, 3n, 4n] as const;
      return {
        defaultToken,
        token6,
        token18,
        proxy,
        legacy,
        expiredAt,
        before: {
          owner: await legacy.read.owner(),
          paymentToken: await legacy.read.paymentToken(),
          platformFeeBP: await legacy.read.platformFeeBP(),
          platformTreasury: await legacy.read.platformTreasury(),
          jobCounter: await legacy.read.jobCounter(),
          jobs: await Promise.all(jobIds.map((jobId) => legacy.read.getJob([jobId]))),
          publicJobs: await Promise.all(jobIds.map((jobId) => legacy.read.jobs([jobId]))),
          jobHasBudget: await Promise.all(jobIds.map((jobId) => legacy.read.jobHasBudget([jobId]))),
        },
      };
    }

    it("atomically upgrades the real flat legacy layout and preserves live escrow", async () => {
      const ctx = await deployLegacyFixture();
      assert.deepEqual(
        ctx.before.jobs.map((job) => job.status),
        [JobStatus.Open, JobStatus.Funded, JobStatus.Submitted, JobStatus.Submitted],
      );

      const newImpl = await viem.deployContract("AgenticCommerceUpgradeable", []);
      const initializeMultiTokenData = encodeFunctionData({
        abi: newImpl.abi,
        functionName: "initializeMultiToken",
        args: [[ctx.defaultToken.address, ctx.token6.address, ctx.token18.address]],
      });
      await ctx.legacy.write.upgradeToAndCall([newImpl.address, initializeMultiTokenData]);

      const upgraded = await viem.getContractAt("AgenticCommerceUpgradeable", ctx.proxy.address);
      assert.equal(upgraded.address, ctx.proxy.address);
      assert.equal(getAddress(await upgraded.read.owner()), getAddress(ctx.before.owner));
      assert.equal(
        getAddress(await upgraded.read.paymentToken()),
        getAddress(ctx.before.paymentToken),
      );
      assert.equal(await upgraded.read.platformFeeBP(), ctx.before.platformFeeBP);
      assert.equal(
        getAddress(await upgraded.read.platformTreasury()),
        getAddress(ctx.before.platformTreasury),
      );
      assert.equal(await upgraded.read.jobCounter(), ctx.before.jobCounter);

      const jobIds = [1n, 2n, 3n, 4n] as const;
      assert.deepEqual(
        await Promise.all(jobIds.map((jobId) => upgraded.read.getJob([jobId]))),
        ctx.before.jobs,
      );
      assert.deepEqual(
        await Promise.all(jobIds.map((jobId) => upgraded.read.jobs([jobId]))),
        ctx.before.publicJobs,
      );
      assert.deepEqual(
        await Promise.all(jobIds.map((jobId) => upgraded.read.jobHasBudget([jobId]))),
        ctx.before.jobHasBudget,
      );
      assert.deepEqual(ctx.before.jobHasBudget, [false, true, true, true]);

      for (const token of [ctx.defaultToken, ctx.token6, ctx.token18]) {
        assert.equal(await upgraded.read.isPaymentTokenSupported([token.address]), true);
      }
      for (const jobId of jobIds) {
        assert.equal(
          getAddress(await upgraded.read.jobPaymentToken([jobId])),
          getAddress(ctx.defaultToken.address),
        );
      }

      const upgradedAsEvaluator = await viem.getContractAt(
        "AgenticCommerceUpgradeable",
        ctx.proxy.address,
        { client: { wallet: evaluatorW } },
      );
      await upgradedAsEvaluator.write.reject([2n, keccak256(toBytes("rejected")), "0x"]);
      await upgradedAsEvaluator.write.complete([3n, keccak256(toBytes("completed")), "0x"]);
      await advanceSeconds(viem, ctx.expiredAt - (await blockTimestamp(viem)) + 1n);
      await upgraded.write.claimRefund([4n]);

      assert.equal((await upgraded.read.getJob([2n])).status, JobStatus.Rejected);
      assert.equal((await upgraded.read.getJob([3n])).status, JobStatus.Completed);
      assert.equal((await upgraded.read.getJob([4n])).status, JobStatus.Expired);
      const fee = (DEFAULT_BUDGET * 250n) / 10_000n;
      assert.equal(await ctx.defaultToken.read.balanceOf([client]), DEFAULT_BUDGET * 2n);
      assert.equal(await ctx.defaultToken.read.balanceOf([provider]), DEFAULT_BUDGET - fee);
      assert.equal(await ctx.defaultToken.read.balanceOf([treasury]), fee);
      assert.equal(await ctx.defaultToken.read.balanceOf([ctx.proxy.address]), 0n);
    });

    it("upgradeToAndCall is gated by Ownable2Step", async () => {
      const token = await deployMockToken(viem);
      const { proxy: commerce } = await deployCommerce(viem, {
        paymentToken: token.address,
        treasury,
        owner: deployer,
      });
      const v2Impl = await viem.deployContract("AgenticCommerceV2Mock", []);
      const commerceAsClient = await viem.getContractAt(
        "AgenticCommerceUpgradeable",
        commerce.address,
        { client: { wallet: clientW } },
      );
      await assert.rejects(
        commerceAsClient.write.upgradeToAndCall([v2Impl.address, "0x"]),
        /OwnableUnauthorizedAccount/,
      );
    });
  });

  describe("EvaluatorRouterUpgradeable", () => {
    it("upgradeToAndCall preserves proxy address and namespaced storage", async () => {
      const token = await deployMockToken(viem);
      const { proxy: commerce } = await deployCommerce(viem, {
        paymentToken: token.address,
        treasury,
        owner: deployer,
      });
      const { proxy: router } = await deployRouter(viem, {
        commerce: commerce.address,
        owner: deployer,
      });

      // Seed router state: flip the pause flag and whitelist a stand-in
      // policy address. Both live in the ERC-7201 namespaced storage slot.
      await router.write.pause();
      const fakePolicy = getAddress(providerW.account.address);
      await router.write.unpause();
      await router.write.setPolicyWhitelist([fakePolicy, true]);

      const proxyAddr = router.address;
      const v2Impl = await viem.deployContract("EvaluatorRouterV2Mock", []);
      await router.write.upgradeToAndCall([v2Impl.address, "0x"]);

      const upgraded = await viem.getContractAt("EvaluatorRouterV2Mock", proxyAddr);
      assert.equal(upgraded.address, proxyAddr);
      assert.equal(await upgraded.read.version(), 2);
      assert.equal(getAddress(await upgraded.read.commerce()), getAddress(commerce.address));
      assert.equal(await upgraded.read.policyWhitelist([fakePolicy]), true);
    });

    it("upgradeToAndCall is gated by Ownable2Step", async () => {
      const token = await deployMockToken(viem);
      const { proxy: commerce } = await deployCommerce(viem, {
        paymentToken: token.address,
        treasury,
        owner: deployer,
      });
      const { proxy: router } = await deployRouter(viem, {
        commerce: commerce.address,
        owner: deployer,
      });
      const v2Impl = await viem.deployContract("EvaluatorRouterV2Mock", []);
      const routerAsClient = await viem.getContractAt(
        "EvaluatorRouterUpgradeable",
        router.address,
        { client: { wallet: clientW } },
      );
      await assert.rejects(
        routerAsClient.write.upgradeToAndCall([v2Impl.address, "0x"]),
        /OwnableUnauthorizedAccount/,
      );
    });
  });
});
