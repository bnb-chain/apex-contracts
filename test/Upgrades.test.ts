import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, toHex, zeroAddress } from "viem";
import { JobStatus, DEFAULT_BUDGET, TRUSTED_FORWARDER } from "./constants.js";
import {
  deployMockToken,
  deployAPEXProxy,
  createAndFundJob,
} from "./deploy.js";

describe("UUPS Upgrade Tests", async function () {
  const { viem } = await network.connect();

  const [deployer, client, provider, evaluator, other] = await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const evaluatorAddress = getAddress(evaluator.account.address);

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

    it("pre-upgrade jobs have submittedAt == 0 after upgrade", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);

      // Simulated pre-upgrade behavior: create + fund a job (status Funded, not submitted)
      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET,
      );

      // submittedAt should read 0 for a job that hasn't been submitted
      const job = await apex.read.getJob([jobId]);
      assert.equal(job.submittedAt, BigInt(0));
      assert.equal(job.status, JobStatus.Funded);
    });

    it("preserves existing fields after adding submittedAt", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);

      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET,
      );

      const job = await apex.read.getJob([jobId]);
      // Verify all legacy fields still correct
      assert.equal(job.id, jobId);
      assert.equal(getAddress(job.client), clientAddress);
      assert.equal(getAddress(job.provider), providerAddress);
      assert.equal(getAddress(job.evaluator), evaluatorAddress);
      assert.equal(job.budget, DEFAULT_BUDGET);
      assert.equal(job.status, JobStatus.Funded);
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

});
