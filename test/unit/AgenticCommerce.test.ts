import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress, keccak256, parseEventLogs, toBytes, zeroAddress } from "viem";

import {
  JobStatus,
  DEFAULT_BUDGET,
  ZERO_BYTES32,
  deployCommerce,
  deployMockToken,
  deployNoopHook,
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

  // Shared no-op IACPHook used as a benign placeholder for tests that don't
  // exercise hook semantics. Required after audit L05: createJob now rejects
  // hook == address(0) with `HookRequired`.
  const noopHook = await deployNoopHook(viem);
  const noopHookAddr = noopHook.address as `0x${string}`;

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

  async function asCommerce(addr: `0x${string}`, wallet: any) {
    return viem.getContractAt("AgenticCommerceUpgradeable", addr, { client: { wallet } });
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      const expiredAt = await futureTs(3600);

      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        expiredAt,
        "Job #1",
        noopHookAddr,
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      // ERC20MinimalMock does not implement IACPHook.
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        zeroAddress,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setProvider([1n, provider, "0x"]);
      const job = await commerce.read.getJob([1n]);
      assert.equal(getAddress(job.provider), provider);
    });

    it("rejects non-client", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        zeroAddress,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      const commerceAsOther = await asCommerce(commerce.address, otherW);
      await assert.rejects(commerceAsOther.write.setProvider([1n, provider, "0x"]), /Unauthorized/);
    });

    it("rejects resetting provider", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      // Audit I05: this branch now revert with ProviderAlreadySet, not the
      // generic WrongStatus, so off-chain clients can distinguish it from
      // an actual status mismatch.
      await assert.rejects(
        commerceAsClient.write.setProvider([1n, other, "0x"]),
        /ProviderAlreadySet/,
      );
    });
  });

  // ==================================================================
  // setBudget
  // ==================================================================

  describe("setBudget", () => {
    it("client OR provider may call", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);

      // Client sets.
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      let job = await commerce.read.getJob([1n]);
      assert.equal(job.budget, DEFAULT_BUDGET);

      // Provider can update again (still Open).
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.setBudget([1n, DEFAULT_BUDGET * 2n, "0x"]);
      job = await commerce.read.getJob([1n]);
      assert.equal(job.budget, DEFAULT_BUDGET * 2n);
      assert.equal(await commerce.read.jobHasBudget([1n]), true);
    });

    it("rejects unauthorized caller", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      const commerceAsOther = await asCommerce(commerce.address, otherW);
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await assert.rejects(commerceAsClient.write.fund([1n, 0n, "0x"]), /ZeroBudget/);
    });

    it("reverts when provider unset", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        zeroAddress,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await assert.rejects(
        commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]),
        /ProviderNotSet/,
      );
    });

    it("reverts when block.timestamp >= expiredAt", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      const expiredAt = await futureTs(3600);
      await commerceAsClient.write.createJob([provider, evaluator, expiredAt, "", noopHookAddr]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      // Fast-forward past expiredAt → fund must revert WrongStatus.
      await advanceSeconds(viem, 3700);
      await assert.rejects(commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]), /WrongStatus/);
    });
  });

  // ==================================================================
  // submit / complete / reject full path
  // ==================================================================

  describe("submit + complete + reject", () => {
    async function fundAndSubmit() {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      const deliverable = keccak256(toBytes("payload"));
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, deliverable, "0x"]);
      return { token, commerce };
    }

    it("evaluator completes → provider receives net, treasury gets fee", async () => {
      const { token, commerce } = await fundAndSubmit();
      // Set a 5% fee.
      await commerce.write.setPlatformFee([500n, treasury]);
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);

      const fee = (DEFAULT_BUDGET * 500n) / 10_000n;
      const net = DEFAULT_BUDGET - fee;
      assert.equal(await token.read.balanceOf([provider]), net);
      assert.equal(await token.read.balanceOf([treasury]), fee);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Completed);
    });

    it("complete with feeBP = 0 sends full budget to provider", async () => {
      const { token, commerce } = await fundAndSubmit();
      // Fee stays at the initialize-time default (0). Explicit for clarity.
      await commerce.write.setPlatformFee([0n, treasury]);
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);
      assert.equal(await token.read.balanceOf([provider]), DEFAULT_BUDGET);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
    });

    it("complete with feeBP = MAX_PLATFORM_FEE_BP routes 10% to treasury", async () => {
      // Audit I07: setPlatformFee is capped at MAX_PLATFORM_FEE_BP (1_000)
      // so this test exercises the maximum fee the kernel will accept.
      const { token, commerce } = await fundAndSubmit();
      await commerce.write.setPlatformFee([1_000n, treasury]);
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);
      const fee = (DEFAULT_BUDGET * 1_000n) / 10_000n;
      const net = DEFAULT_BUDGET - fee;
      assert.equal(await token.read.balanceOf([provider]), net);
      assert.equal(await token.read.balanceOf([treasury]), fee);
    });

    it("evaluator rejects a Funded job (no submit) → client refunded", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      // Evaluator rejects from Funded, skipping submit.
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);
      assert.equal(await token.read.balanceOf([client]), DEFAULT_BUDGET);
      assert.equal((await commerce.read.getJob([1n])).status, JobStatus.Rejected);
    });

    it("rejects `complete` from non-evaluator", async () => {
      const { commerce } = await fundAndSubmit();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await assert.rejects(
        commerceAsClient.write.complete([1n, ZERO_BYTES32, "0x"]),
        /Unauthorized/,
      );
    });

    it("evaluator rejects submitted job → client refunded", async () => {
      const { token, commerce } = await fundAndSubmit();
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);
      assert.equal(await token.read.balanceOf([client]), DEFAULT_BUDGET);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Rejected);
    });

    it("client rejects Open job without refund branch", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.reject([1n, ZERO_BYTES32, "0x"]);
      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Rejected);
    });

    it("submittedAt is zero before submit and recorded after", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      assert.equal((await commerce.read.getJob([1n])).submittedAt, 0n);

      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, keccak256(toBytes("d")), "0x"]);

      assert.notEqual((await commerce.read.getJob([1n])).submittedAt, 0n);
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      const expiredAt = await futureTs(3600);
      await commerceAsClient.write.createJob([provider, evaluator, expiredAt, "", noopHookAddr]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);

      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
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
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);
      await assert.rejects(commerce.write.claimRefund([1n]), /WrongStatus/);
    });

    it("claimRefund never dispatches to the job hook", async () => {
      const { token, commerce } = await setup();
      const hook = await viem.deployContract("RevertingHook", []);

      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        hook.address,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      // Arm the hook: every subsequent beforeAction / afterAction now reverts.
      // If claimRefund dispatched a hook callback, the refund below would
      // bubble up `HookCalled` and this test would fail.
      await hook.write.arm();

      await advanceSeconds(viem, 3700);
      await commerce.write.claimRefund([1n]);

      assert.equal(await token.read.balanceOf([client]), DEFAULT_BUDGET);
      assert.equal((await commerce.read.getJob([1n])).status, JobStatus.Expired);
    });
  });

  // ==================================================================
  // Admin
  // ==================================================================

  describe("admin", () => {
    it("setPlatformFee only by owner", async () => {
      const { commerce } = await setup();
      const asOther = await asCommerce(commerce.address, otherW);
      await assert.rejects(
        asOther.write.setPlatformFee([100n, treasury]),
        /OwnableUnauthorizedAccount/,
      );
      await commerce.write.setPlatformFee([100n, treasury]);
      assert.equal(await commerce.read.platformFeeBP(), 100n);
    });

    it("setPlatformFee rejects fee > MAX_PLATFORM_FEE_BP", async () => {
      // Audit I07: ceiling moved from BP_DENOMINATOR (10_000 = 100%) to
      // MAX_PLATFORM_FEE_BP (1_000 = 10%). Anything above that reverts.
      const { commerce } = await setup();
      await assert.rejects(commerce.write.setPlatformFee([1_001n, treasury]), /FeeTooHigh/);
      await commerce.write.setPlatformFee([1_000n, treasury]);
      assert.equal(await commerce.read.platformFeeBP(), 1_000n);
    });
  });

  // ==================================================================
  // Audit regressions
  // ==================================================================

  describe("audit regressions", () => {
    // [L01] expiredAt must be capped to MAX_EXPIRY_DURATION; without the
    //       cap, a misconfigured client could lock escrow until uint256
    //       overflow, leaving no on-chain refund path.
    it("[L01] createJob rejects expiredAt > now + 365 days with ExpiryTooLong", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      // 1 hour past the cap; well beyond hardhat's per-tx 1s auto-advance.
      const tooFar = (await blockTimestamp(viem)) + 365n * 86_400n + 3600n;
      await assert.rejects(
        commerceAsClient.write.createJob([
          provider,
          evaluator,
          tooFar,
          "L01 regression",
          noopHookAddr,
        ]),
        /ExpiryTooLong/,
      );
    });

    // [L02] submit() must mirror fund()'s expiry guard. Without it, a
    //       provider submitting after expiredAt can be immediately front-run
    //       by claimRefund.
    it("[L02] submit() reverts WrongStatus once block.timestamp >= expiredAt", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      const expiredAt = await futureTs(3600);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        expiredAt,
        "L02 regression",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      // Fast-forward past expiredAt so the provider is racing the refund path.
      await advanceSeconds(viem, 3700);

      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await assert.rejects(
        commerceAsProvider.write.submit([1n, keccak256(toBytes("late")), "0x"]),
        /WrongStatus/,
      );
    });

    // [L05] hook == address(0) bypasses _beforeHook / _afterHook entirely,
    //       which silently disables any policy-side gating. createJob must
    //       reject this configuration up front.
    it("[L05] createJob rejects hook == address(0) with HookRequired", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await assert.rejects(
        commerceAsClient.write.createJob([
          provider,
          evaluator,
          await futureTs(3600),
          "L05 regression",
          zeroAddress,
        ]),
        /HookRequired/,
      );
    });

    // [I02] setBudget(0) used to silently flip jobHasBudget to true and
    //       leave fund() to fail with a confusing "ZeroBudget" path. The
    //       kernel now rejects amount == 0 at the source.
    it("[I02] setBudget rejects amount == 0 with ZeroBudget", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await assert.rejects(commerceAsClient.write.setBudget([1n, 0n, "0x"]), /ZeroBudget/);
    });

    // [I03] JobFunded carries an indexed `provider` topic so providers can
    //       filter funded jobs assigned to them via eth_getLogs alone.
    it("[I03] JobFunded emits indexed provider topic", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      const txHash = await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      const funded = parseEventLogs({
        abi: commerce.abi,
        logs: receipt.logs,
        eventName: "JobFunded",
      }) as unknown as Array<{
        args: {
          jobId: bigint;
          client: `0x${string}`;
          provider: `0x${string}`;
          amount: bigint;
        };
      }>;
      assert.equal(funded.length, 1);
      const ev = funded[0].args;
      assert.equal(ev.jobId, 1n);
      assert.equal(getAddress(ev.client), client);
      assert.equal(getAddress(ev.provider), provider);
      assert.equal(ev.amount, DEFAULT_BUDGET);
    });

    // [I05] submit() must persist the provider's deliverable hash to
    //       Job.deliverable in addition to the JobSubmitted event so that
    //       on-chain consumers (verifying policies, arbitration contracts,
    //       reputation registries) can read it via getJob without rebuilding
    //       state from logs.
    it("[I05] submit persists deliverable to Job.deliverable", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "I05 regression",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, DEFAULT_BUDGET, "0x"]);
      await token.write.mint([client, DEFAULT_BUDGET]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, DEFAULT_BUDGET]);
      await commerceAsClient.write.fund([1n, DEFAULT_BUDGET, "0x"]);

      const jobBeforeSubmit = await commerce.read.getJob([1n]);
      assert.equal(jobBeforeSubmit.deliverable, ZERO_BYTES32);

      const deliverable = keccak256(toBytes("I05 deliverable"));
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, deliverable, "0x"]);

      const jobAfterSubmit = await commerce.read.getJob([1n]);
      assert.equal(jobAfterSubmit.status, JobStatus.Submitted);
      assert.equal(jobAfterSubmit.deliverable, deliverable);
    });

    // [I07] platformFeeBP is now capped at 10% in-contract, so even a
    //       compromised owner cannot route more than that to the treasury.
    it("[I07] setPlatformFee caps feeBP at MAX_PLATFORM_FEE_BP (1_000)", async () => {
      const { commerce } = await setup();
      assert.equal(await commerce.read.MAX_PLATFORM_FEE_BP(), 1_000n);
      await assert.rejects(commerce.write.setPlatformFee([1_001n, treasury]), /FeeTooHigh/);
      await commerce.write.setPlatformFee([1_000n, treasury]);
      assert.equal(await commerce.read.platformFeeBP(), 1_000n);
    });
  });
});
