import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { buildTransferAllOwnership } from "../../../../scripts/gov/runbooks/transfer-ownership.js";
import { deployStack } from "../../helpers.js";

describe("runbook/transfer-ownership", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW, voterAW, voterBW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("produces 3 CallItems that hand ownership to timelock when executed", async () => {
    const { commerce, router, policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [getAddress(voterAW.account.address), getAddress(voterBW.account.address)],
      initialQuorum: 2,
    });
    const timelock = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const calls = buildTransferAllOwnership({
      commerce: commerce.address,
      router: router.address,
      policy: policy.address,
      timelock,
    });
    assert.equal(calls.length, 3);

    for (const c of calls) {
      await ownerW.sendTransaction({ to: c.to, data: c.data });
    }

    assert.equal(getAddress(await commerce.read.pendingOwner()), getAddress(timelock));
    assert.equal(getAddress(await router.read.pendingOwner()), getAddress(timelock));
    assert.equal(getAddress(await policy.read.pendingAdmin()), getAddress(timelock));
  });
});
