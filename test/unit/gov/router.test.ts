import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import {
  buildSetPolicyWhitelist,
  buildSetCommerce,
  buildPause,
  buildUnpause,
  buildTransferOwnership,
} from "../../../scripts/gov/router.js";
import { deployCommerce, deployMockToken, deployRouter } from "../helpers.js";

describe("gov/router builders", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  async function fixture() {
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
    return { commerce, router };
  }

  it("buildSetPolicyWhitelist flips whitelist status", async () => {
    const { router } = await fixture();
    const fakePolicy = "0x000000000000000000000000000000000000bEEF" as `0x${string}`;

    const call = buildSetPolicyWhitelist(router.address, fakePolicy, true);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await router.read.policyWhitelist([fakePolicy]), true);
  });

  it("buildSetCommerce updates router's stored commerce (requires pause)", async () => {
    const { router } = await fixture();
    const newCommerce = "0x000000000000000000000000000000000000cafE" as `0x${string}`;

    const pauseCall = buildPause(router.address);
    await ownerW.sendTransaction({ to: pauseCall.to, data: pauseCall.data });

    const call = buildSetCommerce(router.address, newCommerce);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await router.read.commerce()), getAddress(newCommerce));
  });

  it("buildTransferOwnership produces valid pendingOwner call", async () => {
    const { router } = await fixture();
    const newOwner = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const call = buildTransferOwnership(router.address, newOwner);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await router.read.pendingOwner()), getAddress(newOwner));
  });

  it("buildUnpause clears the paused flag", async () => {
    const { router } = await fixture();
    const pauseCall = buildPause(router.address);
    await ownerW.sendTransaction({ to: pauseCall.to, data: pauseCall.data });
    assert.equal(await router.read.paused(), true);

    const unpauseCall = buildUnpause(router.address);
    await ownerW.sendTransaction({ to: unpauseCall.to, data: unpauseCall.data });
    assert.equal(await router.read.paused(), false);
  });
});
