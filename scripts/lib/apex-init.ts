import {
  encodeFunctionData,
  getAddress,
  zeroAddress,
  type Abi,
  type Address,
  type Hex,
} from "viem";

/**
 * Shared initializer-calldata and constructor-argument builders used by both
 * `scripts/deploy.ts` (at deployment time) and `scripts/verify.ts` (to
 * reproduce the exact bytes that BscScan / Etherscan will compare against).
 *
 * Keep this file dependency-free beyond `viem` so `verify.ts` doesn't have
 * to boot Hardhat to call these.
 */

export const ERC20_MOCK_CONSTRUCTOR_ARGS = ["Apex Test Token", "APT", 18] as const;

/**
 * OpenZeppelin Contracts Upgradeable v5.4.0
 * `proxy/utils/Initializable.sol::INITIALIZABLE_STORAGE`.
 *
 * The pinned source declares `uint64 _initialized` first and then
 * `bool _initializing` in the same ERC-7201 storage word. Solidity packs
 * both from the low-order (right-hand) bytes, so the version occupies bits
 * 0..63 and the initializing flag occupies bits 64..71.
 */
export const INITIALIZABLE_STORAGE_SLOT =
  "0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00";

export type MultiTokenInitStatus = "required" | "complete";

export function multiTokenInitStatus(storageWord: Hex | undefined): MultiTokenInitStatus {
  if (storageWord === undefined) {
    throw new Error("could not read Initializable storage");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(storageWord)) {
    throw new Error("Initializable storage word must be exactly 32 bytes");
  }

  const word = BigInt(storageWord);
  const initialized = word & ((1n << 64n) - 1n);
  const initializing = (word >> 64n) & 0xffn;
  const reserved = word >> 72n;

  if (reserved !== 0n) {
    throw new Error("Initializable storage word has unexpected reserved bits");
  }
  if (initializing !== 0n) {
    throw new Error("Initializable storage reports the proxy is currently initializing");
  }
  if (initialized === 1n) return "required";
  if (initialized === 2n) return "complete";
  throw new Error(`unexpected initialized version ${initialized}`);
}

export function resolvePaymentTokens(args: {
  paymentToken?: `0x${string}`;
  paymentTokens?: readonly `0x${string}`[];
}): readonly `0x${string}`[] | undefined {
  if (args.paymentToken === undefined) {
    if (args.paymentTokens !== undefined) {
      throw new Error("paymentTokens requires paymentToken");
    }
    return undefined;
  }

  const paymentToken = getAddress(args.paymentToken);
  const configured = args.paymentTokens ?? [paymentToken];
  if (configured.length === 0) {
    throw new Error("paymentTokens must not be empty");
  }

  const paymentTokens = configured.map((token, index) => {
    const normalized = getAddress(token);
    if (normalized === zeroAddress) {
      throw new Error(`paymentTokens[${index}] must not be the zero address`);
    }
    return normalized;
  });
  const unique = new Set(paymentTokens.map((token) => token.toLowerCase()));
  if (unique.size !== paymentTokens.length) {
    throw new Error("paymentTokens contains duplicate address");
  }
  if (!unique.has(paymentToken.toLowerCase())) {
    throw new Error("paymentTokens must include paymentToken");
  }
  return paymentTokens;
}

export type CommerceDeployAction = "FRESH" | "UPGRADE" | "up-to-date";
export type OwnerExecutor =
  | { readonly kind: "direct" }
  | { readonly kind: "calldata-only"; readonly owner: Address };
export type CommerceInitAction = "post-proxy" | "upgrade-call" | "standalone" | "none";
export type PaymentTokenSupport = { readonly token: Address; readonly supported: boolean };
export type PaymentTokenReconciliationPlan = {
  readonly action: "none" | "initializer" | "set-supported";
  readonly desiredPaymentTokens?: readonly Address[];
  readonly missingPaymentTokens: readonly Address[];
  readonly state: "not-configured" | "required" | "unverified" | "verified";
};

export async function validateConfiguredPaymentTokens(args: {
  paymentToken?: Address;
  paymentTokens?: readonly Address[];
  readCode(token: Address): Promise<Hex | undefined>;
}): Promise<readonly Address[] | undefined> {
  if (args.paymentTokens === undefined) return undefined;

  return validatePaymentTokens(args);
}

