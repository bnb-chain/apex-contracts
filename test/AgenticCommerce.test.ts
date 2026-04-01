import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, toHex, zeroAddress } from "viem";
import { JobStatus, DEFAULT_BUDGET } from "./constants.js";
import { deployMockToken, deployAPEXProxy, createAndFundJob } from "./deploy.js";

describe("AgenticCommerceUpgradeable", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  const [deployer, client, provider, evaluator, treasury, other] = await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const evaluatorAddress = getAddress(evaluator.account.address);
  const treasuryAddress = getAddress(treasury.account.address);
  const otherAddress = getAddress(other.account.address);

  // Helper: get current block timestamp + offset
  async function futureTimestamp(offsetSeconds = 3600): Promise<bigint> {
    const block = await publicClient.getBlock();
    return block.timestamp + BigInt(offsetSeconds);
  }

  // ============================================================
  // Deployment Tests
  // ============================================================

  describe("Deployment", async () => {
    it("should initialize with correct parameters", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const paymentToken = await apex.read.paymentToken();
      const platformTreasury = await apex.read.platformTreasury();
      const jobCounter = await apex.read.jobCounter();

      assert.equal(getAddress(paymentToken), getAddress(token.address));
      assert.equal(getAddress(platformTreasury), treasuryAddress);
      assert.equal(jobCounter, BigInt(0));
    });

    it("should grant ADMIN_ROLE and DEFAULT_ADMIN_ROLE to deployer", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const ADMIN_ROLE = await apex.read.ADMIN_ROLE();
      const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000" as `0x${string}`;

      const hasAdmin = await apex.read.hasRole([ADMIN_ROLE, deployerAddress]);
      const hasDefaultAdmin = await apex.read.hasRole([DEFAULT_ADMIN_ROLE, deployerAddress]);

      assert.equal(hasAdmin, true);
      assert.equal(hasDefaultAdmin, true);
    });

    it("should not allow re-initialization", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await assert.rejects(
        apex.write.initialize([token.address, treasuryAddress, deployerAddress]),
        /InvalidInitialization/
      );
    });
  });

  // ============================================================
  // createJob Tests
  // ============================================================

  describe("createJob", async () => {
    it("should create a job with provider and evaluator", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const description = "Test job description";

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        providerAddress,
        evaluatorAddress,
        expiredAt,
        description,
        zeroAddress,
      ]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.id, BigInt(1));
      assert.equal(getAddress(job.client), clientAddress);
      assert.equal(getAddress(job.provider), providerAddress);
      assert.equal(getAddress(job.evaluator), evaluatorAddress);
      assert.equal(job.status, JobStatus.Open);
      assert.equal(job.description, description);
    });

    it("should create a job without provider (set later)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([
        zeroAddress,
        evaluatorAddress,
        expiredAt,
        "Job without provider",
        zeroAddress,
      ]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.provider), zeroAddress);
      assert.equal(job.status, JobStatus.Open);
    });

    it("should revert with zero evaluator (ZeroAddress)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.createJob([
          providerAddress,
          zeroAddress,
          expiredAt,
          "Invalid job",
          zeroAddress,
        ]),
        /ZeroAddress/
      );
    });

    it("should revert when expiry is too short (ExpiryTooShort)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      // Less than 5 minutes in the future
      const expiredAt = await futureTimestamp(60);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.createJob([
          providerAddress,
          evaluatorAddress,
          expiredAt,
          "Expiry too short",
          zeroAddress,
        ]),
        /ExpiryTooShort/
      );
    });

    it("should increment jobCounter for each new job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job 1", zeroAddress]);
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job 2", zeroAddress]);

      const jobCounter = await apex.read.jobCounter();
      assert.equal(jobCounter, BigInt(2));

      const job1 = await apex.read.getJob([BigInt(1)]);
      const job2 = await apex.read.getJob([BigInt(2)]);
      assert.equal(job1.id, BigInt(1));
      assert.equal(job2.id, BigInt(2));
    });
  });

  // ============================================================
  // setProvider Tests
  // ============================================================

  describe("setProvider", async () => {
    it("should allow client to set provider", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setProvider([BigInt(1), providerAddress, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.provider), providerAddress);
    });

    it("should revert if not client (Unauthorized)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setProvider([BigInt(1), providerAddress, "0x"]),
        /Unauthorized/
      );
    });

    it("should revert if provider already set (WrongStatus)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      // Create job with provider already set
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.setProvider([BigInt(1), otherAddress, "0x"]),
        /WrongStatus/
      );
    });

    it("should revert with zero provider address (ZeroAddress)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.setProvider([BigInt(1), zeroAddress, "0x"]),
        /ZeroAddress/
      );
    });
  });

  // ============================================================
  // setBudget Tests
  // ============================================================

  describe("setBudget", async () => {
    it("should allow client to set budget", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const budget = DEFAULT_BUDGET;
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.budget, budget);
    });

    it("should allow provider to set budget", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });

      const budget = DEFAULT_BUDGET;
      await apexAsProvider.write.setBudget([BigInt(1), budget, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.budget, budget);
    });

    it("should revert if unauthorized (Unauthorized)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setBudget([BigInt(1), DEFAULT_BUDGET, "0x"]),
        /Unauthorized/
      );
    });

    it("should revert when job is not Open (WrongStatus)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET
      );

      // Job is now Funded — setBudget should fail
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.setBudget([jobId, DEFAULT_BUDGET, "0x"]),
        /WrongStatus/
      );
    });
  });

  // ============================================================
  // fund Tests
  // ============================================================

  describe("fund", async () => {
    it("should fund job when expectedBudget matches", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), DEFAULT_BUDGET, "0x"]);

      await token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);
      await apexAsClient.write.fund([BigInt(1), DEFAULT_BUDGET, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Funded);
    });

    it("should transfer tokens to contract on fund", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), DEFAULT_BUDGET, "0x"]);

      await token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);

      const balanceBefore = await token.read.balanceOf([apex.address]);
      await apexAsClient.write.fund([BigInt(1), DEFAULT_BUDGET, "0x"]);
      const balanceAfter = await token.read.balanceOf([apex.address]);

      assert.equal(balanceAfter - balanceBefore, DEFAULT_BUDGET);
    });

    it("should revert on budget mismatch (BudgetMismatch)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), DEFAULT_BUDGET, "0x"]);

      await token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), DEFAULT_BUDGET + BigInt(1), "0x"]),
        /BudgetMismatch/
      );
    });

    it("should revert when budget is zero (ZeroBudget)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      // Create job without setting budget (budget remains 0)
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), BigInt(0), "0x"]),
        /ZeroBudget/
      );
    });

    it("should revert when no provider set (ProviderNotSet)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "No provider job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), DEFAULT_BUDGET, "0x"]);

      await token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), DEFAULT_BUDGET, "0x"]),
        /ProviderNotSet/
      );
    });
  });

  // ============================================================
  // submit Tests
  // ============================================================

  describe("submit", async () => {
    it("should allow provider to submit a funded job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });

      const deliverable = keccak256(toHex("deliverable content"));
      await apexAsProvider.write.submit([BigInt(1), deliverable, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Submitted);
    });

    it("should revert if not Funded (WrongStatus)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });

      const deliverable = keccak256(toHex("deliverable"));
      await assert.rejects(
        apexAsProvider.write.submit([BigInt(1), deliverable, "0x"]),
        /WrongStatus/
      );
    });

    it("should revert if not provider (Unauthorized)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      const deliverable = keccak256(toHex("deliverable"));
      await assert.rejects(
        apexAsOther.write.submit([BigInt(1), deliverable, "0x"]),
        /Unauthorized/
      );
    });
  });

  // ============================================================
  // complete Tests
  // ============================================================

  describe("complete", async () => {
    it("should allow evaluator to complete a submitted job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.complete([BigInt(1), keccak256(toHex("reason")), "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Completed);
    });

    it("should pay full budget to provider when no fees set", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      const providerBalanceBefore = await token.read.balanceOf([providerAddress]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.complete([BigInt(1), keccak256(toHex("reason")), "0x"]);

      const providerBalanceAfter = await token.read.balanceOf([providerAddress]);
      assert.equal(providerBalanceAfter - providerBalanceBefore, DEFAULT_BUDGET);
    });

    it("should revert if not evaluator (Unauthorized)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.complete([BigInt(1), keccak256(toHex("reason")), "0x"]),
        /Unauthorized/
      );
    });

    it("should revert if not Submitted (WrongStatus)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      // Job is Funded, not Submitted
      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });

      await assert.rejects(
        apexAsEvaluator.write.complete([BigInt(1), keccak256(toHex("reason")), "0x"]),
        /WrongStatus/
      );
    });
  });

  // ============================================================
  // reject Tests
  // ============================================================

  describe("reject", async () => {
    it("should allow client to reject an Open job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.reject([BigInt(1), keccak256(toHex("reason")), "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Rejected);
    });

    it("should allow evaluator to reject a Funded job with refund", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const clientBalanceBefore = await token.read.balanceOf([clientAddress]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.reject([BigInt(1), keccak256(toHex("reason")), "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Rejected);

      const clientBalanceAfter = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceAfter - clientBalanceBefore, DEFAULT_BUDGET);
    });

    it("should allow evaluator to reject a Submitted job with refund", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      const clientBalanceBefore = await token.read.balanceOf([clientAddress]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.reject([BigInt(1), keccak256(toHex("reason")), "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Rejected);

      const clientBalanceAfter = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceAfter - clientBalanceBefore, DEFAULT_BUDGET);
    });

    it("should revert if unauthorized (Unauthorized)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.reject([BigInt(1), keccak256(toHex("reason")), "0x"]),
        /Unauthorized/
      );
    });
  });

  // ============================================================
  // claimRefund Tests
  // ============================================================

  describe("claimRefund", async () => {
    it("should refund client after expiry", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      // Travel past expiry
      const job = await apex.read.getJob([BigInt(1)]);
      await testClient.setNextBlockTimestamp({ timestamp: job.expiredAt + BigInt(1) });
      await testClient.mine({ blocks: 1 });

      const clientBalanceBefore = await token.read.balanceOf([clientAddress]);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.claimRefund([BigInt(1)]);

      const jobAfter = await apex.read.getJob([BigInt(1)]);
      assert.equal(jobAfter.status, JobStatus.Expired);

      const clientBalanceAfter = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceAfter - clientBalanceBefore, DEFAULT_BUDGET);
    });

    it("should revert before expiry (WrongStatus)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      // Use a far-future expiry so the job is definitely not expired yet
      const expiredAt = await futureTimestamp(86400 * 365);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), DEFAULT_BUDGET, "0x"]);

      await token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);
      await apexAsClient.write.fund([BigInt(1), DEFAULT_BUDGET, "0x"]);

      // Job has not expired yet
      await assert.rejects(
        apexAsClient.write.claimRefund([BigInt(1)]),
        /WrongStatus/
      );
    });

    it("should revert for non-Funded/Submitted job (WrongStatus)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      // Open job — not in Funded/Submitted state
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.claimRefund([BigInt(1)]),
        /WrongStatus/
      );
    });
  });

  // ============================================================
  // Fees Tests
  // ============================================================

  describe("Fees", async () => {
    it("setPlatformFee sets fee and treasury, only ADMIN_ROLE", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await apexAsDeployer.write.setPlatformFee([BigInt(250), otherAddress]);

      const feeBP = await apex.read.platformFeeBP();
      const treas = await apex.read.platformTreasury();
      assert.equal(feeBP, BigInt(250));
      assert.equal(getAddress(treas), otherAddress);
    });

    it("setEvaluatorFee sets fee, only ADMIN_ROLE", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await apexAsDeployer.write.setEvaluatorFee([BigInt(500)]);

      const feeBP = await apex.read.evaluatorFeeBP();
      assert.equal(feeBP, BigInt(500));
    });

    it("complete() with platformFee=250bp: treasury gets 2.5%, provider gets 97.5%", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.setPlatformFee([BigInt(250), treasuryAddress]);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      const treasuryBalanceBefore = await token.read.balanceOf([treasuryAddress]);
      const providerBalanceBefore = await token.read.balanceOf([providerAddress]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.complete([jobId, keccak256(toHex("reason")), "0x"]);

      const treasuryBalanceAfter = await token.read.balanceOf([treasuryAddress]);
      const providerBalanceAfter = await token.read.balanceOf([providerAddress]);

      const expectedPlatformFee = (DEFAULT_BUDGET * BigInt(250)) / BigInt(10000);
      const expectedNet = DEFAULT_BUDGET - expectedPlatformFee;

      assert.equal(treasuryBalanceAfter - treasuryBalanceBefore, expectedPlatformFee);
      assert.equal(providerBalanceAfter - providerBalanceBefore, expectedNet);
    });

    it("complete() with platformFee=250bp + evaluatorFee=500bp: treasury gets 2.5%, evaluator gets 5%, provider gets 92.5%", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.setPlatformFee([BigInt(250), treasuryAddress]);
      await apexAsDeployer.write.setEvaluatorFee([BigInt(500)]);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      const treasuryBalanceBefore = await token.read.balanceOf([treasuryAddress]);
      const evaluatorBalanceBefore = await token.read.balanceOf([evaluatorAddress]);
      const providerBalanceBefore = await token.read.balanceOf([providerAddress]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.complete([jobId, keccak256(toHex("reason")), "0x"]);

      const treasuryBalanceAfter = await token.read.balanceOf([treasuryAddress]);
      const evaluatorBalanceAfter = await token.read.balanceOf([evaluatorAddress]);
      const providerBalanceAfter = await token.read.balanceOf([providerAddress]);

      const expectedPlatformFee = (DEFAULT_BUDGET * BigInt(250)) / BigInt(10000);
      const expectedEvalFee = (DEFAULT_BUDGET * BigInt(500)) / BigInt(10000);
      const expectedNet = DEFAULT_BUDGET - expectedPlatformFee - expectedEvalFee;

      assert.equal(treasuryBalanceAfter - treasuryBalanceBefore, expectedPlatformFee);
      assert.equal(evaluatorBalanceAfter - evaluatorBalanceBefore, expectedEvalFee);
      assert.equal(providerBalanceAfter - providerBalanceBefore, expectedNet);
    });

    it("total fees > 10000bp reverts with FeesTooHigh", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.setPlatformFee([BigInt(5000), treasuryAddress]);

      await assert.rejects(
        apexAsDeployer.write.setEvaluatorFee([BigInt(6000)]),
        /FeesTooHigh/
      );
    });

    it("non-admin cannot call setPlatformFee (AccessControlUnauthorizedAccount)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setPlatformFee([BigInt(250), treasuryAddress]),
        /AccessControlUnauthorizedAccount/
      );
    });
  });

  // ============================================================
  // Pause Tests
  // ============================================================

  describe("Pause", async () => {
    it("pause() by admin pauses the contract", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.pause();

      const paused = await apex.read.paused();
      assert.equal(paused, true);
    });

    it("createJob reverts when paused (EnforcedPause)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.pause();

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]),
        /EnforcedPause/
      );
    });

    it("fund reverts when paused", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), DEFAULT_BUDGET, "0x"]);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.pause();

      await token.write.mint([clientAddress, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, DEFAULT_BUDGET]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), DEFAULT_BUDGET, "0x"]),
        /EnforcedPause/
      );
    });

    it("claimRefund works when paused (critical safety test)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      // Set up a funded job with a near-future expiry BEFORE pausing
      const expiredAt = await futureTimestamp(3600);
      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET,
        zeroAddress, expiredAt
      );

      // Travel past expiry
      await testClient.setNextBlockTimestamp({ timestamp: expiredAt + BigInt(1) });
      await testClient.mine({ blocks: 1 });

      // Now pause the contract
      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.pause();

      const clientBalanceBefore = await token.read.balanceOf([clientAddress]);

      // claimRefund must still work even while paused
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.claimRefund([jobId]);

      const clientBalanceAfter = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceAfter - clientBalanceBefore, DEFAULT_BUDGET);

      const jobAfter = await apex.read.getJob([jobId]);
      assert.equal(jobAfter.status, JobStatus.Expired);
    });

    it("unpause() resumes operations", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });
      await apexAsDeployer.write.pause();
      await apexAsDeployer.write.unpause();

      const paused = await apex.read.paused();
      assert.equal(paused, false);

      // createJob should work again
      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job after unpause", zeroAddress]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Open);
    });

    it("non-admin cannot pause (AccessControlUnauthorizedAccount)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.pause(),
        /AccessControlUnauthorizedAccount/
      );
    });
  });

  // ============================================================
  // HookWhitelist Tests
  // ============================================================

  describe("HookWhitelist", async () => {
    it("setHookWhitelist adds hook, emits HookWhitelistUpdated", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      const fakeHook = otherAddress;
      const hash = await apexAsDeployer.write.setHookWhitelist([fakeHook, true]);
      const receipt = await publicClient.getTransactionReceipt({ hash });

      // Verify whitelisted
      const isWhitelisted = await apex.read.whitelistedHooks([fakeHook]);
      assert.equal(isWhitelisted, true);

      // Verify event was emitted (at least one log present)
      assert.ok(receipt.logs.length > 0, "Expected at least one log (HookWhitelistUpdated)");
    });

    it("address(0) is whitelisted by default (createJob with zeroAddress hook succeeds)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const isWhitelisted = await apex.read.whitelistedHooks([zeroAddress]);
      assert.equal(isWhitelisted, true);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      // Should not revert
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Hook test", zeroAddress]);
      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Open);
    });

    it("non-whitelisted hook reverts createJob with HookNotWhitelisted", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      // Use a non-whitelisted address as hook
      const nonWhitelistedHook = otherAddress;

      await assert.rejects(
        apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Hook test", nonWhitelistedHook]),
        /HookNotWhitelisted/
      );
    });

    it("non-admin cannot call setHookWhitelist (AccessControlUnauthorizedAccount)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setHookWhitelist([otherAddress, true]),
        /AccessControlUnauthorizedAccount/
      );
    });
  });

  // ============================================================
  // ReputationSignal Tests
  // ============================================================

  describe("ReputationSignal", async () => {
    it("complete() emits ReputationSignal(jobId, provider, 'provider', 1)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      const hash = await apexAsEvaluator.write.complete([jobId, keccak256(toHex("reason")), "0x"]);
      const receipt = await publicClient.getTransactionReceipt({ hash });

      const events = await publicClient.getContractEvents({
        address: apex.address,
        abi: apex.abi,
        eventName: "ReputationSignal",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.jobId, jobId);
      assert.equal(getAddress(events[0].args.subject!), providerAddress);
      assert.equal(events[0].args.role, "provider");
      assert.equal(events[0].args.signal, 1);
    });

    it("reject() from Funded emits ReputationSignal(jobId, provider, 'provider', -1)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      const hash = await apexAsEvaluator.write.reject([jobId, keccak256(toHex("reason")), "0x"]);
      const receipt = await publicClient.getTransactionReceipt({ hash });

      const events = await publicClient.getContractEvents({
        address: apex.address,
        abi: apex.abi,
        eventName: "ReputationSignal",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.jobId, jobId);
      assert.equal(getAddress(events[0].args.subject!), providerAddress);
      assert.equal(events[0].args.role, "provider");
      assert.equal(events[0].args.signal, -1);
    });

    it("claimRefund() emits ReputationSignal(jobId, provider, 'provider', 0)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET,
        zeroAddress, expiredAt
      );

      await testClient.setNextBlockTimestamp({ timestamp: expiredAt + BigInt(1) });
      await testClient.mine({ blocks: 1 });

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      const hash = await apexAsClient.write.claimRefund([jobId]);
      const receipt = await publicClient.getTransactionReceipt({ hash });

      const events = await publicClient.getContractEvents({
        address: apex.address,
        abi: apex.abi,
        eventName: "ReputationSignal",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(events.length, 1);
      assert.equal(events[0].args.jobId, jobId);
      assert.equal(getAddress(events[0].args.subject!), providerAddress);
      assert.equal(events[0].args.role, "provider");
      assert.equal(events[0].args.signal, 0);
    });

    it("reject() from Open does NOT emit ReputationSignal", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const hash = await apexAsClient.write.reject([BigInt(1), keccak256(toHex("reason")), "0x"]);
      const receipt = await publicClient.getTransactionReceipt({ hash });

      const events = await publicClient.getContractEvents({
        address: apex.address,
        abi: apex.abi,
        eventName: "ReputationSignal",
        fromBlock: receipt.blockNumber,
        toBlock: receipt.blockNumber,
      });

      assert.equal(events.length, 0, "Expected no ReputationSignal for Open job rejection");
    });
  });

  // ============================================================
  // Full Lifecycle Test
  // ============================================================

  describe("Full lifecycle", async () => {
    it("should complete Open -> Funded -> Submitted -> Completed lifecycle", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, treasuryAddress, deployerAddress);

      const expiredAt = await futureTimestamp(86400);
      const budget = DEFAULT_BUDGET;

      // Step 1: Create job (Open)
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress, evaluatorAddress, expiredAt, "Full lifecycle job", zeroAddress,
      ]);

      let job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Open);

      // Step 2: Set budget
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      // Step 3: Fund job (Open -> Funded)
      await token.write.mint([clientAddress, budget]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Funded);

      // Step 4: Provider submits (Funded -> Submitted)
      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      const deliverable = keccak256(toHex("the work product"));
      await apexAsProvider.write.submit([BigInt(1), deliverable, "0x"]);

      job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Submitted);

      // Step 5: Evaluator completes (Submitted -> Completed)
      const providerBalanceBefore = await token.read.balanceOf([providerAddress]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: evaluator },
      });
      await apexAsEvaluator.write.complete([BigInt(1), keccak256(toHex("approved")), "0x"]);

      job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, JobStatus.Completed);

      // Verify provider received payment
      const providerBalanceAfter = await token.read.balanceOf([providerAddress]);
      assert.equal(providerBalanceAfter - providerBalanceBefore, budget);
    });
  });
});
