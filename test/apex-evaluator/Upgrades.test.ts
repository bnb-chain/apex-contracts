// Legacy UMA-based APEXEvaluator upgrade tests. Not exercised by V1 Router path.
// Re-activate via `npm run test:legacy-evaluator`.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { DEFAULT_LIVENESS, DEFAULT_BOND } from "./constants.js";
import { deployMockToken, deployAPEXProxy, deployEvaluatorProxy, deployMockOOv3 } from "./deploy.js";

describe("APEXEvaluator Upgrade (legacy)", async function () {
  const { viem } = await network.connect();

  const [deployer, , , , other] = await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);

  it("should upgrade evaluator and preserve state", async () => {
    const token = await deployMockToken(viem);
    const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);
    const oov3 = await deployMockOOv3(viem, DEFAULT_BOND);

    const evaluatorProxy = await deployEvaluatorProxy(
      viem,
      deployerAddress,
      apex.address,
      oov3.address,
      token.address,
      DEFAULT_LIVENESS,
    );

    const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluatorProxy.address, {
      client: { wallet: deployer },
    });

    const livenessBefore = await evaluatorProxy.read.liveness();
    const erc8183Before = await evaluatorProxy.read.erc8183();
    const totalLockedBefore = await evaluatorProxy.read.totalLockedBond();

    const newImpl = await viem.deployContract("APEXEvaluatorUpgradeable");
    await evalAsDeployer.write.upgradeToAndCall([newImpl.address, "0x"]);

    const livenessAfter = await evaluatorProxy.read.liveness();
    const erc8183After = await evaluatorProxy.read.erc8183();
    const totalLockedAfter = await evaluatorProxy.read.totalLockedBond();

    assert.equal(livenessAfter, livenessBefore);
    assert.equal(getAddress(erc8183After as string), getAddress(erc8183Before as string));
    assert.equal(totalLockedAfter, totalLockedBefore);
  });

  it("should revert evaluator upgrade from non-owner", async () => {
    const token = await deployMockToken(viem);
    const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);
    const oov3 = await deployMockOOv3(viem, DEFAULT_BOND);

    const evaluatorProxy = await deployEvaluatorProxy(
      viem,
      deployerAddress,
      apex.address,
      oov3.address,
      token.address,
      DEFAULT_LIVENESS,
    );

    const newImpl = await viem.deployContract("APEXEvaluatorUpgradeable");

    const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluatorProxy.address, {
      client: { wallet: other },
    });

    await assert.rejects(
      evalAsOther.write.upgradeToAndCall([newImpl.address, "0x"]),
      /OwnableUnauthorizedAccount/,
    );
  });
});
