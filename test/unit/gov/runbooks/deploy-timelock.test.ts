import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { deployTimelock } from "../../../../scripts/gov/runbooks/deploy-timelock.js";

describe("runbook/deploy-timelock", async () => {
  const { viem } = await network.connect();
  const [deployerW, multisigW] = await viem.getWalletClients();
  const deployer = getAddress(deployerW.account.address);
  const multisig = getAddress(multisigW.account.address);

  it("deploys TimelockController with delay=0 and multisig as proposer+executor", async () => {
    const address = await deployTimelock(viem, { multisig, admin: deployer, minDelay: 0n });

    const tl = await viem.getContractAt("TimelockController", address);
    assert.equal(await tl.read.getMinDelay(), 0n);

    const proposerRole = await tl.read.PROPOSER_ROLE();
    const executorRole = await tl.read.EXECUTOR_ROLE();
    assert.equal(await tl.read.hasRole([proposerRole, multisig]), true);
    assert.equal(await tl.read.hasRole([executorRole, multisig]), true);
  });
});
