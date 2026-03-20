import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, toHex, zeroAddress } from "viem";
import { Status, MIN_BUDGET, DEFAULT_BUDGET } from "./constants.js";
import { deployMockToken, mintTokens, deployAPEXProxy, createAndFundJob } from "./deploy.js";

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

  // ============================================================
  // Deployment Tests
  // ============================================================

  describe("Deployment", async () => {
    it("should initialize with correct parameters", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const paymentToken = await apex.read.paymentToken();
      const minBudget = await apex.read.minBudget();
      const nextJobId = await apex.read.nextJobId();
      const owner = await apex.read.owner();

      assert.equal(getAddress(paymentToken), getAddress(token.address));
      assert.equal(minBudget, MIN_BUDGET);
      assert.equal(nextJobId, BigInt(1));
      assert.equal(getAddress(owner), deployerAddress);
    });

    it("should not allow re-initialization", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      await assert.rejects(
        apex.write.initialize([deployerAddress, token.address, BigInt(0)]),
        /InvalidInitialization/
      );
    });

    it("should revert with zero payment token", async () => {
      const impl = await viem.deployContract("AgenticCommerceUpgradeable");

      await assert.rejects(
        viem.deployContract("ERC1967Proxy", [
          impl.address,
          // Manually encode initialize with zero token
          "0xc0c53b8b" + // initialize(address,address,uint256)
          "0000000000000000000000000000000000000000000000000000000000000001" +
          "0000000000000000000000000000000000000000000000000000000000000000" +
          "0000000000000000000000000000000000000000000000000000000000000000",
        ])
      );
    });
  });

  // ============================================================
  // Job Creation Tests
  // ============================================================

  describe("createJob", async () => {
    it("should create a job with provider and evaluator", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
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
      assert.equal(getAddress(job.client), clientAddress);
      assert.equal(getAddress(job.provider), providerAddress);
      assert.equal(getAddress(job.evaluator), evaluatorAddress);
      assert.equal(job.status, Status.Open);
      assert.equal(job.description, description);
    });

    it("should create a job without provider (set later)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
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
      assert.equal(job.status, Status.Open);
    });

    it("should revert with zero evaluator", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
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
        /InvalidEvaluator/
      );
    });

    it("should revert with expired timestamp", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) - 100);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.createJob([
          providerAddress,
          evaluatorAddress,
          expiredAt,
          "Expired job",
          zeroAddress,
        ]),
        /InvalidExpiry/
      );
    });

    it("should revert if expiry exceeds MAX_EXPIRY_DURATION", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000)) + BigInt(366 * 24 * 60 * 60);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.createJob([
          providerAddress,
          evaluatorAddress,
          expiredAt,
          "Too far",
          zeroAddress,
        ]),
        /InvalidExpiry/
      );
    });

    it("should increment jobId for each new job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job 1", zeroAddress]);
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job 2", zeroAddress]);

      const nextJobId = await apex.read.nextJobId();
      assert.equal(nextJobId, BigInt(3));
    });
  });

  // ============================================================
  // setProvider Tests
  // ============================================================

  describe("setProvider", async () => {
    it("should set provider for job created without one", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setProvider([BigInt(1), providerAddress, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(getAddress(job.provider), providerAddress);
    });

    it("should revert if not client", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setProvider([BigInt(1), providerAddress, "0x"]),
        /NotClient/
      );
    });

    it("should revert if provider already set", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.setProvider([BigInt(1), otherAddress, "0x"]),
        /ProviderAlreadySet/
      );
    });

    it("should revert with zero provider address", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.setProvider([BigInt(1), zeroAddress, "0x"]),
        /InvalidProvider/
      );
    });
  });

  // ============================================================
  // setBudget Tests
  // ============================================================

  describe("setBudget", async () => {
    it("should allow client to set budget", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
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
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });

      const budget = BigInt(5000000);
      await apexAsProvider.write.setBudget([BigInt(1), budget, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.budget, budget);
    });

    it("should revert if not client or provider", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setBudget([BigInt(1), BigInt(1000000), "0x"]),
        /NotClientOrProvider/
      );
    });
  });

  // ============================================================
  // fund Tests
  // ============================================================

  describe("fund", async () => {
    it("should fund job and transition to Funded status", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = DEFAULT_BUDGET;

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Funded);

      const contractBalance = await token.read.balanceOf([apex.address]);
      assert.equal(contractBalance, budget);

      const totalEscrowed = await apex.read.totalEscrowed();
      assert.equal(totalEscrowed, budget);
    });

    it("should revert if budget mismatch (front-running protection)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = DEFAULT_BUDGET;

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, budget]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), BigInt(5000000), "0x"]),
        /BudgetMismatch/
      );
    });

    it("should revert if provider not set", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = DEFAULT_BUDGET;

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([zeroAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), budget, "0x"]),
        /ProviderNotSet/
      );
    });

    it("should revert if budget too low", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, BigInt(10_000_000));

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = BigInt(100); // below min

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, budget]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), budget, "0x"]),
        /BudgetTooLow/
      );
    });

    it("should revert if budget not set", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.fund([BigInt(1), BigInt(0), "0x"]),
        /BudgetNotSet/
      );
    });
  });

  // ============================================================
  // submit Tests
  // ============================================================

  describe("submit", async () => {
    it("should allow provider to submit work", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);
      const deliverable = keccak256(toHex("deliverable-cid"));

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, deliverable, "0x"]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, Status.Submitted);
      assert.equal(job.deliverable, deliverable);
    });

    it("should revert if not provider", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });

      await assert.rejects(
        apexAsClient.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]),
        /NotProvider/
      );
    });

    it("should revert if job not funded", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });

      await assert.rejects(
        apexAsProvider.write.submit([BigInt(1), keccak256(toHex("d")), "0x"]),
        /InvalidStatus/
      );
    });
  });

  // ============================================================
  // complete Tests
  // ============================================================

  describe("complete", async () => {
    it("should allow evaluator to complete job and release payment", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);
      const deliverable = keccak256(toHex("deliverable"));

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([jobId, deliverable, "0x"]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });
      const reason = keccak256(toHex("approved"));
      await apexAsEvaluator.write.complete([jobId, reason, "0x"]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, Status.Completed);

      const providerBalance = await token.read.balanceOf([providerAddress]);
      assert.equal(providerBalance, DEFAULT_BUDGET);

      const totalEscrowed = await apex.read.totalEscrowed();
      assert.equal(totalEscrowed, BigInt(0));
    });

    it("should revert if not evaluator", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });

      await assert.rejects(
        apexAsClient.write.complete([jobId, keccak256(toHex("reason")), "0x"]),
        /NotEvaluator/
      );
    });

    it("should revert if job not submitted", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });

      await assert.rejects(
        apexAsEvaluator.write.complete([jobId, keccak256(toHex("reason")), "0x"]),
        /InvalidStatus/
      );
    });
  });

  // ============================================================
  // reject Tests
  // ============================================================

  describe("reject", async () => {
    it("should allow client to reject job when Open", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const reason = keccak256(toHex("cancelled"));
      await apexAsClient.write.reject([BigInt(1), reason, "0x"]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Rejected);
    });

    it("should allow evaluator to reject and refund when Funded", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const clientBalanceBefore = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceBefore, BigInt(0));

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });
      await apexAsEvaluator.write.reject([jobId, keccak256(toHex("rejected")), "0x"]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, Status.Rejected);

      const clientBalanceAfter = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalanceAfter, DEFAULT_BUDGET);
    });

    it("should allow evaluator to reject and refund when Submitted", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });
      await apexAsEvaluator.write.reject([jobId, keccak256(toHex("rejected")), "0x"]);

      const job = await apex.read.getJob([jobId]);
      assert.equal(job.status, Status.Rejected);

      const clientBalance = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalance, DEFAULT_BUDGET);
    });

    it("should revert if non-client rejects Open job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: other } });

      await assert.rejects(
        apexAsOther.write.reject([BigInt(1), keccak256(toHex("reason")), "0x"]),
        /NotClient/
      );
    });

    it("should revert if rejecting completed job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const jobId = await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("d")), "0x"]);

      const apexAsEvaluator = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: evaluator } });
      await apexAsEvaluator.write.complete([jobId, keccak256(toHex("ok")), "0x"]);

      await assert.rejects(
        apexAsEvaluator.write.reject([jobId, keccak256(toHex("r")), "0x"]),
        /NotRefundable/
      );
    });
  });

  // ============================================================
  // claimRefund Tests
  // ============================================================

  describe("claimRefund", async () => {
    it("should refund client after expiry", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const block = await publicClient.getBlock();
      const expiredAt = block.timestamp + BigInt(60);
      const budget = DEFAULT_BUDGET;

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      await testClient.increaseTime({ seconds: 120 });
      await testClient.mine({ blocks: 1 });

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: other } });
      await apexAsOther.write.claimRefund([BigInt(1)]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Expired);

      const clientBalance = await token.read.balanceOf([clientAddress]);
      assert.equal(clientBalance, budget);
    });

    it("should refund when Submitted and expired", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const block = await publicClient.getBlock();
      const expiredAt = block.timestamp + BigInt(60);
      const budget = DEFAULT_BUDGET;

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: provider } });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("d")), "0x"]);

      await testClient.increaseTime({ seconds: 120 });
      await testClient.mine({ blocks: 1 });

      await apexAsClient.write.claimRefund([BigInt(1)]);

      const job = await apex.read.getJob([BigInt(1)]);
      assert.equal(job.status, Status.Expired);
    });

    it("should revert if not expired", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const budget = DEFAULT_BUDGET;

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await mintTokens(token, clientAddress, budget);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, { client: { wallet: client } });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      await assert.rejects(
        apexAsClient.write.claimRefund([BigInt(1)]),
        /NotExpired/
      );
    });

    it("should revert if job is Open (not refundable)", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, { client: { wallet: client } });
      await apexAsClient.write.createJob([providerAddress, evaluatorAddress, expiredAt, "Job", zeroAddress]);

      await assert.rejects(
        apexAsClient.write.claimRefund([BigInt(1)]),
        /NotRefundable/
      );
    });
  });

  // ============================================================
  // Admin Functions Tests
  // ============================================================

  describe("Admin Functions", async () => {
    it("should allow owner to set min budget", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await apexAsDeployer.write.setMinBudget([BigInt(5000000)]);
      const newMinBudget = await apex.read.minBudget();
      assert.equal(newMinBudget, BigInt(5000000));
    });

    it("should revert if non-owner tries to set min budget", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.setMinBudget([BigInt(5000000)]),
        /OwnableUnauthorizedAccount/
      );
    });

    it("should allow owner to set payment token when no escrows exist", async () => {
      const token = await deployMockToken(viem);
      const token2 = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await apexAsDeployer.write.setPaymentToken([token2.address]);
      const newToken = await apex.read.paymentToken();
      assert.equal(getAddress(newToken), getAddress(token2.address));
    });

    it("should revert setPaymentToken when active escrows exist", async () => {
      const token = await deployMockToken(viem);
      const token2 = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        apexAsDeployer.write.setPaymentToken([token2.address]),
        /ActiveEscrowsExist/
      );
    });

    it("should revert setPaymentToken with zero address", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        apexAsDeployer.write.setPaymentToken([zeroAddress]),
        /invalid token/
      );
    });

    it("should allow owner to rescue non-payment tokens", async () => {
      const token = await deployMockToken(viem);
      const otherToken = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      // Send some other tokens to the contract
      await otherToken.write.mint([apex.address, BigInt(1000)]);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await apexAsDeployer.write.rescueBEP20([otherToken.address, deployerAddress, BigInt(1000)]);

      const balance = await otherToken.read.balanceOf([deployerAddress]);
      assert.equal(balance, BigInt(1000));
    });

    it("should revert rescue of payment token if amount exceeds excess", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      await createAndFundJob(viem, apex, token, client, providerAddress, evaluatorAddress, DEFAULT_BUDGET);

      const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        apexAsDeployer.write.rescueBEP20([token.address, deployerAddress, DEFAULT_BUDGET]),
        /RescueExceedsExcess/
      );
    });

    it("should revert if non-owner tries to upgrade", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const newImpl = await viem.deployContract("AgenticCommerceUpgradeable");

      const apexAsOther = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        apexAsOther.write.upgradeToAndCall([newImpl.address, "0x"]),
        /OwnableUnauthorizedAccount/
      );
    });
  });

  // ============================================================
  // View Function Tests
  // ============================================================

  describe("View Functions", async () => {
    it("getJob should revert for non-existent job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      await assert.rejects(
        apex.read.getJob([BigInt(999)]),
        /JobNotFound/
      );
    });

    it("getJobStatus should return None for non-existent job", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const status = await apex.read.getJobStatus([BigInt(999)]);
      assert.equal(status, Status.None);
    });

    it("pendingWithdrawals should return 0 for new address", async () => {
      const token = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress);

      const pending = await apex.read.pendingWithdrawals([otherAddress]);
      assert.equal(pending, BigInt(0));
    });
  });
});
