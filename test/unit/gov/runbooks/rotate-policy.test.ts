import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { buildRotatePolicyWhitelist } from "../../../../scripts/gov/runbooks/rotate-policy.js";
import { deployStack, DEFAULT_DISPUTE_WINDOW } from "../../helpers.js";

describe("runbook/rotate-policy", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW, voterAW, voterBW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("deploys a new policy + produces 2 whitelist toggles that execute correctly", async () => {
    const { commerce, router, policy: oldPolicy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [getAddress(voterAW.account.address), getAddress(voterBW.account.address)],
      initialQuorum: 2,
    });

    // Deploy a fresh OptimisticPolicy (simulating the EOA-direct part).
    const newPolicy = await viem.deployContract("OptimisticPolicy", [
      commerce.address,
      router.address,
      owner,
      DEFAULT_DISPUTE_WINDOW,
      1,
    ]);

    const calls = buildRotatePolicyWhitelist({
      router: router.address,
      newPolicy: newPolicy.address,
      oldPolicy: oldPolicy.address,
    });
    assert.equal(calls.length, 2);

    for (const c of calls) {
      await ownerW.sendTransaction({ to: c.to, data: c.data });
    }

    assert.equal(await router.read.policyWhitelist([newPolicy.address]), true);
    assert.equal(await router.read.policyWhitelist([oldPolicy.address]), false);
  });

  it("skip-revoke mode produces only the whitelist-new call", async () => {
    const newPolicy = "0x000000000000000000000000000000000000aaaa" as `0x${string}`;
    const router = "0x000000000000000000000000000000000000bbbb" as `0x${string}`;
    const calls = buildRotatePolicyWhitelist({
      router,
      newPolicy,
      oldPolicy: null,
    });
    assert.equal(calls.length, 1);
  });
});
