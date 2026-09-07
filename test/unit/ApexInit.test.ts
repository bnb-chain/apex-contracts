import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, getAddress, zeroAddress, type Abi } from "viem";
import * as apexInitModule from "../../scripts/lib/apex-init.js";

type ApexInitHelpers = typeof apexInitModule & {
  INITIALIZABLE_STORAGE_SLOT: `0x${string}`;
  commerceMultiTokenInitCalldata: (abi: Abi, tokens: readonly `0x${string}`[]) => `0x${string}`;
  commerceUpgradeCalldata: (
    abi: Abi,
    implementation: `0x${string}`,
    callData: `0x${string}`,
  ) => `0x${string}`;
  multiTokenInitStatus: (storageWord: `0x${string}` | undefined) => "required" | "complete";
  resolvePaymentTokens: (args: {
    paymentToken?: `0x${string}`;
    paymentTokens?: readonly `0x${string}`[];
  }) => readonly `0x${string}`[] | undefined;
  readConfiguredPaymentTokenSupport: (args: {
    paymentToken?: `0x${string}`;
    paymentTokens?: readonly `0x${string}`[];
    readCode: (token: `0x${string}`) => Promise<`0x${string}` | undefined>;
    readPaymentTokenSupported: (token: `0x${string}`) => Promise<boolean>;
  }) => Promise<readonly { token: `0x${string}`; supported: boolean }[] | undefined>;
  validateConfiguredPaymentTokens: (args: {
    paymentToken?: `0x${string}`;
    paymentTokens?: readonly `0x${string}`[];
    readCode: (token: `0x${string}`) => Promise<`0x${string}` | undefined>;
  }) => Promise<readonly `0x${string}`[] | undefined>;
  validatePaymentTokens: (args: {
    paymentToken?: `0x${string}`;
    paymentTokens?: readonly `0x${string}`[];
    readCode: (token: `0x${string}`) => Promise<`0x${string}` | undefined>;
  }) => Promise<readonly `0x${string}`[] | undefined>;
  assertTransactionReceiptSuccess: (
    receipt: { status: "success" | "reverted" },
    action: string,
  ) => void;
  waitForSuccessfulTransaction: (args: {
    hash: `0x${string}`;
    action: string;
    waitForTransactionReceipt: (args: {
      hash: `0x${string}`;
      onReplaced: (args: { reason: "cancelled" | "replaced" | "repriced" }) => void;
    }) => Promise<{ status: "success" | "reverted" }>;
    verify?: () => Promise<boolean>;
  }) => Promise<void>;
  canReportDeploymentDone: (args: {
    paymentTokenVerification: "not-requested" | "pending" | "verified";
    pendingOwnerTransactionCount: number;
  }) => boolean;
};

const {
  INITIALIZABLE_STORAGE_SLOT,
  commerceMultiTokenInitCalldata,
  commerceUpgradeCalldata,
  multiTokenInitStatus,
  resolvePaymentTokens,
  readConfiguredPaymentTokenSupport,
  validateConfiguredPaymentTokens,
  validatePaymentTokens,
  assertTransactionReceiptSuccess,
  waitForSuccessfulTransaction,
  canReportDeploymentDone,
} = apexInitModule as ApexInitHelpers;

const defaultToken = "0x1000000000000000000000000000000000000001";
const secondToken = "0x2000000000000000000000000000000000000002";
const usd1Token = "0x7000000000000000000000000000000000000007";
const usdcToken = "0x8000000000000000000000000000000000000008";
const usdtToken = "0x9000000000000000000000000000000000000009";
const implementation = "0x3000000000000000000000000000000000000003";