/**
 * Validate the effective initializer token list. Unlike the explicitly
 * configured v2 reconciliation list, an uninitialized Commerce must also
 * validate its backwards-compatible `[paymentToken]` fallback before it is
 * sent to `initializeMultiToken`.
 */
export async function validatePaymentTokens(args: {
  paymentToken?: Address;
  paymentTokens?: readonly Address[];
  readCode(token: Address): Promise<Hex | undefined>;
}): Promise<readonly Address[] | undefined> {
  const desiredPaymentTokens = resolvePaymentTokens(args);
  if (desiredPaymentTokens === undefined) return undefined;
  for (const [index, token] of desiredPaymentTokens.entries()) {
    const code = await args.readCode(token);
    if (code === undefined || code === "0x") {
      throw new Error(`paymentTokens[${index}] must be a deployed contract`);
    }
  }
  return desiredPaymentTokens;
}

export async function readConfiguredPaymentTokenSupport(args: {
  paymentToken?: Address;
  paymentTokens?: readonly Address[];
  readCode(token: Address): Promise<Hex | undefined>;
  readPaymentTokenSupported(token: Address): Promise<boolean>;
}): Promise<readonly PaymentTokenSupport[] | undefined> {
  const desiredPaymentTokens = await validateConfiguredPaymentTokens(args);
  if (desiredPaymentTokens === undefined) return undefined;
  return Promise.all(
    desiredPaymentTokens.map(async (token) => ({
      token,
      supported: await args.readPaymentTokenSupported(token),
    })),
  );
}

export type CommerceDeploymentPlan = {
  readonly freshCommerce: boolean;
  readonly commerceAction: CommerceDeployAction;
  readonly initStatus: MultiTokenInitStatus;
  readonly initAction: CommerceInitAction;
  readonly ownerExecutor: OwnerExecutor;
  readonly initExecutor: OwnerExecutor | null;
  readonly proxyInitializer: "initialize" | null;
  readonly tokenSource: "configured" | "fresh-mock-default";
  readonly configuredPaymentTokens?: readonly Address[];
  readonly paymentTokenReconciliation: PaymentTokenReconciliationPlan;
  readonly commerceProxy?: Address;
};

export function planCommerceDeployment(args: {
  freshCommerce: boolean;
  commerceAction: CommerceDeployAction;
  initStatus: MultiTokenInitStatus;
  ownerExecutor: OwnerExecutor;
  paymentToken?: Address;
  paymentTokens?: readonly Address[];
  paymentTokenSupport?: readonly PaymentTokenSupport[];
  commerceProxy?: Address;
}): CommerceDeploymentPlan {
  const configuredPaymentTokens = resolvePaymentTokens(args);
  const initAction: CommerceInitAction = args.freshCommerce
    ? "post-proxy"
    : args.initStatus === "complete"
      ? "none"
      : args.commerceAction === "UPGRADE"
        ? "upgrade-call"
        : "standalone";
  const paymentTokenReconciliation = planPaymentTokenReconciliation({
    paymentTokens: args.paymentTokens,
    configuredPaymentTokens,
    initAction,
    paymentTokenSupport: args.paymentTokenSupport,
  });

  return {
    freshCommerce: args.freshCommerce,
    commerceAction: args.commerceAction,
    initStatus: args.initStatus,
    initAction,
    ownerExecutor: args.ownerExecutor,
    initExecutor:
      initAction === "none" ? null : args.freshCommerce ? { kind: "direct" } : args.ownerExecutor,
    proxyInitializer: args.freshCommerce ? "initialize" : null,
    tokenSource: configuredPaymentTokens === undefined ? "fresh-mock-default" : "configured",
    configuredPaymentTokens,
    paymentTokenReconciliation,
    commerceProxy: args.commerceProxy,
  };
}

