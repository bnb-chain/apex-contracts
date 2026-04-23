import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import {
  buildAddVoter,
  buildRemoveVoter,
  buildSetQuorum,
  buildTransferAdmin,
} from "../../../scripts/gov/policy.js";
import { deployStack } from "../helpers.js";

describe("gov/policy builders", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW, voterAW, voterBW, voterCW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);
  const voterA = getAddress(voterAW.account.address);
  const voterB = getAddress(voterBW.account.address);
  const voterC = getAddress(voterCW.account.address);

  it("buildAddVoter registers voter on-chain", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB],
      initialQuorum: 2,
    });

    const call = buildAddVoter(policy.address, voterC);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await policy.read.isVoter([voterC]), true);
    assert.equal(await policy.read.activeVoterCount(), 3);
  });

  it("buildRemoveVoter clears voter on-chain", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB, voterC],
      initialQuorum: 2,
    });

    const call = buildRemoveVoter(policy.address, voterC);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await policy.read.isVoter([voterC]), false);
    assert.equal(await policy.read.activeVoterCount(), 2);
  });

  it("buildSetQuorum updates voteQuorum", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB, voterC],
      initialQuorum: 2,
    });

    const call = buildSetQuorum(policy.address, 3);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await policy.read.voteQuorum(), 3);
  });

  it("buildTransferAdmin sets pendingAdmin", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB],
      initialQuorum: 2,
    });
    const newAdmin = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const call = buildTransferAdmin(policy.address, newAdmin);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await policy.read.pendingAdmin()), getAddress(newAdmin));
    assert.equal(getAddress(await policy.read.admin()), owner);
  });
});
