import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, toBytes, zeroAddress } from "viem";

import {
  JobStatus,
  DEFAULT_BUDGET,
  ZERO_BYTES32,
  deployCommerce,
  deployMockToken,
  blockTimestamp,
  advanceSeconds,
} from "./helpers.js";

describe("AgenticCommerceUpgradeable", async () => {
  const { viem } = await network.connect();
  const publicClient = await viem.getPublicClient();

  const [deployerW, clientW, providerW, evaluatorW, treasuryW, otherW] =
    await viem.getWalletClients();
  const deployer = getAddress(deployerW.account.address);
  const client = getAddress(clientW.account.address);
  const provider = getAddress(providerW.account.address);
  const evaluator = getAddress(evaluatorW.account.address);
  const treasury = getAddress(treasuryW.account.address);
  const other = getAddress(otherW.account.address);

  async function setup() {
    const token = await deployMockToken(viem);
    const { proxy, impl } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner: deployer,
    });
    return { token, commerce: proxy, impl };
  }

  async function futureTs(offset = 3600): Promise<bigint> {
    return (await blockTimestamp(viem)) + BigInt(offset);
  }

  async function asClient(contract: any, wallet: any) {
    return viem.getContractAt("AgenticCommerceUpgradeable", contract.address, {
      client: { wallet },
    });
  }

  // ==================================================================
  // Deployment & initialisation
  // ==================================================================

  describe("initialize", () => {
    it("sets paymentToken, treasury, and owner", async () => {
      const { token, commerce } = await setup();
      assert.equal(getAddress(await commerce.read.paymentToken()), getAddress(token.address));
      assert.equal(getAddress(await commerce.read.platformTreasury()), treasury);
      assert.equal(getAddress(await commerce.read.owner()), deployer);
      assert.equal(await commerce.read.jobCounter(), 0n);
    });

    it("rejects zero addresses", async () => {
      const token = await deployMockToken(viem);
      await assert.rejects(
        deployCommerce(viem, {
          paymentToken: zeroAddress,
          treasury,
          owner: deployer,
        }),
        /ZeroAddress|reverted/i,
      );
      await assert.rejects(
        deployCommerce(viem, {
          paymentToken: token.address,
          treasury: zeroAddress,
          owner: deployer,
        }),
        /ZeroAddress|reverted/i,
      );
      await assert.rejects(
        deployCommerce(viem, {
          paymentToken: token.address,
          treasury,
          owner: zeroAddress,
        }),
        /ZeroAddress|reverted/i,
      );
    });

    it("disallows re-initialisation", async () => {
      const { token, commerce } = await setup();
      await assert.rejects(
        commerce.write.initialize([token.address, treasury, deployer]),
        /InvalidInitialization/,
      );
    });
  });

  // ==================================================================
  // createJob
  // ==================================================================

  describe("createJob", () => {
    it("creates an Open job", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      const expiredAt = await futureTs(3600);

      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        expiredAt,
        "Job #1",
        zeroAddress,
      ]);

      const job = await commerce.read.getJob([1n]);
      assert.equal(job.id, 1n);
      assert.equal(getAddress(job.client), client);
      assert.equal(getAddress(job.provider), provider);
      assert.equal(getAddress(job.evaluator), evaluator);
      assert.equal(job.status, JobStatus.Open);
      assert.equal(job.budget, 0n);
    });

    it("rejects zero evaluator", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await assert.rejects(
        commerceAsClient.write.createJob([
          provider,
          zeroAddress,
          await futureTs(3600),
          "",
          zeroAddress,
        ]),
        /ZeroAddress/,
      );
    });

    it("rejects expiry <= now + 5min", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await assert.rejects(
        commerceAsClient.write.createJob([
          provider,
          evaluator,
          await futureTs(60),
          "",
          zeroAddress,
        ]),
        /ExpiryTooShort/,
      );
    });

    it("rejects a hook that does not implement IACPHook", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      // MockERC20 does not implement IACPHook.
      await assert.rejects(
        commerceAsClient.write.createJob([
          provider,
          evaluator,
          await futureTs(3600),
          "",
          token.address,
        ]),
        /HookMissingInterface/,
      );
    });

    it("reverts when paused", async () => {
      const { commerce } = await setup();
      await commerce.write.pause();
      const commerceAsClient = await asClient(commerce, clientW);
      await assert.rejects(
        commerceAsClient.write.createJob([
          provider,
          evaluator,
          await futureTs(3600),
          "",
          zeroAddress,
        ]),
        /EnforcedPause/,
      );
    });
  });

  // ==================================================================
  // setProvider
  // ==================================================================

  describe("setProvider", () => {
    it("client can set provider when provider was unset", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        zeroAddress,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await commerceAsClient.write.setProvider([1n, provider, "0x"]);
      const job = await commerce.read.getJob([1n]);
      assert.equal(getAddress(job.provider), provider);
    });

    it("rejects non-client", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        zeroAddress,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      const commerceAsOther = await asClient(commerce, otherW);
      await assert.rejects(commerceAsOther.write.setProvider([1n, provider, "0x"]), /Unauthorized/);
    });

    it("rejects resetting provider", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await assert.rejects(commerceAsClient.write.setProvider([1n, other, "0x"]), /WrongStatus/);
    });
  });

  // ==================================================================
  // setBudget
  // ==================================================================

  describe("setBudget", () => {
    it("client OR provider may call", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);

      // Client sets.
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      let job = await commerce.read.getJob([1n]);
      assert.equal(job.budget, DEFAULT_BUDGET);

      // Provider can update again (still Open).
      const commerceAsProvider = await asClient(commerce, providerW);
      await commerceAsProvider.write.setBudget([1n, DEFAULT_BUDGET * 2n, "0x"]);
      job = await commerce.read.getJob([1n]);
      assert.equal(job.budget, DEFAULT_BUDGET * 2n);
      assert.equal(await commerce.read.jobHasBudget([1n]), true);
    });

    it("rejects unauthorized caller", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      const commerceAsOther = await asClient(commerce, otherW);
      await assert.rejects(
        commerceAsOther.write.setBudget([1n, DEFAULT_BUDGET, "0x"]),
        /Unauthorized/,
      );
    });
  });

  // ==================================================================
  // fund
  // ==================================================================

  describe("fund", () => {
    async function seedOpen() {
      const { token, commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      return { token, commerce, commerceAsClient };
    }

    it("escrows tokens and transitions to Funded", async () => {
      const { token, commerce, commerceAsClient } = await seedOpen();
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Funded);
      assert.equal(await token.read.balanceOf([commerce.address]), DEFAULT_BUDGET);
    });

    it("reverts on budget mismatch (front-running guard)", async () => {
      const { commerceAsClient } = await seedOpen();
      await assert.rejects(
        commerceAsClient.write.fund([1n, DEFAULT_BUDGET * 2n, "0x"]),
        /BudgetMismatch/,
      );
    });

    it("reverts without setBudget", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await assert.rejects(commerceAsClient.write.fund([1n, 0n, "0x"]), /ZeroBudget/);
    });

    it("reverts when provider unset", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        zeroAddress,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await assert.rejects(
        commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]),
        /ProviderNotSet/,
      );
    });
  });

  // ==================================================================
  // submit / complete / reject full path
  // ==================================================================

  describe("submit + complete + reject", () => {
    async function fundAndSubmit() {
      const { token, commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      const deliverable = keccak256(toBytes("payload"));
      const commerceAsProvider = await asClient(commerce, providerW);
      await commerceAsProvider.write.submit([1n, deliverable, "0x"]);
      return { token, commerce };
    }

    it("evaluator completes → provider receives net, treasury gets fee", async () => {
      const { token, commerce } = await fundAndSubmit();
      // Set a 5% fee.
      await commerce.write.setPlatformFee([500n, treasury]);
      const commerceAsEvaluator = await asClient(commerce, evaluatorW);
      await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);

      const fee = (DEFAULT_BUDGET * 500n) / 10_000n;
      const net = DEFAULT_BUDGET - fee;
      assert.equal(await token.read.balanceOf([provider]), net);
      assert.equal(await token.read.balanceOf([treasury]), fee);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Completed);
    });

    it("rejects `complete` from non-evaluator", async () => {
      const { commerce } = await fundAndSubmit();
      const commerceAsClient = await asClient(commerce, clientW);
      await assert.rejects(
        commerceAsClient.write.complete([1n, ZERO_BYTES32, "0x"]),
        /Unauthorized/,
      );
    });

    it("evaluator rejects submitted job → client refunded", async () => {
      const { token, commerce } = await fundAndSubmit();
      const commerceAsEvaluator = await asClient(commerce, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);
      assert.equal(await token.read.balanceOf([client]), DEFAULT_BUDGET);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Rejected);
    });

    it("client rejects Open job without refund branch", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await commerceAsClient.write.reject([1n, ZERO_BYTES32, "0x"]);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Rejected);
    });
  });

  // ==================================================================
  // claimRefund
  // ==================================================================

  describe("claimRefund", () => {
    it("refunds client after expiry, even while paused", async () => {
      const { token } = await setup();
      // Re-setup with short expiry.
      const { proxy: commerce } = await deployCommerce(viem, {
        paymentToken: token.address,
        treasury,
        owner: deployer,
      });
      const commerceAsClient = await asClient(commerce, clientW);
      const expiredAt = await futureTs(3600);
      await commerceAsClient.write.createJob([provider, evaluator, expiredAt, "", zeroAddress]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);

      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      await advanceSeconds(viem, 3700);
      // Pausing the kernel MUST NOT block claimRefund.
      await commerce.write.pause();

      await commerce.write.claimRefund([1n]);
      assert.equal(await token.read.balanceOf([client]), DEFAULT_BUDGET);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Expired);
    });

    it("reverts before expiry", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asClient(commerce, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        zeroAddress,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);
      await assert.rejects(commerce.write.claimRefund([1n]), /WrongStatus/);
    });
  });

  // ==================================================================
  // Admin
  // ==================================================================

  describe("admin", () => {
    it("setPlatformFee only by owner", async () => {
      const { commerce } = await setup();
      const asOther = await asClient(commerce, otherW);
      await assert.rejects(
        asOther.write.setPlatformFee([100n, treasury]),
        /OwnableUnauthorizedAccount/,
      );
      await commerce.write.setPlatformFee([100n, treasury]);
      assert.equal(await commerce.read.platformFeeBP(), 100n);
    });

    it("setPlatformFee rejects fee > 10000", async () => {
      const { commerce } = await setup();
      await assert.rejects(commerce.write.setPlatformFee([10_001n, treasury]), /FeeTooHigh/);
    });
  });
});
