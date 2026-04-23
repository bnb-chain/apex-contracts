import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import {
  buildSetPlatformFee,
  buildPause,
  buildUnpause,
  buildTransferOwnership,
} from "../../../scripts/gov/commerce.js";
import { deployCommerce, deployMockToken } from "../helpers.js";

describe("gov/commerce builders", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("buildSetPlatformFee emits correct calldata and lands on-chain", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });

    const call = buildSetPlatformFee(commerce.address, 250n, treasury);
    assert.equal(call.to, commerce.address);
    assert.match(call.description, /setPlatformFee/);

    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await commerce.read.platformFeeBP(), 250n);
    assert.equal(getAddress(await commerce.read.platformTreasury()), treasury);
  });

  it("buildPause / buildUnpause produce calls that toggle paused()", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });

    const pauseCall = buildPause(commerce.address);
    await ownerW.sendTransaction({ to: pauseCall.to, data: pauseCall.data });
    assert.equal(await commerce.read.paused(), true);

    const unpauseCall = buildUnpause(commerce.address);
    await ownerW.sendTransaction({ to: unpauseCall.to, data: unpauseCall.data });
    assert.equal(await commerce.read.paused(), false);
  });

  it("buildTransferOwnership starts a two-step handoff", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });
    const newOwner = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const call = buildTransferOwnership(commerce.address, newOwner);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await commerce.read.pendingOwner()), getAddress(newOwner));
    assert.equal(getAddress(await commerce.read.owner()), owner);
  });
});