function planPaymentTokenReconciliation(args: {
  paymentTokens?: readonly Address[];
  configuredPaymentTokens?: readonly Address[];
  initAction: CommerceInitAction;
  paymentTokenSupport?: readonly PaymentTokenSupport[];
}): PaymentTokenReconciliationPlan {
  const desiredPaymentTokens =
    args.initAction === "none"
      ? args.paymentTokens === undefined
        ? undefined
        : args.configuredPaymentTokens
      : args.configuredPaymentTokens;
  if (args.initAction !== "none") {
    if (desiredPaymentTokens === undefined) {
      // A fresh mock token is deployed after the plan phase. Its runtime
      // address is supplied to the executor for the same post-init check.
      return { action: "initializer", missingPaymentTokens: [], state: "required" };
    }
    return {
      action: "initializer",
      desiredPaymentTokens,
      missingPaymentTokens: [],
      state: "required",
    };
  }
  if (desiredPaymentTokens === undefined) {
    return { action: "none", missingPaymentTokens: [], state: "not-configured" };
  }
  if (args.paymentTokenSupport === undefined) {
    return {
      action: "none",
      desiredPaymentTokens,
      missingPaymentTokens: [],
      state: "unverified",
    };
  }

  const desiredKeys = new Set(desiredPaymentTokens.map((token) => token.toLowerCase()));
  const supportByToken = new Map<string, boolean>();
  for (const { token, supported } of args.paymentTokenSupport) {
    const key = getAddress(token).toLowerCase();
    if (!desiredKeys.has(key)) {
      throw new Error(`paymentTokenSupport contains unconfigured token ${token}`);
    }
    if (supportByToken.has(key)) {
      throw new Error("paymentTokenSupport contains duplicate address");
    }
    supportByToken.set(key, supported);
  }
  if (supportByToken.size !== desiredPaymentTokens.length) {
    return {
      action: "none",
      desiredPaymentTokens,
      missingPaymentTokens: [],
      state: "unverified",
    };
  }

  const missingPaymentTokens = desiredPaymentTokens.filter(
    (token) => !supportByToken.get(token.toLowerCase()),
  );
  return {
    action: missingPaymentTokens.length === 0 ? "none" : "set-supported",
    desiredPaymentTokens,
    missingPaymentTokens,
    state: missingPaymentTokens.length === 0 ? "verified" : "required",
  };
}

export function commerceInitPlanSummary(plan: CommerceDeploymentPlan): string {
  if (plan.initStatus === "complete") return "complete";
  const executor = plan.initExecutor;
  if (executor?.kind === "calldata-only") {
    return `required (owner ${executor.owner} — calldata only)`;
  }
  return "required (direct)";
}

export function isDeploymentNoop(args: {
  freshPaymentToken: boolean;
  commerceAction: CommerceDeployAction;
  commerceInitStatus: MultiTokenInitStatus;
  routerAction: CommerceDeployAction;
  policyAction: "FRESH" | "up-to-date";
  paymentTokenReconciliation: PaymentTokenReconciliationPlan["state"];
}): boolean {
  return (
    !args.freshPaymentToken &&
    args.commerceAction === "up-to-date" &&
    args.commerceInitStatus === "complete" &&
    args.routerAction === "up-to-date" &&
    args.policyAction === "up-to-date" &&
    (args.paymentTokenReconciliation === "not-configured" ||
      args.paymentTokenReconciliation === "verified")
  );
}

/** Only report completion after owner-gated work and token verification finish. */
export function canReportDeploymentDone(args: {
  paymentTokenVerification: "not-requested" | "pending" | "verified";
  pendingOwnerTransactionCount: number;
}): boolean {
  return args.pendingOwnerTransactionCount === 0 && args.paymentTokenVerification !== "pending";
}

export type CommerceDeploymentCallbacks = {
  deployFresh(args: {
    paymentTokens: readonly Address[];
    initData: Hex;
    proxyInitializer: "initialize";
  }): Promise<void>;
  deployImplementation(): Promise<Address>;
  writeUpgrade(args: { implementation: Address; callData: Hex; data: Hex }): Promise<void>;
  writeInitialize(args: { paymentTokens: readonly Address[]; data: Hex }): Promise<void>;
  queueOwnerTransaction(args: { label: string; to: Address; data: Hex }): void;
};

export type PaymentTokenReconciliationCallbacks = {
  readPaymentTokenSupported(token: Address): Promise<boolean>;
  writeSetPaymentTokenSupported(args: { token: Address; enabled: true; data: Hex }): Promise<void>;
  queueOwnerTransaction(args: { label: string; to: Address; data: Hex }): void;
};

/** Fail closed when a mined direct deployment transaction did not succeed. */
export function assertTransactionReceiptSuccess(
  receipt: { readonly status: "success" | "reverted" },
  action: string,
): void {
  if (receipt.status !== "success") {
    throw new Error(`${action} transaction reverted`);
  }
}

export type TransactionReplacementReason = "cancelled" | "replaced" | "repriced";

/**
 * Wait for one direct owner transaction and fail closed if the transaction was
 * reverted or replaced before this deployment can report success.
 */
