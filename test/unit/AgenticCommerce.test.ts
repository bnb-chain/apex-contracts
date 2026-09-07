import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbiParameters,
  parseEventLogs,
  toBytes,
  toFunctionSelector,
  zeroAddress,
} from "viem";

import {
  JobStatus,
  DEFAULT_BUDGET,
  ZERO_BYTES32,
  deployCommerce,
  deployMockToken,
  deployNoopHook,
  deployRouter,
  blockTimestamp,
  advanceSeconds,
} from "./helpers.js";

// Top-level await, NOT an async describe: bun's collector does not await an
// async describe callback, so tests registered after its first `await` are
// silently dropped when multiple test files load in parallel.
const { viem, networkHelpers } = await network.connect();
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

describe("AgenticCommerceUpgradeable", () => {
  async function setup(initializeDefaultToken = true) {
    const token = await deployMockToken(viem);
    const { proxy, impl } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner: deployer,
    });
    if (initializeDefaultToken) {
      await proxy.write.initializeMultiToken([[token.address]]);
    }
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
      const { token, commerce } = await setup(false);
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
      const { token, commerce } = await setup(false);
      await assert.rejects(
        commerce.write.initialize([token.address, treasury, deployer]),
        /InvalidInitialization/,
      );
    });
  });

  // ==================================================================
  // Multi-token governance
  // ==================================================================

  describe("multi-token governance", () => {
    it("owner enables the default token and two contract tokens, emitting each update", async () => {
      const { token, commerce } = await setup(false);
      const token2 = await deployMockToken(viem);
      const token3 = await deployMockToken(viem);

      const txHash = await commerce.write.initializeMultiToken([
        [token.address, token2.address, token3.address],
      ]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const updates = parseEventLogs({
        abi: commerce.abi,
        logs: receipt.logs,
        eventName: "PaymentTokenSupportUpdated",
      }) as unknown as Array<{ args: { token: `0x${string}`; supported: boolean } }>;

      assert.equal(updates.length, 3);
      assert.deepEqual(
        updates.map((update) => [getAddress(update.args.token), update.args.supported]),
        [
          [getAddress(token.address), true],
          [getAddress(token2.address), true],
          [getAddress(token3.address), true],
        ],
      );
      assert.equal(await commerce.read.isPaymentTokenSupported([token.address]), true);
      assert.equal(await commerce.read.isPaymentTokenSupported([token2.address]), true);
      assert.equal(await commerce.read.isPaymentTokenSupported([token3.address]), true);
    });

    it("rejects a non-owner multi-token initializer call", async () => {
      const { token, commerce } = await setup(false);
      const commerceAsClient = await asCommerce(commerce.address, clientW);

      await assert.rejects(
        commerceAsClient.write.initializeMultiToken([[token.address]]),
        /OwnableUnauthorizedAccount/,
      );
    });

    it("requires the default token in the multi-token initializer", async () => {
      const { commerce } = await setup(false);
      const token2 = await deployMockToken(viem);

      await assert.rejects(
        commerce.write.initializeMultiToken([[token2.address]]),
        /UnsupportedPaymentToken/,
      );
    });

    it("rejects zero-address, EOA, and duplicate multi-token initializer entries", async () => {
      const { token, commerce } = await setup(false);
      const token2 = await deployMockToken(viem);
      await assert.rejects(
        commerce.write.initializeMultiToken([[token.address, zeroAddress]]),
        /ZeroAddress/,
      );

      const { token: eoaToken, commerce: eoaCommerce } = await setup(false);
      await assert.rejects(
        eoaCommerce.write.initializeMultiToken([[eoaToken.address, other]]),
        /TokenHasNoCode/,
      );

      const { token: duplicateToken, commerce: duplicateCommerce } = await setup(false);
      await assert.rejects(
        duplicateCommerce.write.initializeMultiToken([
          [duplicateToken.address, token2.address, token2.address],
        ]),
        /UnsupportedPaymentToken/,
      );
    });

    it("runs the multi-token reinitializer only once", async () => {
      const { token, commerce } = await setup(false);
      await commerce.write.initializeMultiToken([[token.address]]);

      await assert.rejects(
        commerce.write.initializeMultiToken([[token.address]]),
        /InvalidInitialization/,
      );
    });

    it("owner may disable a supported token", async () => {
      const { token, commerce } = await setup();
      await commerce.write.setPaymentTokenSupported([token.address, false]);

      assert.equal(await commerce.read.isPaymentTokenSupported([token.address]), false);
    });

    it("owner may disable a supported token after its contract code disappears", async () => {
      const { token, commerce } = await setup();
      await networkHelpers.setCode(token.address, "0x");

      await commerce.write.setPaymentTokenSupported([token.address, false]);

      assert.equal(await commerce.read.isPaymentTokenSupported([token.address]), false);
    });

    it("still rejects a zero address on disable and an EOA on enable", async () => {
      const { commerce } = await setup();

      await assert.rejects(
        commerce.write.setPaymentTokenSupported([zeroAddress, false]),
        /ZeroAddress/,
      );
      await assert.rejects(
        commerce.write.setPaymentTokenSupported([other, true]),
        /TokenHasNoCode/,
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

    it("binds the default token and emits JobPaymentTokenBound", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      const txHash = await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "Default-token job",
        noopHookAddr,
      ]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const bindings = parseEventLogs({
        abi: commerce.abi,
        logs: receipt.logs,
        eventName: "JobPaymentTokenBound",
      }) as unknown as Array<{ args: { jobId: bigint; token: `0x${string}` } }>;

      assert.equal(
        getAddress(await commerce.read.jobPaymentToken([1n])),
        getAddress(token.address),
      );
      assert.deepEqual(
        bindings.map((binding) => binding.args.jobId),
        [1n],
      );
      assert.equal(getAddress(bindings[0].args.token), getAddress(token.address));
    });

    it("binds an explicitly selected supported token and emits JobPaymentTokenBound", async () => {
      const { commerce } = await setup();
      const token2 = await deployMockToken(viem);
      await commerce.write.setPaymentTokenSupported([token2.address, true]);
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      const txHash = await commerceAsClient.write.createJobWithToken([
        provider,
        evaluator,
        await futureTs(3600),
        "Explicit-token job",
        noopHookAddr,
        token2.address,
      ]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
      const bindings = parseEventLogs({
        abi: commerce.abi,
        logs: receipt.logs,
        eventName: "JobPaymentTokenBound",
      }) as unknown as Array<{ args: { jobId: bigint; token: `0x${string}` } }>;

      assert.equal(
        getAddress(await commerce.read.jobPaymentToken([1n])),
        getAddress(token2.address),
      );
      assert.equal(bindings.length, 1);
      assert.equal(bindings[0].args.jobId, 1n);
      assert.equal(getAddress(bindings[0].args.token), getAddress(token2.address));
    });

    it("rejects createJobWithToken for an unsupported token", async () => {
      const { commerce } = await setup();
      const unsupportedToken = await deployMockToken(viem);
      const commerceAsClient = await asCommerce(commerce.address, clientW);

      await assert.rejects(
        commerceAsClient.write.createJobWithToken([
          provider,
          evaluator,
          await futureTs(3600),
          "Unsupported-token job",
          noopHookAddr,
          unsupportedToken.address,
        ]),
        /UnsupportedPaymentToken/,
      );
    });

    it("rejects jobPaymentToken for a nonexistent job", async () => {
      const { commerce } = await setup();
      await assert.rejects(commerce.read.jobPaymentToken([1n]), /InvalidJob/);
    });

    it("uses the new selector with the Router hook while retaining its authenticated no-op", async () => {
      const { commerce } = await setup();
      const token2 = await deployMockToken(viem);
      await commerce.write.setPaymentTokenSupported([token2.address, true]);
      const { proxy: router } = await deployRouter(viem, {
        commerce: commerce.address,
        owner: deployer,
      });
      const commerceAsClient = await asCommerce(commerce.address, clientW);

      await commerceAsClient.write.createJobWithToken([
        provider,
        router.address,
        await futureTs(3600),
        "Router-hook token job",
        router.address,
        token2.address,
      ]);

      assert.equal(
        getAddress(await commerce.read.jobPaymentToken([1n])),
        getAddress(token2.address),
      );
    });

    it("binds the selected token before the createJobWithToken after-hook callback", async () => {
      const { commerce } = await setup();
      const token2 = await deployMockToken(viem);
      await commerce.write.setPaymentTokenSupported([token2.address, true]);
      const observer = await viem.deployContract("PaymentTokenBindingObserverHook", [
        commerce.address,
      ]);
      const commerceAsClient = await asCommerce(commerce.address, clientW);

      await commerceAsClient.write.createJobWithToken([
        provider,
        evaluator,
        await futureTs(3600),
        "Observed-token job",
        observer.address,
        token2.address,
      ]);

      assert.equal(getAddress(await observer.read.callbackToken()), getAddress(token2.address));
      assert.equal(
        await observer.read.lastSelector(),
        toFunctionSelector("createJobWithToken(address,address,uint256,string,address,address)"),
      );
      assert.equal(
        await observer.read.lastData(),
        encodeAbiParameters(parseAbiParameters("address, address, address, address"), [
          client,
          provider,
          evaluator,
          token2.address,
        ]),
      );
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
  // Bound-token escrow and settlement
  // ==================================================================

  describe("bound-token escrow and settlement", () => {
    async function fundExplicitTokenJob(decimals: number, budget: bigint) {
      const { token: defaultToken, commerce } = await setup();
      const token = await deployMockToken(viem, decimals);
      await commerce.write.setPaymentTokenSupported([token.address, true]);

      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJobWithToken([
        provider,
        evaluator,
        await futureTs(3600),
        "Bound-token job",
        noopHookAddr,
        token.address,
      ]);
      await commerceAsClient.write.setBudget([1n, budget, "0x"]);
      await token.write.mint([client, budget]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, budget]);
      await commerceAsClient.write.fund([1n, budget, "0x"]);

      return { defaultToken, token, commerce, budget };
    }

    it("settles a 6-decimal bound token to provider and treasury", async () => {
      const budget = 1_000_000n;
      const { defaultToken, token, commerce } = await fundExplicitTokenJob(6, budget);
      await commerce.write.setPlatformFee([250n, treasury]);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, keccak256(toBytes("six-decimal")), "0x"]);

      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);

      assert.equal(await token.read.balanceOf([client]), 0n);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await token.read.balanceOf([provider]), 975_000n);
      assert.equal(await token.read.balanceOf([treasury]), 25_000n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
    });

    it("refunds a 18-decimal bound token when rejected while Funded", async () => {
      const { defaultToken, token, commerce, budget } = await fundExplicitTokenJob(
        18,
        DEFAULT_BUDGET,
      );
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);

      assert.equal(await token.read.balanceOf([client]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await token.read.balanceOf([provider]), 0n);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
    });

    it("refunds a 6-decimal bound token when rejected while Submitted", async () => {
      const budget = 1_000_000n;
      const { defaultToken, token, commerce } = await fundExplicitTokenJob(6, budget);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, keccak256(toBytes("reject-six")), "0x"]);

      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);

      assert.equal(await token.read.balanceOf([client]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await token.read.balanceOf([provider]), 0n);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
    });

    it("refunds an expired 18-decimal bound token", async () => {
      const { defaultToken, token, commerce, budget } = await fundExplicitTokenJob(
        18,
        DEFAULT_BUDGET,
      );
      await advanceSeconds(viem, 3700);
      await commerce.write.claimRefund([1n]);

      assert.equal(await token.read.balanceOf([client]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await token.read.balanceOf([provider]), 0n);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
    });

    it("rejects a default-token job after the default token is disabled", async () => {
      const { token, commerce } = await setup();
      await commerce.write.setPaymentTokenSupported([token.address, false]);
      const commerceAsClient = await asCommerce(commerce.address, clientW);

      await assert.rejects(
        commerceAsClient.write.createJob([
          provider,
          evaluator,
          await futureTs(3600),
          "Disabled default-token job",
          noopHookAddr,
        ]),
        /UnsupportedPaymentToken/,
      );
    });

    it("rejects funding a paid Open job after its bound token is disabled", async () => {
      const { token: defaultToken, commerce } = await setup();
      const token = await deployMockToken(viem, 6);
      const budget = 1_000_000n;
      await commerce.write.setPaymentTokenSupported([token.address, true]);
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJobWithToken([
        provider,
        evaluator,
        await futureTs(3600),
        "Disabled paid job",
        noopHookAddr,
        token.address,
      ]);
      await commerceAsClient.write.setBudget([1n, budget, "0x"]);
      await token.write.mint([client, budget]);
      const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", token.address, {
        client: { wallet: clientW },
      });
      await tokenAsClient.write.approve([commerce.address, budget]);
      await commerce.write.setPaymentTokenSupported([token.address, false]);

      await assert.rejects(
        commerceAsClient.write.fund([1n, budget, "0x"]),
        /UnsupportedPaymentToken/,
      );
      assert.equal(await token.read.balanceOf([client]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
    });

    it("settles a funded bound token after it is disabled", async () => {
      const { token, commerce, budget } = await fundExplicitTokenJob(18, DEFAULT_BUDGET);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, keccak256(toBytes("disabled-complete")), "0x"]);
      await commerce.write.setPaymentTokenSupported([token.address, false]);

      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);
      assert.equal(await token.read.balanceOf([provider]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
    });

    it("rejects a Funded bound-token job after it is disabled", async () => {
      const { token, commerce, budget } = await fundExplicitTokenJob(6, 1_000_000n);
      await commerce.write.setPaymentTokenSupported([token.address, false]);

      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);
      assert.equal(await token.read.balanceOf([client]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
    });

    it("rejects a Submitted bound-token job after it is disabled", async () => {
      const { token, commerce, budget } = await fundExplicitTokenJob(6, 1_000_000n);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, keccak256(toBytes("disabled-reject")), "0x"]);
      await commerce.write.setPaymentTokenSupported([token.address, false]);

      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);
      assert.equal(await token.read.balanceOf([client]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
    });

    it("refunds an expired bound-token job after it is disabled", async () => {
      const { token, commerce, budget } = await fundExplicitTokenJob(18, DEFAULT_BUDGET);
      await commerce.write.setPaymentTokenSupported([token.address, false]);
      await advanceSeconds(viem, 3700);
      await commerce.write.claimRefund([1n]);

      assert.equal(await token.read.balanceOf([client]), budget);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
    });

    async function createDisabledZeroBudgetJob() {
      const { token: defaultToken, commerce } = await setup();
      const token = await deployMockToken(viem, 6);
      await commerce.write.setPaymentTokenSupported([token.address, true]);
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJobWithToken([
        provider,
        evaluator,
        await futureTs(3600),
        "Disabled free job",
        noopHookAddr,
        token.address,
      ]);
      await commerceAsClient.write.setBudget([1n, 0n, "0x"]);
      await commerce.write.setPaymentTokenSupported([token.address, false]);
      return { defaultToken, token, commerce, commerceAsClient };
    }

    it("funds and completes a disabled zero-budget job without token transfers", async () => {
      const { defaultToken, token, commerce, commerceAsClient } =
        await createDisabledZeroBudgetJob();
      await commerceAsClient.write.fund([1n, 0n, "0x"]);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.submit([1n, keccak256(toBytes("disabled-free")), "0x"]);
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);

      assert.equal(await token.read.balanceOf([client]), 0n);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await token.read.balanceOf([provider]), 0n);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
    });

    it("funds and rejects a disabled zero-budget job without token transfers", async () => {
      const { defaultToken, token, commerce, commerceAsClient } =
        await createDisabledZeroBudgetJob();
      await commerceAsClient.write.fund([1n, 0n, "0x"]);
      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);

      assert.equal(await token.read.balanceOf([client]), 0n);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await token.read.balanceOf([provider]), 0n);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
    });

    it("expires a disabled zero-budget job without token transfers", async () => {
      const { defaultToken, token, commerce, commerceAsClient } =
        await createDisabledZeroBudgetJob();
      await commerceAsClient.write.fund([1n, 0n, "0x"]);
      await advanceSeconds(viem, 3700);
      await commerce.write.claimRefund([1n]);

      assert.equal(await token.read.balanceOf([client]), 0n);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal(await token.read.balanceOf([provider]), 0n);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
      assert.equal(await defaultToken.read.balanceOf([commerce.address]), 0n);
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
      await commerce.write.initializeMultiToken([[token.address]]);
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
  // Zero price
  // ==================================================================

  describe("zero price", () => {
    it("provider may set budget == 0 (jobHasBudget flips true)", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.setBudget([1n, 0n, "0x"]);

      const job = await commerce.read.getJob([1n]);
      assert.equal(job.budget, 0n);
      assert.equal(await commerce.read.jobHasBudget([1n]), true);
    });

    it("client can set budget == 0", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, 0n, "0x"]);

      const job = await commerce.read.getJob([1n]);
      assert.equal(job.budget, 0n);
      assert.equal(await commerce.read.jobHasBudget([1n]), true);
    });

    it("zero-budget job still requires a bound provider to fund", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      // Provider unset at creation: setBudget(0) is fine (client is a valid
      // caller), but fund keeps the ProviderNotSet gate.
      await commerceAsClient.write.createJob([
        zeroAddress,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      await commerceAsClient.write.setBudget([1n, 0n, "0x"]);
      await assert.rejects(commerceAsClient.write.fund([1n, 0n, "0x"]), /ProviderNotSet/);
    });

    it("fund on a zero-budget job transitions to Funded without any transfer", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.setBudget([1n, 0n, "0x"]);

      // No mint / approve: the client funds a free job with no allowance.
      const txHash = await commerceAsClient.write.fund([1n, 0n, "0x"]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      const job = await commerce.read.getJob([1n]);
      assert.equal(job.status, JobStatus.Funded);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);

      const funded = parseEventLogs({
        abi: commerce.abi,
        logs: receipt.logs,
        eventName: "JobFunded",
      }) as unknown as Array<{ args: { jobId: bigint; amount: bigint } }>;
      assert.equal(funded.length, 1);
      assert.equal(funded[0].args.amount, 0n);
    });

    it("full zero-price happy path: complete pays nobody but reaches Completed", async () => {
      const { token, commerce } = await setup();
      // Non-zero fee to prove fee math also zeroes out.
      await commerce.write.setPlatformFee([500n, treasury]);

      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.setBudget([1n, 0n, "0x"]);
      await commerceAsClient.write.fund([1n, 0n, "0x"]);
      await commerceAsProvider.write.submit([1n, keccak256(toBytes("free")), "0x"]);

      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      const txHash = await commerceAsEvaluator.write.complete([1n, ZERO_BYTES32, "0x"]);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

      assert.equal(await token.read.balanceOf([provider]), 0n);
      assert.equal(await token.read.balanceOf([treasury]), 0n);
      assert.equal(await token.read.balanceOf([commerce.address]), 0n);
      assert.equal((await commerce.read.getJob([1n])).status, JobStatus.Completed);

      const released = parseEventLogs({
        abi: commerce.abi,
        logs: receipt.logs,
        eventName: "PaymentReleased",
      }) as unknown as Array<{ args: { jobId: bigint; amount: bigint } }>;
      assert.equal(released.length, 1);
      assert.equal(released[0].args.amount, 0n);
    });

    it("evaluator rejects a zero-budget Funded job with no refund transfer", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.setBudget([1n, 0n, "0x"]);
      await commerceAsClient.write.fund([1n, 0n, "0x"]);

      const commerceAsEvaluator = await asCommerce(commerce.address, evaluatorW);
      await commerceAsEvaluator.write.reject([1n, ZERO_BYTES32, "0x"]);

      assert.equal(await token.read.balanceOf([client]), 0n);
      assert.equal((await commerce.read.getJob([1n])).status, JobStatus.Rejected);
    });

    it("zero-budget job expires to Expired via claimRefund with no transfer", async () => {
      const { token, commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      await commerceAsClient.write.createJob([
        provider,
        evaluator,
        await futureTs(3600),
        "",
        noopHookAddr,
      ]);
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsProvider.write.setBudget([1n, 0n, "0x"]);
      await commerceAsClient.write.fund([1n, 0n, "0x"]);

      await advanceSeconds(viem, 3700);
      await commerce.write.claimRefund([1n]);

      assert.equal(await token.read.balanceOf([client]), 0n);
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

    // [I02] setBudget(0) used to be rejected outright so `Funded ⇒ budget > 0`
    //       held as a kernel invariant. Zero price deliberately relaxes it for
    //       BOTH parties (compliance doc Delta 4): every transfer site guards
    //       `> 0`, and off-chain the provider verifies the funded budget
    //       against its signed quote before working. What survives of I02 is
    //       "no fund without an explicit setBudget" — jobHasBudget, not the
    //       amount, is the gate (asserted in the fund suite).
    it("[I02] setBudget(0) is symmetric: client and provider may both set it", async () => {
      const { commerce } = await setup();
      const commerceAsClient = await asCommerce(commerce.address, clientW);
      for (let i = 0; i < 2; i++) {
        await commerceAsClient.write.createJob([
          provider,
          evaluator,
          await futureTs(3600),
          "",
          noopHookAddr,
        ]);
      }
      const commerceAsProvider = await asCommerce(commerce.address, providerW);
      await commerceAsClient.write.setBudget([1n, 0n, "0x"]);
      await commerceAsProvider.write.setBudget([2n, 0n, "0x"]);
      assert.equal((await commerce.read.getJob([1n])).budget, 0n);
      assert.equal((await commerce.read.getJob([2n])).budget, 0n);
      assert.equal(await commerce.read.jobHasBudget([1n]), true);
      assert.equal(await commerce.read.jobHasBudget([2n]), true);
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