const commerceAbi = [
  {
    type: "function",
    name: "initializeMultiToken",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokens", type: "address[]" }],
    outputs: [],
  },
  {
    type: "function",
    name: "upgradeToAndCall",
    stateMutability: "payable",
    inputs: [
      { name: "newImplementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

describe("APEX deploy initialization helpers", () => {
  describe("payment-token configuration", () => {
    it("falls back to the default token when paymentTokens is omitted", () => {
      assert.deepEqual(resolvePaymentTokens({ paymentToken: defaultToken }), [
        getAddress(defaultToken),
      ]);
    });

    it("normalizes an explicit token list containing the default token", () => {
      assert.deepEqual(
        resolvePaymentTokens({
          paymentToken: defaultToken,
          paymentTokens: [secondToken, defaultToken],
        }),
        [getAddress(secondToken), getAddress(defaultToken)],
      );
    });

    it("preserves an explicit four-token U, USD1, USDC, and USDT allowlist", () => {
      const paymentTokens = [defaultToken, usd1Token, usdcToken, usdtToken] as const;

      assert.deepEqual(
        resolvePaymentTokens({ paymentToken: defaultToken, paymentTokens }),
        paymentTokens.map(getAddress),
      );
    });

    it("rejects an explicit empty token list", () => {
      assert.throws(
        () => resolvePaymentTokens({ paymentToken: defaultToken, paymentTokens: [] }),
        /paymentTokens must not be empty/,
      );
    });

    it("rejects zero and duplicate token addresses", () => {
      assert.throws(
        () =>
          resolvePaymentTokens({
            paymentToken: defaultToken,
            paymentTokens: [defaultToken, zeroAddress],
          }),
        /paymentTokens\[1\] must not be the zero address/,
      );
      assert.throws(
        () =>
          resolvePaymentTokens({
            paymentToken: defaultToken,
            paymentTokens: [
              defaultToken,
              `0x${defaultToken.slice(2).toUpperCase()}` as `0x${string}`,
            ],
          }),
        /paymentTokens contains duplicate address/,
      );
    });

    it("rejects a token list that omits the default token", () => {
      assert.throws(
        () => resolvePaymentTokens({ paymentToken: defaultToken, paymentTokens: [secondToken] }),
        /paymentTokens must include paymentToken/,
      );
    });

    it("rejects paymentTokens when paymentToken is not configured", () => {
      assert.throws(
        () => resolvePaymentTokens({ paymentTokens: [secondToken] }),
        /paymentTokens requires paymentToken/,
      );
    });

    it("rejects a non-contract desired token before reading Commerce support", async () => {
      const supportReads: `0x${string}`[] = [];

      await assert.rejects(
        () =>
          readConfiguredPaymentTokenSupport({
            paymentToken: defaultToken,
            paymentTokens: [defaultToken, secondToken],
            readCode: async (token) => (token === defaultToken ? "0x1234" : "0x"),
            readPaymentTokenSupported: async (token) => {
              supportReads.push(token);
              return false;
            },
          }),
        /paymentTokens\[1\] must be a deployed contract/,
      );
      assert.deepEqual(supportReads, []);
    });

    it("reads every explicit desired token's support in configured order", async () => {
      const paymentTokens = [defaultToken, usd1Token, usdcToken, usdtToken] as const;
      const codeReads: `0x${string}`[] = [];
      const supportReads: `0x${string}`[] = [];

      const support = await readConfiguredPaymentTokenSupport({
        paymentToken: defaultToken,
        paymentTokens,
        readCode: async (token) => {
          codeReads.push(token);
          return "0x1234";
        },
        readPaymentTokenSupported: async (token) => {
          supportReads.push(token);
          return token === defaultToken || token === usdcToken;
        },
      });

      assert.deepEqual(codeReads, paymentTokens);
      assert.deepEqual(supportReads, paymentTokens);
      assert.deepEqual(support, [
        { token: defaultToken, supported: true },
        { token: usd1Token, supported: false },
        { token: usdcToken, supported: true },
        { token: usdtToken, supported: false },
      ]);
    });

    it("validates explicit desired tokens before a fresh or v1 initializer path", async () => {
      await assert.rejects(
        () =>
          validateConfiguredPaymentTokens({
            paymentToken: defaultToken,
            paymentTokens: [defaultToken, secondToken],
            readCode: async (token) => (token === defaultToken ? "0x1234" : "0x"),
          }),
        /paymentTokens\[1\] must be a deployed contract/,
      );
    });

    it("validates the effective fallback token before a fresh or v1 initializer path", async () => {
      await assert.rejects(
        () =>
          validatePaymentTokens({
            paymentToken: defaultToken,
            readCode: async () => "0x",
          }),
        /paymentTokens\[0\] must be a deployed contract/,
      );
    });
  });

  describe("transaction receipts", () => {
    it("rejects reverted direct writes before deployment output can claim success", () => {
      assert.doesNotThrow(() =>
        assertTransactionReceiptSuccess({ status: "success" }, "commerce.initializeMultiToken"),
      );
      assert.throws(
        () =>
          assertTransactionReceiptSuccess({ status: "reverted" }, "commerce.initializeMultiToken"),
        /commerce\.initializeMultiToken transaction reverted/,
      );
    });

    it("rejects cancelled or replaced receipts for every direct owner action", async () => {
      const directActions = [
        "commerce.initializeMultiToken",
        "commerce.upgradeToAndCall",
        "commerce.setPaymentTokenSupported",
        "router.upgradeToAndCall",
        "router.setPolicyWhitelist",
      ] as const;
      const replacementReasons = ["cancelled", "replaced", "repriced"] as const;

      for (const action of directActions) {
        for (const reason of replacementReasons) {
          let verificationCalls = 0;
          await assert.rejects(
            () =>
              waitForSuccessfulTransaction({
                hash: `0x${"1".repeat(64)}`,
                action,
                waitForTransactionReceipt: async ({ onReplaced }) => {
                  onReplaced({ reason });
                  return { status: "success" };
                },
                verify: async () => {
                  verificationCalls += 1;
                  return true;
                },
              }),
            new RegExp(`${reason}.*reporting success`),
          );
          assert.equal(verificationCalls, 0);
        }
      }
    });

    it("propagates direct Router and Policy post-verification RPC failures", async () => {
      for (const action of ["router.upgradeToAndCall", "router.setPolicyWhitelist"] as const) {
        const rpcFailure = new Error(`${action} verification RPC unavailable`);
        await assert.rejects(
          () =>
            waitForSuccessfulTransaction({
              hash: `0x${"2".repeat(64)}`,
              action,
              waitForTransactionReceipt: async () => ({ status: "success" }),
              verify: async () => {
                throw rpcFailure;
              },
            }),
          (error) => error === rpcFailure,
        );
      }
    });

    it("requires direct Router and Policy post-verification to succeed", async () => {
      for (const action of ["router.upgradeToAndCall", "router.setPolicyWhitelist"] as const) {
        await assert.rejects(
          () =>
            waitForSuccessfulTransaction({
              hash: `0x${"3".repeat(64)}`,
              action,
              waitForTransactionReceipt: async () => ({ status: "success" }),
              verify: async () => false,
            }),
          /post-transaction verification failed/,
        );
      }
    });

    it("runs direct action verification after a successful receipt", async () => {
      let verificationCalls = 0;
      await waitForSuccessfulTransaction({
        hash: `0x${"4".repeat(64)}`,
        action: "router.upgradeToAndCall",
        waitForTransactionReceipt: async () => ({ status: "success" }),
        verify: async () => {
          verificationCalls += 1;
          return true;
        },
      });
      assert.equal(verificationCalls, 1);
    });

    it("does not report DONE until every owner action and token verification is complete", () => {
      assert.equal(
        canReportDeploymentDone({
          paymentTokenVerification: "verified",
          pendingOwnerTransactionCount: 0,
        }),
        true,
      );
      assert.equal(
        canReportDeploymentDone({
          paymentTokenVerification: "not-requested",
          pendingOwnerTransactionCount: 0,
        }),
        true,
      );
      assert.equal(
        canReportDeploymentDone({
          paymentTokenVerification: "pending",
          pendingOwnerTransactionCount: 0,
        }),
        false,
      );
      assert.equal(
        canReportDeploymentDone({
          paymentTokenVerification: "verified",
          pendingOwnerTransactionCount: 1,
        }),
        false,
      );
      assert.equal(
        canReportDeploymentDone({
          paymentTokenVerification: "not-requested",
          pendingOwnerTransactionCount: 2,
        }),
        false,
      );
    });
  });

  describe("calldata", () => {
    it("encodes initializeMultiToken with the configured tokens", () => {
      assert.equal(
        commerceMultiTokenInitCalldata(commerceAbi, [defaultToken, secondToken]),
        encodeFunctionData({
          abi: commerceAbi,
          functionName: "initializeMultiToken",
          args: [[defaultToken, secondToken]],
        }),
      );
    });

    it("encodes four configured tokens in their original allowlist order", () => {
      const paymentTokens = [defaultToken, usd1Token, usdcToken, usdtToken] as const;

      assert.equal(
        commerceMultiTokenInitCalldata(commerceAbi, paymentTokens),
        encodeFunctionData({
          abi: commerceAbi,
          functionName: "initializeMultiToken",
          args: [paymentTokens],
        }),
      );
    });

    it("embeds the same initializer bytes in direct and Safe upgrade calldata", () => {
      const initData = commerceMultiTokenInitCalldata(commerceAbi, [defaultToken, secondToken]);
      const upgradeData = commerceUpgradeCalldata(commerceAbi, implementation, initData);

      assert.equal(
        upgradeData,
        encodeFunctionData({
          abi: commerceAbi,
          functionName: "upgradeToAndCall",
          args: [implementation, initData],
        }),
      );
    });
  });

  describe("OpenZeppelin Initializable v5.4.0 state", () => {
    it("uses the pinned ERC-7201 Initializable storage slot", () => {
      // Source: @openzeppelin/contracts-upgradeable@5.4.0
      // proxy/utils/Initializable.sol: INITIALIZABLE_STORAGE.
      assert.equal(
        INITIALIZABLE_STORAGE_SLOT,
        "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00",
      );
    });

    it("reads uint64 _initialized from the low-order eight bytes", () => {
      // OZ's struct declares uint64 _initialized first, then bool _initializing;
      // Solidity packs both from the least-significant (right-hand) bytes.
      assert.equal(
        multiTokenInitStatus("0x0000000000000000000000000000000000000000000000000000000000000001"),
        "required",
      );
      assert.equal(
        multiTokenInitStatus("0x0000000000000000000000000000000000000000000000000000000000000002"),
        "complete",
      );
    });

    it("fails closed for missing, malformed, initializing, zero, and future versions", () => {
      assert.throws(() => multiTokenInitStatus(undefined), /could not read Initializable storage/);
      assert.throws(() => multiTokenInitStatus("0x01"), /must be exactly 32 bytes/);
      assert.throws(
        () => multiTokenInitStatus(`0x01${"00".repeat(30)}01`),
        /unexpected reserved bits/,
      );
      assert.throws(
        () => multiTokenInitStatus(`0x${"00".repeat(23)}01${"00".repeat(7)}01`),
        /currently initializing/,
      );
      assert.throws(
        () =>
          multiTokenInitStatus(
            "0x0000000000000000000000000000000000000000000000000000000000000000",
          ),
        /unexpected initialized version 0/,
      );
      assert.throws(
        () =>
          multiTokenInitStatus(
            "0x0000000000000000000000000000000000000000000000000000000000000003",
          ),
        /unexpected initialized version 3/,
      );
    });
  });
});