export async function waitForSuccessfulTransaction(args: {
  hash: Hex;
  action: string;
  waitForTransactionReceipt: (args: {
    hash: Hex;
    onReplaced: (args: { reason: TransactionReplacementReason }) => void;
  }) => Promise<{ status: "success" | "reverted" }>;
  verify?: () => Promise<boolean>;
}): Promise<void> {
  let replacementReason: TransactionReplacementReason | undefined;
  const receipt = await args.waitForTransactionReceipt({
    hash: args.hash,
    onReplaced: ({ reason }) => {
      replacementReason = reason;
    },
  });
  if (replacementReason !== undefined) {
    throw new Error(
      `${args.action} transaction was ${replacementReason}; rerun the deployment plan before reporting success`,
    );
  }
  assertTransactionReceiptSuccess(receipt, args.action);
  if (args.verify && !(await args.verify())) {
    throw new Error(`${args.action} post-transaction verification failed`);
  }
}

export type FreshCommerceCallbacks = {
  deployImplementation(): Promise<Address>;
  deployProxy(args: {
    implementation: Address;
    constructorArgs: readonly [implementation: Address, initData: Hex];
  }): Promise<Address>;
  writeInitializeMultiToken(args: {
    proxy: Address;
    paymentTokens: readonly Address[];
    data: Hex;
  }): Promise<unknown>;
};

export async function deployFreshCommerce(args: {
  abi: Abi;
  paymentToken: Address;
  treasury: Address;
  owner: Address;
  paymentTokens: readonly Address[];
  callbacks: FreshCommerceCallbacks;
}): Promise<{
  implementation: Address;
  proxy: Address;
  proxyInitData: Hex;
  multiTokenInitData: Hex;
  initializeTransaction: unknown;
}> {
  const implementation = await args.callbacks.deployImplementation();
  const proxyInitData = commerceInitCalldata(args.abi, {
    paymentToken: args.paymentToken,
    treasury: args.treasury,
    owner: args.owner,
  });
  const proxy = await args.callbacks.deployProxy({
    implementation,
    constructorArgs: [implementation, proxyInitData],
  });
  const multiTokenInitData = commerceMultiTokenInitCalldata(args.abi, args.paymentTokens);
  const initializeTransaction = await args.callbacks.writeInitializeMultiToken({
    proxy,
    paymentTokens: args.paymentTokens,
    data: multiTokenInitData,
  });
  return {
    implementation,
    proxy,
    proxyInitData,
    multiTokenInitData,
    initializeTransaction,
  };
}

export async function executeCommerceDeployment(args: {
  plan: CommerceDeploymentPlan;
  execute: boolean;
  abi: Abi;
  paymentToken?: Address;
  callbacks: CommerceDeploymentCallbacks;
}): Promise<{ executed: boolean; initData?: Hex; implementation?: Address }> {
  if (!args.execute) return { executed: false };

  const paymentTokens =
    args.plan.configuredPaymentTokens ??
    resolvePaymentTokens({ paymentToken: args.paymentToken }) ??
    (() => {
      throw new Error("fresh mock paymentToken is required for Commerce execution");
    })();
  const initData =
    args.plan.initStatus === "required"
      ? commerceMultiTokenInitCalldata(args.abi, paymentTokens)
      : undefined;

  if (args.plan.freshCommerce) {
    await args.callbacks.deployFresh({
      paymentTokens,
      initData: initData!,
      proxyInitializer: args.plan.proxyInitializer!,
    });
    return { executed: true, initData };
  }

  if (args.plan.commerceAction === "UPGRADE") {
    const implementation = await args.callbacks.deployImplementation();
    const callData = initData ?? "0x";
    const data = commerceUpgradeCalldata(args.abi, implementation, callData);
    if (args.plan.ownerExecutor.kind === "calldata-only") {
      args.callbacks.queueOwnerTransaction({
        label: `commerce.upgradeToAndCall(${implementation}, ${callData})`,
        to: args.plan.commerceProxy!,
        data,
      });
    } else {
      await args.callbacks.writeUpgrade({ implementation, callData, data });
    }
    return { executed: true, initData, implementation };
  }

  if (args.plan.initAction === "standalone") {
    if (args.plan.initExecutor?.kind === "calldata-only") {
      args.callbacks.queueOwnerTransaction({
        label: `commerce.initializeMultiToken(${paymentTokens.join(", ")})`,
        to: args.plan.commerceProxy!,
        data: initData!,
      });
    } else {
      await args.callbacks.writeInitialize({ paymentTokens, data: initData! });
    }
  }
  return { executed: true, initData };
}

