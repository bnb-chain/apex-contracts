import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, toHex, zeroAddress } from "viem";
import { JobStatus, DEFAULT_BUDGET, DEFAULT_BOND, DEFAULT_LIVENESS } from "./constants.js";
import {
  deployMockToken,
  mintTokens,
  deployAPEXProxy,
  deployEvaluatorProxy,
  deployMockOOv3,
  createAndFundJob,
} from "./deploy.js";

describe("APEXEvaluatorUpgradeable", async function () {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const testClient = await viem.getTestClient();

  const [deployer, client, provider, other] = await viem.getWalletClients();
  const deployerAddress = getAddress(deployer.account.address);
  const clientAddress = getAddress(client.account.address);
  const providerAddress = getAddress(provider.account.address);
  const otherAddress = getAddress(other.account.address);

  /**
   * Deploy full test stack: token, apex, mockOOv3, evaluator.
   * Bond tokens are minted to provider (not deposited into evaluator pool).
   */
  async function deployStack() {
    const token = await deployMockToken(viem);
    const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);
    const oov3 = await deployMockOOv3(viem, DEFAULT_BOND);

    const evaluator = await deployEvaluatorProxy(
      viem,
      deployerAddress,
      apex.address,
      oov3.address,
      token.address,
      DEFAULT_LIVENESS
    );

    // Whitelist the evaluator as a hook (required by new contract)
    const apexAsDeployer = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
      client: { wallet: deployer },
    });
    await apexAsDeployer.write.setHookWhitelist([evaluator.address as `0x${string}`, true]);

    // Mint bond tokens to provider so they can pay the bond themselves
    await token.write.mint([providerAddress, DEFAULT_BOND * BigInt(10)]);

    return { token, apex, oov3, evaluator };
  }

  // ============================================================
  // Initialization Tests
  // ============================================================

  describe("Initialization", async () => {
    it("should initialize with correct parameters", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();

      const erc8183 = await evaluator.read.erc8183();
      const oov3Addr = await evaluator.read.oov3();
      const bondToken = await evaluator.read.bondToken();
      const liveness = await evaluator.read.liveness();
      const version = await evaluator.read.VERSION();

      assert.equal(getAddress(erc8183 as string), getAddress(apex.address));
      assert.equal(getAddress(oov3Addr as string), getAddress(oov3.address));
      assert.equal(getAddress(bondToken as string), getAddress(token.address));
      assert.equal(liveness, DEFAULT_LIVENESS);
      assert.equal(version, BigInt(5));
    });

    it("should not allow re-initialization", async () => {
      const { evaluator, apex, oov3, token } = await deployStack();

      // InvalidInitialization() — selector 0xf92ee8a9 (may appear as "unrecognized custom error" in viem)
      await assert.rejects(
        evaluator.write.initialize([deployerAddress, apex.address, oov3.address, token.address, DEFAULT_LIVENESS]),
        /InvalidInitialization|0xf92ee8a9|unrecognized custom error/
      );
    });
  });

  // ============================================================
  // Bond Management Tests (deprecated pool)
  // ============================================================

  describe("Bond Management (Deprecated)", async () => {
    it("should revert depositBond as deprecated", async () => {
      const { evaluator } = await deployStack();

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        evalAsDeployer.write.depositBond([DEFAULT_BOND]),
        /deprecated/i
      );
    });

    it("should revert withdrawBond as deprecated", async () => {
      const { evaluator } = await deployStack();

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        evalAsDeployer.write.withdrawBond([DEFAULT_BOND]),
        /deprecated/i
      );
    });

    it("totalLockedBond should start at zero", async () => {
      const { evaluator } = await deployStack();
      const locked = await evaluator.read.totalLockedBond();
      assert.equal(locked, BigInt(0));
    });
  });

  // ============================================================
  // Hook Callback Tests
  // ============================================================

  describe("Hook Callbacks", async () => {
    it("should revert beforeAction from non-erc8183 caller", async () => {
      const { evaluator } = await deployStack();

      const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        evalAsOther.write.beforeAction([BigInt(1), "0x12345678", "0x"]),
        /OnlyERC8183/
      );
    });

    it("should revert afterAction from non-erc8183 caller", async () => {
      const { evaluator } = await deployStack();

      const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        evalAsOther.write.afterAction([BigInt(1), "0x12345678", "0x"]),
        /OnlyERC8183/
      );
    });

    it("should NOT auto-initiate assertion on submit", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();

      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress,
        evaluator.address as `0x${string}`, DEFAULT_BUDGET,
        evaluator.address as `0x${string}` // hook = evaluator
      );

      // Submit — hook fires but should NOT auto-initiate assertion
      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      // Assertion must NOT be initiated
      const initiated = await evaluator.read.jobAssertionInitiated([jobId]);
      assert.equal(initiated, false);

      const pending = await evaluator.read.pendingAssertions();
      assert.equal(pending, BigInt(0));
    });
  });

  // ============================================================
  // Assertion Lifecycle Tests
  // ============================================================

  describe("Assertion Lifecycle", async () => {
    it("should initiate assertion when provider approves and calls initiateAssertion", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();

      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress,
        evaluator.address as `0x${string}`, DEFAULT_BUDGET,
        evaluator.address as `0x${string}` // hook = evaluator
      );

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      // Assertion not yet initiated
      assert.equal(await evaluator.read.jobAssertionInitiated([jobId]), false);

      // Provider approves bond token to evaluator
      const tokenAsProvider = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: provider },
      });
      await tokenAsProvider.write.approve([evaluator.address, DEFAULT_BOND]);

      // Provider initiates assertion
      const evalAsProvider = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: provider },
      });
      await evalAsProvider.write.initiateAssertion([jobId]);

      const initiated = await evaluator.read.jobAssertionInitiated([jobId]);
      assert.equal(initiated, true);

      const pending = await evaluator.read.pendingAssertions();
      assert.equal(pending, BigInt(1));

      // Asserter recorded correctly
      const asserter = await evaluator.read.jobAsserter([jobId]);
      assert.equal(getAddress(asserter as string), providerAddress);

      // totalLockedBond incremented
      const locked = await evaluator.read.totalLockedBond();
      assert.equal(locked, DEFAULT_BOND);
    });

    it("should revert initiateAssertion from non-provider", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();

      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress,
        evaluator.address as `0x${string}`, DEFAULT_BUDGET,
        zeroAddress
      );

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("deliverable")), "0x"]);

      // Other user attempts to initiate — should fail
      const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        evalAsOther.write.initiateAssertion([jobId]),
        /CallerNotAllowed/
      );
    });

    it("should settle job and return bond to provider", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();

      const budget = DEFAULT_BUDGET;
      const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 7200);

      const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: client },
      });
      await apexAsClient.write.createJob([
        providerAddress,
        evaluator.address as `0x${string}`,
        expiredAt,
        "Test job",
        zeroAddress, // no hook — avoids reentrancy in settlement
      ]);
      await apexAsClient.write.setBudget([BigInt(1), budget, "0x"]);

      await token.write.mint([clientAddress, budget]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: client },
      });
      await tokenAsClient.write.approve([apex.address, budget]);
      await apexAsClient.write.fund([BigInt(1), budget, "0x"]);

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([BigInt(1), keccak256(toHex("deliverable")), "0x"]);

      // Provider approves bond and initiates assertion
      const tokenAsProvider = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: provider },
      });
      await tokenAsProvider.write.approve([evaluator.address, DEFAULT_BOND]);

      const providerBalBefore = await token.read.balanceOf([providerAddress]);

      const evalAsProvider = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: provider },
      });
      await evalAsProvider.write.initiateAssertion([BigInt(1)]);

      // Bond deducted from provider
      const providerBalAfterInitiate = await token.read.balanceOf([providerAddress]);
      assert.equal(providerBalAfterInitiate, providerBalBefore - DEFAULT_BOND);

      // Fast forward past liveness
      await testClient.increaseTime({ seconds: Number(DEFAULT_LIVENESS) + 1 });
      await testClient.mine({ blocks: 1 });

      const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: other },
      });
      await evalAsOther.write.settleJob([BigInt(1)]);

      const pending = await evaluator.read.pendingAssertions();
      assert.equal(pending, BigInt(0));

      // Bond should be returned to provider
      const providerBalAfterSettle = await token.read.balanceOf([providerAddress]);
      assert.equal(providerBalAfterSettle, providerBalBefore);

      // totalLockedBond should be zero
      const locked = await evaluator.read.totalLockedBond();
      assert.equal(locked, BigInt(0));
    });

    it("should revert settleJob if no assertion exists", async () => {
      const { evaluator } = await deployStack();

      const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        evalAsOther.write.settleJob([BigInt(999)]),
        /NoAssertionForJob/
      );
    });

    it("should revert double assertion initiation", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();

      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress,
        evaluator.address as `0x${string}`, DEFAULT_BUDGET,
        zeroAddress
      );

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("d")), "0x"]);

      // First initiation
      const tokenAsProvider = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: provider },
      });
      await tokenAsProvider.write.approve([evaluator.address, DEFAULT_BOND * BigInt(2)]);

      const evalAsProvider = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: provider },
      });
      await evalAsProvider.write.initiateAssertion([jobId]);

      // Try again — should fail
      await assert.rejects(
        evalAsProvider.write.initiateAssertion([jobId]),
        /AssertionAlreadyInitiated/
      );
    });

    it("should revert initiateAssertion if provider has insufficient bond allowance", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();

      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress,
        evaluator.address as `0x${string}`, DEFAULT_BUDGET,
        zeroAddress
      );

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("d")), "0x"]);

      // No approval — should revert
      const evalAsProvider = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: provider },
      });
      await assert.rejects(
        evalAsProvider.write.initiateAssertion([jobId]),
        /reverted|ERC20InsufficientAllowance|insufficient allowance/i
      );
    });
  });

  // ============================================================
  // Admin Functions Tests
  // ============================================================

  describe("Admin Functions", async () => {
    it("should allow owner to set liveness", async () => {
      const { evaluator } = await deployStack();

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await evalAsDeployer.write.setLiveness([BigInt(3600)]);
      const newLiveness = await evaluator.read.liveness();
      assert.equal(newLiveness, BigInt(3600));
    });

    it("should revert setLiveness with zero", async () => {
      const { evaluator } = await deployStack();

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        evalAsDeployer.write.setLiveness([BigInt(0)]),
        /invalid liveness/
      );
    });

    it("should allow owner to pause and unpause", async () => {
      const { evaluator } = await deployStack();

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await evalAsDeployer.write.pause();

      // Paused: initiateAssertion should fail
      await assert.rejects(
        evalAsDeployer.write.initiateAssertion([BigInt(1)]),
        /EnforcedPause/
      );

      await evalAsDeployer.write.unpause();
    });

    it("should revert pause from non-owner", async () => {
      const { evaluator } = await deployStack();

      const evalAsOther = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: other },
      });

      await assert.rejects(
        evalAsOther.write.pause(),
        /OwnableUnauthorizedAccount/
      );
    });

    it("should allow owner to set ERC8183 when no pending assertions", async () => {
      const { evaluator, token } = await deployStack();
      const newApex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await evalAsDeployer.write.setERC8183([newApex.address]);
      const updated = await evaluator.read.erc8183();
      assert.equal(getAddress(updated as string), getAddress(newApex.address));
    });

    it("should revert setERC8183 with zero address", async () => {
      const { evaluator } = await deployStack();

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        evalAsDeployer.write.setERC8183([zeroAddress]),
        /invalid erc8183/
      );
    });

    it("should allow owner to set bond token when no active assertions", async () => {
      const token = await deployMockToken(viem);
      const token2 = await deployMockToken(viem);
      const apex = await deployAPEXProxy(viem, token.address, deployerAddress, deployerAddress);
      const oov3 = await deployMockOOv3(viem, DEFAULT_BOND);

      const evaluator = await deployEvaluatorProxy(
        viem, deployerAddress, apex.address, oov3.address, token.address, DEFAULT_LIVENESS
      );

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await evalAsDeployer.write.setBondToken([token2.address]);
      const newBondToken = await evaluator.read.bondToken();
      assert.equal(getAddress(newBondToken as string), getAddress(token2.address));
    });

    it("should revert setBondToken when there are active assertions", async () => {
      const { token, apex, oov3, evaluator } = await deployStack();
      const token2 = await deployMockToken(viem);

      // Create an active assertion
      const jobId = await createAndFundJob(
        viem, apex, token, client, providerAddress,
        evaluator.address as `0x${string}`, DEFAULT_BUDGET,
        zeroAddress
      );

      const apexAsProvider = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
        client: { wallet: provider },
      });
      await apexAsProvider.write.submit([jobId, keccak256(toHex("d")), "0x"]);

      const tokenAsProvider = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: provider },
      });
      await tokenAsProvider.write.approve([evaluator.address, DEFAULT_BOND]);

      const evalAsProvider = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: provider },
      });
      await evalAsProvider.write.initiateAssertion([jobId]);

      const evalAsDeployer = await viem.getContractAt("APEXEvaluatorUpgradeable", evaluator.address, {
        client: { wallet: deployer },
      });

      await assert.rejects(
        evalAsDeployer.write.setBondToken([token2.address]),
        /cannot change bond token with active assertions/
      );
    });
  });

  // ============================================================
  // Query Function Tests
  // ============================================================

  describe("Query Functions", async () => {
    it("getAssertionInfo should return defaults for non-existent job", async () => {
      const { evaluator } = await deployStack();

      const info = await evaluator.read.getAssertionInfo([BigInt(999)]);
      assert.equal(info[0], "0x0000000000000000000000000000000000000000000000000000000000000000"); // assertionId
      assert.equal(info[1], false); // initiated
      assert.equal(info[2], false); // disputed
    });

    it("isSettleable should return false for non-existent job", async () => {
      const { evaluator } = await deployStack();
      const settleable = await evaluator.read.isSettleable([BigInt(999)]);
      assert.equal(settleable, false);
    });

    it("getLivenessEnd should return 0 for non-existent job", async () => {
      const { evaluator } = await deployStack();
      const end = await evaluator.read.getLivenessEnd([BigInt(999)]);
      assert.equal(end, BigInt(0));
    });

    it("jobAsserter should return zero address for job without assertion", async () => {
      const { evaluator } = await deployStack();
      const asserter = await evaluator.read.jobAsserter([BigInt(999)]);
      assert.equal(asserter, zeroAddress);
    });
  });
});
