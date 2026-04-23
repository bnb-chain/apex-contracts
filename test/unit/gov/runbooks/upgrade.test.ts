import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { buildUpgradeCalls } from "../../../../scripts/gov/runbooks/upgrade.js";
import { deployCommerce, deployMockToken, deployRouter } from "../../helpers.js";

describe("runbook/upgrade", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("mode=all produces 2 upgradeToAndCall calls; both succeed on-chain", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });
    const { proxy: router } = await deployRouter(viem, {
      commerce: commerce.address,
      owner,
    });
    const newCommerceImpl = await viem.deployContract("AgenticCommerceV2Mock", []);
    const newRouterImpl = await viem.deployContract("EvaluatorRouterV2Mock", []);

    const calls = buildUpgradeCalls({
      mode: "all",
      commerce: commerce.address,
      router: router.address,
      newCommerceImpl: newCommerceImpl.address,
      newRouterImpl: newRouterImpl.address,
    });
    assert.equal(calls.length, 2);

    for (const c of calls) {
      await ownerW.sendTransaction({ to: c.to, data: c.data });
    }

    const upgradedCommerce = await viem.getContractAt("AgenticCommerceV2Mock", commerce.address);
    const upgradedRouter = await viem.getContractAt("EvaluatorRouterV2Mock", router.address);
    assert.equal(await upgradedCommerce.read.version(), 2);
    assert.equal(await upgradedRouter.read.version(), 2);
  });

  it("mode=commerce produces 1 call (commerce only)", () => {
    const calls = buildUpgradeCalls({
      mode: "commerce",
      commerce: "0x0000000000000000000000000000000000000001",
      router: "0x0000000000000000000000000000000000000002",
      newCommerceImpl: "0x0000000000000000000000000000000000000003",
      newRouterImpl: null,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.description, /commerce\.upgradeToAndCall/);
  });

  it("mode=router produces 1 call (router only)", () => {
    const calls = buildUpgradeCalls({
      mode: "router",
      commerce: "0x0000000000000000000000000000000000000001",
      router: "0x0000000000000000000000000000000000000002",
      newCommerceImpl: null,
      newRouterImpl: "0x0000000000000000000000000000000000000004",
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.description, /router\.upgradeToAndCall/);
  });
});