export async function executePaymentTokenReconciliation(args: {
  plan: CommerceDeploymentPlan;
  execute: boolean;
  abi: Abi;
  paymentToken?: Address;
  callbacks: PaymentTokenReconciliationCallbacks;
}): Promise<{
  action: "none" | "queued" | "executed";
  verification: "not-requested" | "pending" | "verified";
}> {
  const reconciliation = args.plan.paymentTokenReconciliation;
  if (reconciliation.state === "not-configured") {
    return { action: "none", verification: "not-requested" };
  }
  if (reconciliation.state === "unverified") {
    throw new Error("configured paymentTokens were not verified against Commerce support");
  }
  if (reconciliation.state === "verified" && !args.execute) {
    return { action: "none", verification: "verified" };
  }
  if (!args.execute) {
    return { action: "none", verification: "pending" };
  }

  const desiredPaymentTokens =
    reconciliation.desiredPaymentTokens ??
    resolvePaymentTokens({ paymentToken: args.paymentToken }) ??
    (() => {
      throw new Error("Commerce initializer completed without a paymentToken to verify");
    })();
  if (reconciliation.action === "initializer") {
    if (args.plan.initExecutor?.kind === "calldata-only") {
      return { action: "queued", verification: "pending" };
    }
  } else if (reconciliation.action === "set-supported") {
    if (args.plan.ownerExecutor.kind === "calldata-only") {
      for (const token of reconciliation.missingPaymentTokens) {
        const data = commerceSetPaymentTokenSupportedCalldata(args.abi, token);
        args.callbacks.queueOwnerTransaction({
          label: `commerce.setPaymentTokenSupported(${token}, true)`,
          to: args.plan.commerceProxy!,
          data,
        });
      }
      return { action: "queued", verification: "pending" };
    }
    for (const token of reconciliation.missingPaymentTokens) {
      await args.callbacks.writeSetPaymentTokenSupported({
        token,
        enabled: true,
        data: commerceSetPaymentTokenSupportedCalldata(args.abi, token),
      });
    }
  }

  const inactive = await Promise.all(
    desiredPaymentTokens.map(async (token) => ({
      token,
      supported: await args.callbacks.readPaymentTokenSupported(token),
    })),
  );
  const inactiveTokens = inactive.filter(({ supported }) => !supported).map(({ token }) => token);
  if (inactiveTokens.length > 0) {
    throw new Error(`desired paymentTokens remain inactive: ${inactiveTokens.join(", ")}`);
  }
  return {
    action: reconciliation.action === "none" ? "none" : "executed",
    verification: "verified",
  };
}

export function commerceInitCalldata(
  abi: Abi,
  args: {
    paymentToken: `0x${string}`;
    treasury: `0x${string}`;
    owner: `0x${string}`;
  },
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [args.paymentToken, args.treasury, args.owner],
  });
}

export function commerceMultiTokenInitCalldata(
  abi: Abi,
  paymentTokens: readonly `0x${string}`[],
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName: "initializeMultiToken",
    args: [paymentTokens],
  });
}

export function commerceSetPaymentTokenSupportedCalldata(
  abi: Abi,
  token: `0x${string}`,
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName: "setPaymentTokenSupported",
    args: [token, true],
  });
}

export function commerceUpgradeCalldata(
  abi: Abi,
  implementation: `0x${string}`,
  callData: `0x${string}`,
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName: "upgradeToAndCall",
    args: [implementation, callData],
  });
}

export function routerInitCalldata(
  abi: Abi,
  args: {
    commerce: `0x${string}`;
    owner: `0x${string}`;
  },
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [args.commerce, args.owner],
  });
}

export type PolicyConstructorArgs = readonly [
  commerce: `0x${string}`,
  router: `0x${string}`,
  admin: `0x${string}`,
  disputeWindow: bigint,
  initialQuorum: number,
];

export function policyConstructorArgs(args: {
  commerce: `0x${string}`;
  router: `0x${string}`;
  admin: `0x${string}`;
  disputeWindow: bigint;
  initialQuorum: number;
}): PolicyConstructorArgs {
  return [args.commerce, args.router, args.admin, args.disputeWindow, args.initialQuorum] as const;
}
