import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, zeroAddress, type Abi } from "viem";
import * as commerceDeployModule from "../../scripts/lib/apex-init.js";

const defaultToken = "0x1000000000000000000000000000000000000001";
const secondToken = "0x2000000000000000000000000000000000000002";
const usd1Token = "0x7000000000000000000000000000000000000007";
const usdcToken = "0x8000000000000000000000000000000000000008";
const usdtToken = "0x9000000000000000000000000000000000000009";
const implementation = "0x3000000000000000000000000000000000000003";
const commerceProxy = "0x4000000000000000000000000000000000000004";
const owner = "0x5000000000000000000000000000000000000005";
const treasury = "0x6000000000000000000000000000000000000006";

const commerceAbi = [
  {
    type: "function",
    name: "initialize",
    stateMutability: "nonpayable",
    inputs: [
      { name: "paymentToken", type: "address" },
      { name: "treasury", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [],
  },
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
  {
    type: "function",
    name: "setPaymentTokenSupported",
    stateMutability: "nonpayable",
    inputs: [
      { name: "token", type: "address" },
      { name: "enabled", type: "bool" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

type PlanArgs = {
  freshCommerce: boolean;
  commerceAction: "FRESH" | "UPGRADE" | "up-to-date";
  initStatus: "required" | "complete";
  ownerExecutor: { kind: "direct" } | { kind: "calldata-only"; owner: `0x${string}` };
  paymentToken?: `0x${string}`;
  paymentTokens?: readonly `0x${string}`[];
  paymentTokenSupport?: readonly { token: `0x${string}`; supported: boolean }[];
  commerceProxy?: `0x${string}`;
};

type CommerceDeployApi = {
  planCommerceDeployment: (args: PlanArgs) => any;
  executeCommerceDeployment: (args: {
    plan: any;
    execute: boolean;
    abi: Abi;
    paymentToken?: `0x${string}`;
    callbacks: ReturnType<typeof recordingCallbacks>["callbacks"];
  }) => Promise<any>;
  executePaymentTokenReconciliation: (args: any) => Promise<any>;
  deployFreshCommerce: (args: {
    abi: Abi;
    paymentToken: `0x${string}`;
    treasury: `0x${string}`;
    owner: `0x${string}`;
    paymentTokens: readonly `0x${string}`[];
    callbacks: {
      deployImplementation: () => Promise<`0x${string}`>;
      deployProxy: (args: {
        implementation: `0x${string}`;
        constructorArgs: readonly [`0x${string}`, `0x${string}`];
      }) => Promise<`0x${string}`>;
      writeInitializeMultiToken: (args: {
        proxy: `0x${string}`;
        paymentTokens: readonly `0x${string}`[];
        data: `0x${string}`;
      }) => Promise<string>;
    };
  }) => Promise<any>;
  commerceInitPlanSummary: (plan: any) => string;
  isDeploymentNoop: (args: {
    freshPaymentToken: boolean;
    commerceAction: "FRESH" | "UPGRADE" | "up-to-date";
    commerceInitStatus: "required" | "complete";
    routerAction: "FRESH" | "UPGRADE" | "up-to-date";
    policyAction: "FRESH" | "up-to-date";
    paymentTokenReconciliation: "not-configured" | "required" | "unverified" | "verified";
  }) => boolean;
};

const {
  planCommerceDeployment,
  executeCommerceDeployment,
  executePaymentTokenReconciliation,
  deployFreshCommerce,
  commerceInitPlanSummary,
  isDeploymentNoop,
} = commerceDeployModule as CommerceDeployApi;

async function executeFreshAdapter(plan: any, paymentToken: `0x${string}`) {
  const calls: Array<{ name: string; args: any }> = [];
  await executeCommerceDeployment({
    plan,
    execute: true,
    abi: commerceAbi,
    paymentToken,
    callbacks: {
      ...recordingCallbacks().callbacks,
      deployFresh: async ({ paymentTokens }: any) => {
        await deployFreshCommerce({
          abi: commerceAbi,
          paymentToken,
          treasury,
          owner,
          paymentTokens,
          callbacks: {
            deployImplementation: async () => {
              calls.push({ name: "deployImplementation", args: undefined });
              return implementation;
            },
            deployProxy: async (args: any) => {
              calls.push({ name: "deployProxy", args });
              return commerceProxy;
            },
            writeInitializeMultiToken: async (args: any) => {
              calls.push({ name: "writeInitializeMultiToken", args });
              return "0xtransaction";
            },
          },
        });
      },
    },
  });
  return calls;
}

function directArgs(overrides: Partial<PlanArgs> = {}): PlanArgs {
  return {
    freshCommerce: false,
    commerceAction: "UPGRADE",
    initStatus: "required",
    ownerExecutor: { kind: "direct" },
    paymentToken: defaultToken,
    paymentTokens: [defaultToken, secondToken],
    commerceProxy,
    ...overrides,
  };
}

function safeArgs(overrides: Partial<PlanArgs> = {}): PlanArgs {
  return directArgs({ ownerExecutor: { kind: "calldata-only", owner }, ...overrides });
}

function recordingCallbacks() {
  const calls: Array<{ name: string; args: any }> = [];
  return {
    calls,
    callbacks: {
      deployFresh: async (args: any) => {
        calls.push({ name: "deployFresh", args });
      },
      deployImplementation: async () => {
        calls.push({ name: "deployImplementation", args: undefined });
        return implementation;
      },
      writeUpgrade: async (args: any) => {
        calls.push({ name: "writeUpgrade", args });
      },
      writeInitialize: async (args: any) => {
        calls.push({ name: "writeInitialize", args });
      },
      queueOwnerTransaction: (args: any) => {
        calls.push({ name: "queueOwnerTransaction", args });
      },
    },
  };
}

async function executePlan(plan: any, execute = true, paymentToken?: `0x${string}`) {
  const recorder = recordingCallbacks();
  const result = await executeCommerceDeployment({
    plan,
    execute,
    abi: commerceAbi,
    paymentToken,
    callbacks: recorder.callbacks,
  });
  return { ...recorder, result };
}

describe("Commerce deploy planner wiring", () => {
  it("plans and executes old proxy initialize followed by multi-token init for configured and mock fresh tokens", async () => {
    const configured = planCommerceDeployment(
      directArgs({ freshCommerce: true, commerceAction: "FRESH", commerceProxy: undefined }),
    );
    const mock = planCommerceDeployment(
      directArgs({
        freshCommerce: true,
        commerceAction: "FRESH",
        paymentToken: undefined,
        paymentTokens: undefined,
        commerceProxy: undefined,
      }),
    );

    assert.equal(configured.proxyInitializer, "initialize");
    assert.equal(configured.initAction, "post-proxy");
    assert.deepEqual(configured.configuredPaymentTokens, [defaultToken, secondToken]);
    assert.equal(mock.proxyInitializer, "initialize");
    assert.equal(mock.initAction, "post-proxy");
    assert.equal(mock.tokenSource, "fresh-mock-default");

    for (const { plan, tokens } of [
      { plan: configured, tokens: [defaultToken, secondToken] },
      { plan: mock, tokens: [defaultToken] },
    ]) {
      const calls = await executeFreshAdapter(plan, defaultToken);
      assert.deepEqual(
        calls.map((call) => call.name),
        ["deployImplementation", "deployProxy", "writeInitializeMultiToken"],
      );

      assert.equal(calls[1].args.implementation, implementation);
      assert.equal(calls[1].args.constructorArgs[0], implementation);
      const proxyInit = decodeFunctionData({
        abi: commerceAbi,
        data: calls[1].args.constructorArgs[1],
      });
      assert.equal(proxyInit.functionName, "initialize");
      assert.deepEqual(proxyInit.args, [defaultToken, treasury, owner]);

      assert.equal(calls[2].args.proxy, commerceProxy);
      assert.deepEqual(calls[2].args.paymentTokens, tokens);
      const multiTokenInit = decodeFunctionData({ abi: commerceAbi, data: calls[2].args.data });
      assert.equal(multiTokenInit.functionName, "initializeMultiToken");
      assert.deepEqual(multiTokenInit.args[0], tokens);
    }
  });

  it("uses the same non-empty init bytes for direct and Safe v1 upgrades", async () => {
    const direct = await executePlan(planCommerceDeployment(directArgs()));
    const safe = await executePlan(planCommerceDeployment(safeArgs()));
    const directUpgrade = direct.calls.find((call) => call.name === "writeUpgrade")!;
    const safeQueue = safe.calls.find((call) => call.name === "queueOwnerTransaction")!;
    const decodedSafe = decodeFunctionData({ abi: commerceAbi, data: safeQueue.args.data });

    assert.notEqual(directUpgrade.args.callData, "0x");
    assert.equal(decodedSafe.functionName, "upgradeToAndCall");
    assert.equal(decodedSafe.args[1], directUpgrade.args.callData);
    assert.equal(safe.result.initData, direct.result.initData);
  });

  it("preserves a four-token U, USD1, USDC, and USDT allowlist in fresh, direct, and Safe calldata", async () => {
    const paymentTokens = [defaultToken, usd1Token, usdcToken, usdtToken] as const;
    const freshPlan = planCommerceDeployment(
      directArgs({
        freshCommerce: true,
        commerceAction: "FRESH",
        commerceProxy: undefined,
        paymentTokens,
      }),
    );
    const freshCalls = await executeFreshAdapter(freshPlan, defaultToken);
    const freshInit = decodeFunctionData({ abi: commerceAbi, data: freshCalls[2].args.data });
    const direct = await executePlan(planCommerceDeployment(directArgs({ paymentTokens })));
    const safe = await executePlan(planCommerceDeployment(safeArgs({ paymentTokens })));
    const directUpgrade = direct.calls.find((call) => call.name === "writeUpgrade")!;
    const safeQueue = safe.calls.find((call) => call.name === "queueOwnerTransaction")!;
    const directInit = decodeFunctionData({ abi: commerceAbi, data: directUpgrade.args.callData });
    const safeUpgrade = decodeFunctionData({ abi: commerceAbi, data: safeQueue.args.data });

    assert.deepEqual(freshInit.args[0], paymentTokens);
    assert.deepEqual(directInit.args[0], paymentTokens);
    assert.equal(safeUpgrade.functionName, "upgradeToAndCall");
    assert.equal(safeUpgrade.args[1], directUpgrade.args.callData);
    assert.equal(safe.result.initData, direct.result.initData);
  });

  it("executes or queues a standalone initialize for an up-to-date v1 proxy", async () => {
    const direct = await executePlan(
      planCommerceDeployment(directArgs({ commerceAction: "up-to-date" })),
    );
    const safe = await executePlan(
      planCommerceDeployment(safeArgs({ commerceAction: "up-to-date" })),
    );

    assert.deepEqual(
      direct.calls.map((call) => call.name),
      ["writeInitialize"],
    );
    assert.deepEqual(
      safe.calls.map((call) => call.name),
      ["queueOwnerTransaction"],
    );
    assert.equal(safe.calls[0].args.data, direct.calls[0].args.data);
  });

  it("uses empty upgrade calldata at v2 and performs no init when up-to-date", async () => {
    const upgrade = await executePlan(
      planCommerceDeployment(directArgs({ initStatus: "complete" })),
    );
    const safeUpgrade = await executePlan(
      planCommerceDeployment(safeArgs({ initStatus: "complete" })),
    );
    const current = await executePlan(
      planCommerceDeployment(directArgs({ commerceAction: "up-to-date", initStatus: "complete" })),
    );

    assert.equal(upgrade.calls.find((call) => call.name === "writeUpgrade")!.args.callData, "0x");
    const safeQueue = safeUpgrade.calls.find((call) => call.name === "queueOwnerTransaction")!;
    const decodedSafe = decodeFunctionData({ abi: commerceAbi, data: safeQueue.args.data });
    assert.equal(decodedSafe.functionName, "upgradeToAndCall");
    assert.equal(decodedSafe.args[1], "0x");
    assert.deepEqual(current.calls, []);
    assert.equal(current.result.initData, undefined);
  });

  it("enables only missing explicit desired tokens on an initialized v2 proxy owned by the signer", async () => {
    const plan = planCommerceDeployment(
      directArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokenSupport: [
          { token: defaultToken, supported: true },
          { token: secondToken, supported: false },
        ],
      }),
    );
    const support = new Map([
      [defaultToken, true],
      [secondToken, false],
    ]);
    const calls: Array<{ name: string; args: any }> = [];

    assert.deepEqual(plan.paymentTokenReconciliation, {
      action: "set-supported",
      desiredPaymentTokens: [defaultToken, secondToken],
      missingPaymentTokens: [secondToken],
      state: "required",
    });

    const result = await executePaymentTokenReconciliation({
      plan,
      execute: true,
      abi: commerceAbi,
      callbacks: {
        readPaymentTokenSupported: async (token: `0x${string}`) => support.get(token)!,
        writeSetPaymentTokenSupported: async (args: any) => {
          calls.push({ name: "writeSetPaymentTokenSupported", args });
          support.set(args.token, true);
        },
        queueOwnerTransaction: (args: any) => calls.push({ name: "queueOwnerTransaction", args }),
      },
    });

    assert.deepEqual(
      calls.map((call) => call.name),
      ["writeSetPaymentTokenSupported"],
    );
    assert.equal(calls[0].args.token, secondToken);
    assert.equal(calls[0].args.enabled, true);
    assert.deepEqual(decodeFunctionData({ abi: commerceAbi, data: calls[0].args.data }), {
      functionName: "setPaymentTokenSupported",
      args: [secondToken, true],
    });
    assert.deepEqual(result, { action: "executed", verification: "verified" });
  });

  it("queues every missing explicit desired token in configuration order for an initialized v2 Safe owner", async () => {
    const paymentTokens = [defaultToken, usd1Token, usdcToken, usdtToken] as const;
    const plan = planCommerceDeployment(
      safeArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokens,
        paymentTokenSupport: [
          { token: defaultToken, supported: true },
          { token: usd1Token, supported: false },
          { token: usdcToken, supported: true },
          { token: usdtToken, supported: false },
        ],
      }),
    );
    const calls: Array<{ name: string; args: any }> = [];

    const result = await executePaymentTokenReconciliation({
      plan,
      execute: true,
      abi: commerceAbi,
      callbacks: {
        readPaymentTokenSupported: async () => {
          throw new Error("Safe reconciliation must not claim post-action verification");
        },
        writeSetPaymentTokenSupported: async () => {
          throw new Error("Safe reconciliation must not write directly");
        },
        queueOwnerTransaction: (args: any) => calls.push({ name: "queueOwnerTransaction", args }),
      },
    });

    assert.deepEqual(
      calls.map((call) => call.name),
      ["queueOwnerTransaction", "queueOwnerTransaction"],
    );
    assert.deepEqual(
      calls.map((call) => call.args.label),
      [
        `commerce.setPaymentTokenSupported(${usd1Token}, true)`,
        `commerce.setPaymentTokenSupported(${usdtToken}, true)`,
      ],
    );
    assert.deepEqual(
      calls.map((call) => call.args.to),
      [commerceProxy, commerceProxy],
    );
    assert.deepEqual(decodeFunctionData({ abi: commerceAbi, data: calls[0].args.data }), {
      functionName: "setPaymentTokenSupported",
      args: [usd1Token, true],
    });
    assert.deepEqual(decodeFunctionData({ abi: commerceAbi, data: calls[1].args.data }), {
      functionName: "setPaymentTokenSupported",
      args: [usdtToken, true],
    });
    assert.deepEqual(result, { action: "queued", verification: "pending" });
  });

  it("reconciles a mixed four-token desired allowlist in configuration order", async () => {
    const paymentTokens = [defaultToken, usd1Token, usdcToken, usdtToken] as const;
    const plan = planCommerceDeployment(
      directArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokens,
        paymentTokenSupport: [
          { token: defaultToken, supported: true },
          { token: usd1Token, supported: false },
          { token: usdcToken, supported: true },
          { token: usdtToken, supported: false },
        ],
      }),
    );
    const support = new Map<`0x${string}`, boolean>(
      paymentTokens.map((token) => [token, token === defaultToken || token === usdcToken]),
    );
    const writes: `0x${string}`[] = [];

    const result = await executePaymentTokenReconciliation({
      plan,
      execute: true,
      abi: commerceAbi,
      callbacks: {
        readPaymentTokenSupported: async (token: `0x${string}`) => support.get(token)!,
        writeSetPaymentTokenSupported: async ({ token }: { token: `0x${string}` }) => {
          writes.push(token);
          support.set(token, true);
        },
        queueOwnerTransaction: () => {
          throw new Error("direct reconciliation must not queue");
        },
      },
    });

    assert.deepEqual(plan.paymentTokenReconciliation.missingPaymentTokens, [usd1Token, usdtToken]);
    assert.deepEqual(writes, [usd1Token, usdtToken]);
    assert.deepEqual(result, { action: "executed", verification: "verified" });
  });

  it("treats an initialized v2 proxy with every desired token active as a verified no-op", async () => {
    const plan = planCommerceDeployment(
      directArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokenSupport: [
          { token: defaultToken, supported: true },
          { token: secondToken, supported: true },
        ],
      }),
    );

    assert.deepEqual(plan.paymentTokenReconciliation, {
      action: "none",
      desiredPaymentTokens: [defaultToken, secondToken],
      missingPaymentTokens: [],
      state: "verified",
    });
    assert.equal(
      isDeploymentNoop({
        freshPaymentToken: false,
        commerceAction: "up-to-date",
        commerceInitStatus: "complete",
        routerAction: "up-to-date",
        policyAction: "up-to-date",
        paymentTokenReconciliation: plan.paymentTokenReconciliation.state,
      }),
      true,
    );
  });

  it("uses the fresh and v1 initializer paths without redundant token setter calls", async () => {
    const plans = [
      planCommerceDeployment(
        directArgs({
          freshCommerce: true,
          commerceAction: "FRESH",
          commerceProxy: undefined,
        }),
      ),
      planCommerceDeployment(directArgs({ commerceAction: "up-to-date", initStatus: "required" })),
    ];

    for (const plan of plans) {
      const calls: Array<{ name: string; args: any }> = [];
      assert.equal(plan.paymentTokenReconciliation.action, "initializer");
      const result = await executePaymentTokenReconciliation({
        plan,
        execute: true,
        abi: commerceAbi,
        callbacks: {
          readPaymentTokenSupported: async () => true,
          writeSetPaymentTokenSupported: async (args: any) =>
            calls.push({ name: "writeSetPaymentTokenSupported", args }),
          queueOwnerTransaction: (args: any) => calls.push({ name: "queueOwnerTransaction", args }),
        },
      });

      assert.deepEqual(calls, []);
      assert.deepEqual(result, { action: "executed", verification: "verified" });
    }
  });

  it("uses and verifies the effective fallback token for fresh and direct v1 initialization", async () => {
    const plans = [
      planCommerceDeployment(
        directArgs({
          freshCommerce: true,
          commerceAction: "FRESH",
          paymentTokens: undefined,
          commerceProxy: undefined,
        }),
      ),
      planCommerceDeployment(
        directArgs({
          commerceAction: "up-to-date",
          initStatus: "required",
          paymentTokens: undefined,
        }),
      ),
    ];

    for (const plan of plans) {
      const supportReads: `0x${string}`[] = [];
      assert.deepEqual(plan.paymentTokenReconciliation, {
        action: "initializer",
        desiredPaymentTokens: [defaultToken],
        missingPaymentTokens: [],
        state: "required",
      });

      const result = await executePaymentTokenReconciliation({
        plan,
        execute: true,
        abi: commerceAbi,
        callbacks: {
          readPaymentTokenSupported: async (token: `0x${string}`) => {
            supportReads.push(token);
            return token === defaultToken;
          },
          writeSetPaymentTokenSupported: async () => {
            throw new Error("initializer must not add a redundant setter call");
          },
          queueOwnerTransaction: () => {
            throw new Error("direct initialization must not queue");
          },
        },
      });

      assert.deepEqual(supportReads, [defaultToken]);
      assert.deepEqual(result, { action: "executed", verification: "verified" });
    }
  });

  it("verifies the runtime fallback token after a truly fresh mock initializer", async () => {
    const plan = planCommerceDeployment(
      directArgs({
        freshCommerce: true,
        commerceAction: "FRESH",
        paymentToken: undefined,
        paymentTokens: undefined,
        commerceProxy: undefined,
      }),
    );
    const supportReads: `0x${string}`[] = [];

    assert.deepEqual(plan.paymentTokenReconciliation, {
      action: "initializer",
      missingPaymentTokens: [],
      state: "required",
    });

    const result = await executePaymentTokenReconciliation({
      plan,
      execute: true,
      abi: commerceAbi,
      paymentToken: defaultToken,
      callbacks: {
        readPaymentTokenSupported: async (token: `0x${string}`) => {
          supportReads.push(token);
          return token === defaultToken;
        },
        writeSetPaymentTokenSupported: async () => {
          throw new Error("fresh initializer must not add a setter call");
        },
        queueOwnerTransaction: () => {
          throw new Error("fresh initializer must not queue");
        },
      },
    });

    assert.deepEqual(supportReads, [defaultToken]);
    assert.deepEqual(result, { action: "executed", verification: "verified" });
  });

  it("refuses to report direct reconciliation as verified while a desired token remains inactive", async () => {
    const plan = planCommerceDeployment(
      directArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokenSupport: [
          { token: defaultToken, supported: true },
          { token: secondToken, supported: false },
        ],
      }),
    );

    await assert.rejects(
      () =>
        executePaymentTokenReconciliation({
          plan,
          execute: true,
          abi: commerceAbi,
          callbacks: {
            readPaymentTokenSupported: async (token: `0x${string}`) => token === defaultToken,
            writeSetPaymentTokenSupported: async () => {},
            queueOwnerTransaction: () => {
              throw new Error("direct reconciliation must not queue");
            },
          },
        }),
      /desired paymentTokens remain inactive: .*2000000000000000000000000000000000000002/,
    );
  });

  it("propagates a direct post-reconciliation verification RPC rejection", async () => {
    const plan = planCommerceDeployment(
      directArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokenSupport: [
          { token: defaultToken, supported: true },
          { token: secondToken, supported: false },
        ],
      }),
    );
    const rpcFailure = new Error("isPaymentTokenSupported RPC unavailable");
    let setterWrites = 0;

    await assert.rejects(
      () =>
        executePaymentTokenReconciliation({
          plan,
          execute: true,
          abi: commerceAbi,
          callbacks: {
            readPaymentTokenSupported: async () => {
              throw rpcFailure;
            },
            writeSetPaymentTokenSupported: async () => {
              setterWrites += 1;
            },
            queueOwnerTransaction: () => {
              throw new Error("direct reconciliation must not queue");
            },
          },
        }),
      (error) => error === rpcFailure,
    );
    assert.equal(setterWrites, 1);
  });

  it("leaves a Safe-owned v1 fallback initializer as queued and unverified", async () => {
    const plan = planCommerceDeployment(
      safeArgs({
        commerceAction: "up-to-date",
        initStatus: "required",
        paymentTokens: undefined,
      }),
    );

    assert.deepEqual(plan.paymentTokenReconciliation, {
      action: "initializer",
      desiredPaymentTokens: [defaultToken],
      missingPaymentTokens: [],
      state: "required",
    });

    const result = await executePaymentTokenReconciliation({
      plan,
      execute: true,
      abi: commerceAbi,
      callbacks: {
        readPaymentTokenSupported: async () => {
          throw new Error("queued initialization cannot be verified yet");
        },
        writeSetPaymentTokenSupported: async () => {
          throw new Error("queued initialization must not add a setter call");
        },
        queueOwnerTransaction: () => {
          throw new Error("the initializer was queued by the deployment executor");
        },
      },
    });

    assert.deepEqual(result, { action: "queued", verification: "pending" });
  });

  it("leaves required v2 reconciliation unexecuted during a dry run", async () => {
    const plan = planCommerceDeployment(
      directArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokenSupport: [
          { token: defaultToken, supported: true },
          { token: secondToken, supported: false },
        ],
      }),
    );

    const result = await executePaymentTokenReconciliation({
      plan,
      execute: false,
      abi: commerceAbi,
      callbacks: {
        readPaymentTokenSupported: async () => {
          throw new Error("dry run must not read post-action state");
        },
        writeSetPaymentTokenSupported: async () => {
          throw new Error("dry run must not write");
        },
        queueOwnerTransaction: () => {
          throw new Error("dry run must not queue");
        },
      },
    });

    assert.equal(plan.paymentTokenReconciliation.state, "required");
    assert.deepEqual(result, { action: "none", verification: "pending" });
  });

  it("invokes no deploy, write, or queue callback in dry-run for every planner state", async () => {
    const plans = [
      planCommerceDeployment(
        directArgs({ freshCommerce: true, commerceAction: "FRESH", commerceProxy: undefined }),
      ),
      planCommerceDeployment(directArgs()),
      planCommerceDeployment(safeArgs()),
      planCommerceDeployment(directArgs({ commerceAction: "up-to-date" })),
      planCommerceDeployment(safeArgs({ commerceAction: "up-to-date" })),
      planCommerceDeployment(directArgs({ initStatus: "complete" })),
      planCommerceDeployment(
        directArgs({
          freshCommerce: true,
          commerceAction: "FRESH",
          paymentToken: undefined,
          paymentTokens: undefined,
          commerceProxy: undefined,
        }),
      ),
      planCommerceDeployment(directArgs({ commerceAction: "up-to-date", initStatus: "complete" })),
    ];

    for (const plan of plans) {
      const { calls } = await executePlan(plan, false);
      assert.deepEqual(calls, []);
    }
  });

  it("reports nothing-to-do only when every component is current and init is v2", () => {
    const current = {
      freshPaymentToken: false,
      commerceAction: "up-to-date" as const,
      commerceInitStatus: "complete" as const,
      routerAction: "up-to-date" as const,
      policyAction: "up-to-date" as const,
      paymentTokenReconciliation: "verified" as const,
    };
    assert.equal(isDeploymentNoop(current), true);
    assert.equal(isDeploymentNoop({ ...current, commerceInitStatus: "required" }), false);
    assert.equal(isDeploymentNoop({ ...current, commerceAction: "UPGRADE" }), false);
    assert.equal(isDeploymentNoop({ ...current, routerAction: "UPGRADE" }), false);
    assert.equal(isDeploymentNoop({ ...current, policyAction: "FRESH" }), false);
    assert.equal(isDeploymentNoop({ ...current, freshPaymentToken: true }), false);
    assert.equal(isDeploymentNoop({ ...current, paymentTokenReconciliation: "required" }), false);
    assert.equal(isDeploymentNoop({ ...current, paymentTokenReconciliation: "unverified" }), false);
    assert.equal(
      isDeploymentNoop({ ...current, paymentTokenReconciliation: "not-configured" }),
      true,
    );
  });

  it("does not re-enable an omitted fallback token on an initialized v2 proxy", async () => {
    const plan = planCommerceDeployment(
      directArgs({
        commerceAction: "up-to-date",
        initStatus: "complete",
        paymentTokens: undefined,
        paymentTokenSupport: [{ token: defaultToken, supported: false }],
      }),
    );

    assert.deepEqual(plan.paymentTokenReconciliation, {
      action: "none",
      missingPaymentTokens: [],
      state: "not-configured",
    });
    const result = await executePaymentTokenReconciliation({
      plan,
      execute: true,
      abi: commerceAbi,
      callbacks: {
        readPaymentTokenSupported: async () => {
          throw new Error("omitted v2 config must not read or re-enable fallback support");
        },
        writeSetPaymentTokenSupported: async () => {
          throw new Error("omitted v2 config must not write");
        },
        queueOwnerTransaction: () => {
          throw new Error("omitted v2 config must not queue");
        },
      },
    });

    assert.deepEqual(result, { action: "none", verification: "not-requested" });
  });

  it("rejects invalid token config before any injected callback", async () => {
    const invalidConfigs: Array<{ config: Partial<PlanArgs>; error: RegExp }> = [
      { config: { paymentTokens: [] }, error: /paymentTokens must not be empty/ },
      {
        config: { paymentTokens: [defaultToken, defaultToken] },
        error: /paymentTokens contains duplicate address/,
      },
      {
        config: { paymentTokens: [defaultToken, zeroAddress] },
        error: /paymentTokens\[1\] must not be the zero address/,
      },
      {
        config: { paymentTokens: [secondToken] },
        error: /paymentTokens must include paymentToken/,
      },
      {
        config: { paymentToken: undefined, paymentTokens: [secondToken] },
        error: /paymentTokens requires paymentToken/,
      },
    ];

    for (const { config, error } of invalidConfigs) {
      const recorder = recordingCallbacks();
      await assert.rejects(async () => {
        const plan = planCommerceDeployment(directArgs(config));
        await executeCommerceDeployment({
          plan,
          execute: true,
          abi: commerceAbi,
          callbacks: recorder.callbacks,
        });
      }, error);
      assert.deepEqual(recorder.calls, []);
    }
  });

  it("includes the direct or calldata-only executor in the v1 init plan summary", () => {
    const direct = planCommerceDeployment(directArgs({ commerceAction: "up-to-date" }));
    const safe = planCommerceDeployment(safeArgs({ commerceAction: "up-to-date" }));

    assert.match(commerceInitPlanSummary(direct), /required \(direct\)/);
    assert.match(
      commerceInitPlanSummary(safe),
      new RegExp(`required \\(owner ${owner}.*calldata only`),
    );
  });
});
