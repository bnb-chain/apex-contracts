import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, keccak256, toHex, zeroAddress } from "viem";
import { JobStatus, DEFAULT_BUDGET, DEFAULT_LIVENESS, DEFAULT_BOND, TRUSTED_FORWARDER } from "./constants.js";
import {
  deployMockToken,
  mintTokens,
  deployAPEXProxy,
  deployEvaluatorProxy,
  deployMockOOv3,
  createAndFundJob,
} from "./deploy.js";

describe("UUPS Upgrade Tests", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  const [deployer, client, provider, evaluator, other] = await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const evaluatorAddress = getAddress(evaluator.account.address);
  const otherAddress = getAddress(other.account.address);

  // ============================================================
  // AgenticCommerce Upgrade Tests
  // ============================================================

  describe("AgenticCommerce Upgrade", async () => {
    it("should upgrade and preserve state", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);

      // Create some state
      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Upgrade test job", zeroAddress]);

      // Record state before upgrade
      const jobCounterBefore = await apex.read.jobCounter();
      const paymentTokenBefore = await apex.read.paymentToken();

      // Deploy new implementation
      const newImpl = await viem.deployContract("AgenticCommerceUpgradeable", [TRUSTED_FORWARDER]);

      // Upgrade
      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.upgradeToAndCall([newImpl.address, "0x"]);

      // Verify state preserved
      const jobCounterAfter = await apex.read.jobCounter();
      const paymentTokenAfter = await apex.read.paymentToken();

      assert.equal(jobCounterAfter, jobCounterBefore);
      assert.equal(getAddress(paymentTokenAfter), getAddress(paymentTokenBefore));

      // Verify job data preserved
      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.client), clientAddress);
      assert.equal(job.description, "Upgrade test job");
      assert.equal(job.status, JobStatus.Open);
    });

    it("should continue working after upgrade", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);

      // Create and fund a job
      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET
      );

      // Upgrade
      const newImpl = await viem.deployContract("AgenticCommerceUpgradeable", [TRUSTED_FORWARDER]);
      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.upgradeToAndCall([newImpl.address, "0x"]);

      // Submit work (should work after upgrade)
      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("d")), "0x"]);

      // Complete (should work after upgrade)
      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.complete([jobId, keccak256(toHex("ok")), "0x"]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, JobStatus.Completed);

      // Provider should have received payment
      const balance = await token.read.balanceOf([providerAddress]);
      assert.equal(balance, DEFAULT_BUDGET);
    });

    it("should revert upgrade from non-owner", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);

      const newImpl = await viem.deployContract("AgenticCommerceUpgradeable", [
        "0x0000000000000000000000000000000000000001"
      ]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.upgradeToAndCall([newImpl.address, "0x"]),
        /AccessControlUnauthorizedAccount/
      );
    });
  });

  // ============================================================
  // APEXEvaluator Upgrade Tests
  // ============================================================

  describe("APEXEvaluator Upgrade", async () => {
    it("should upgrade evaluator and preserve state", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);
      const oov3 = await deployMockOOv3(viem, DEFAULT_BOND);

      const evaluatorProxy = await deployEvaluatorProxy(
        viem, deployerAddress, apex.address, oov3.address, token.address, DEFAULT_LIVENESS
      );

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluatorProxy.address, {
        client: { wallet: deployer },
      });

      // Record state before upgrade
      const livenessBefore = await evaluatorProxy.read.liveness();
      const erc8183Before = await evaluatorProxy.read.erc8183();
      const totalLockedBefore = await evaluatorProxy.read.totalLockedBond();

      // Deploy new impl and upgrade
      const newImpl = await viem.deployContract("APEXEvaluatorUpgradeable");
      await evalAsDeployer.write.upgradeToAndCall([newImpl.address, "0x"]);

      // Verify state preserved
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
        viem, deployerAddress, apex.address, oov3.address, token.address, DEFAULT_LIVENESS
      );

      const newImpl = await viem.deployContract("APEXEvaluatorUpgradeable");

      const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluatorProxy.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        evalAsOther.write.upgradeToAndCall([newImpl.address, "0x"]),
        /OwnableUnauthorizedAccount/
      );
    });
  });
});
