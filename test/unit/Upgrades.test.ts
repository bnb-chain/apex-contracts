import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, zeroAddress } from "viem";

import {
  DEFAULT_BUDGET,
  JobStatus,
  deployCommerce,
  deployMockToken,
  deployRouter,
  blockTimestamp,
} from "./helpers.js";

/**
 * UUPS upgrade proofs for the two upgradeable contracts. The goal is not to
 * exercise every post-upgrade behaviour — the rest of the suite does that —
 * but to assert two invariants that matter when we ship a new implementation:
 *
 *   1. Proxy address stays constant (this is inherent to UUPS — the test is
 *      really a regression check that the proxy object we hold after
 *      `upgradeToAndCall` still points at the same address).
 *   2. Storage is preserved: state written against v1 is still readable
 *      through the v2 ABI, and a freshly-minted v2-only method reports the
 *      new version.
 */
describe("UUPS upgrades", async () => {
  const { viem } = await network.connect();

  const [deployerW, clientW, providerW, evaluatorW, treasuryW] = await viem.getWalletClients();
  const deployer = getAddress(deployerW.account.address);
  const client = getAddress(clientW.account.address);
  const provider = getAddress(providerW.account.address);
  const evaluator = getAddress(evaluatorW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  describe("AgenticCommerceUpgradeable", () => {
    it("upgradeToAndCall preserves proxy address and storage", async () => {
      const token = await deployMockToken(viem);
      const { proxy: commerce } = await deployCommerce(viem, {
        paymentToken: token.address,
        treasury,
        owner: deployer,
      });

      // Seed v1 state: a fully Funded job whose invariants we will re-check
      // via the v2 ABI after the upgrade.
      const commerceAsClient = await viem.getContractAt(
        "AgenticCommerceUpgradeable",
        commerce.address,
        { client: { wallet: clientW } },
      );
      const expiredAt = (await blockTimestamp(viem)) + 3_600n;
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        expiredAt,
        "upgrade-seed",
        zeroAddress,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      // Also change an admin-owned slot so the upgrade test exercises both
      // value-typed (`platformFeeBP`) and address-typed (`platformTreasury`)
      // storage round-trips.
      await commerce.write.setPlatformFee([250n, treasury]);

      const proxyAddr = commerce.address;
      const v2Impl = await viem.deployContract("AgenticCommerceV2Mock", []);
      await commerce.write.upgradeToAndCall([v2Impl.address, "0x"]);

      const upgraded = await viem.getContractAt("AgenticCommerceV2Mock", proxyAddr);
      assert.equal(upgraded.address, proxyAddr);
      assert.equal(await upgraded.read.version(), 2);

      // v1 state preserved under the v2 ABI.
      assert.equal(await upgraded.read.platformFeeBP(), 250n);
      assert.equal(getAddress(await upgraded.read.platformTreasury()), treasury);
      assert.equal(await upgraded.read.jobCounter(), 1n);
      const job = await upgraded.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Funded);
      assert.equal(job.budget, DEFAULT_BUDGET);
      assert.equal(getAddress(job.client), client);
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
