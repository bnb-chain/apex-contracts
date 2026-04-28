import { encodeFunctionData, keccak256, toBytes, getAddress, zeroAddress } from "viem";

/**
 * JobStatus enum mirror from IACP.sol.
 */
export const JobStatus = {
  Open: 0,
  Funded: 1,
  Submitted: 2,
  Completed: 3,
  Rejected: 4,
  Expired: 5,
} as const;

/**
 * Verdict enum mirror from IPolicy / OptimisticPolicy.
 */
export const Verdict = {
  Pending: 0,
  Approve: 1,
  Reject: 2,
} as const;

export const DEFAULT_BUDGET = 1_000_000_000_000_000_000n; // 1e18

export const DEFAULT_DISPUTE_WINDOW = 3600n; // 1 hour

export const DEFAULT_INITIAL_QUORUM = 2; // requires 2 voters to reject

export const ZERO_BYTES32 =
  "0x0000000000000000000000000000000000000000000000000000000000000000" as const;

/**
 * Deploy a fresh ERC20MinimalMock with 18 decimals.
 */
export async function deployMockToken(viem: any) {
  return viem.deployContract("ERC20MinimalMock", ["Test Token", "TEST", 18]);
}

/**
 * Deploy a no-op IACPHook. Used as a benign placeholder hook in tests where
 * the kernel requires a non-zero hook (post-audit L05) but the test does not
 * exercise hook semantics.
 */
export async function deployNoopHook(viem: any) {
  return viem.deployContract("NoopHook", []);
}

/**
 * Deploy AgenticCommerceUpgradeable behind an ERC1967Proxy.
 */
export async function deployCommerce(
  viem: any,
  opts: { paymentToken: `0x${string}`; treasury: `0x${string}`; owner: `0x${string}` },
) {
  const impl = await viem.deployContract("AgenticCommerceUpgradeable", []);
  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [opts.paymentToken, opts.treasury, opts.owner],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
  return {
    proxy: await viem.getContractAt("AgenticCommerceUpgradeable", proxy.address),
    impl,
  };
}

/**
 * Deploy EvaluatorRouterUpgradeable behind an ERC1967Proxy.
 */
export async function deployRouter(
  viem: any,
  opts: { commerce: `0x${string}`; owner: `0x${string}` },
) {
  const impl = await viem.deployContract("EvaluatorRouterUpgradeable", []);
  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [opts.commerce, opts.owner],
  });
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
  return {
    proxy: await viem.getContractAt("EvaluatorRouterUpgradeable", proxy.address),
    impl,
  };
}

/**
 * Deploy an immutable OptimisticPolicy instance.
 */
export async function deployOptimisticPolicy(
  viem: any,
  opts: {
    commerce: `0x${string}`;
    router: `0x${string}`;
    admin: `0x${string}`;
    disputeWindow?: bigint;
    initialQuorum?: number;
  },
) {
  return viem.deployContract("OptimisticPolicy", [
    opts.commerce,
    opts.router,
    opts.admin,
    opts.disputeWindow ?? DEFAULT_DISPUTE_WINDOW,
    opts.initialQuorum ?? DEFAULT_INITIAL_QUORUM,
  ]);
}

/**
 * One-shot stack deployment: token + commerce + router + whitelisted
 * OptimisticPolicy. All contracts share the same `owner` / `admin`.
 */
export async function deployStack(
  viem: any,
  opts: {
    owner: `0x${string}`;
    treasury: `0x${string}`;
    disputeWindow?: bigint;
    initialQuorum?: number;
    voters?: `0x${string}`[];
  },
) {
  const token = await deployMockToken(viem);
  const { proxy: commerce } = await deployCommerce(viem, {
    paymentToken: token.address,
    treasury: opts.treasury,
    owner: opts.owner,
  });
  const { proxy: router } = await deployRouter(viem, {
    commerce: commerce.address,
    owner: opts.owner,
  });
  const policy = await deployOptimisticPolicy(viem, {
    commerce: commerce.address,
    router: router.address,
    admin: opts.owner,
    disputeWindow: opts.disputeWindow,
    initialQuorum: opts.initialQuorum,
  });

  await router.write.setPolicyWhitelist([policy.address, true]);

  if (opts.voters && opts.voters.length > 0) {
    for (const v of opts.voters) {
      await policy.write.addVoter([v]);
    }
  }

  return { token, commerce, router, policy };
}

/**
 * Current on-chain block timestamp as bigint.
 */
export async function blockTimestamp(viem: any): Promise<bigint> {
  const publicClient = await viem.getPublicClient();
  const block = await publicClient.getBlock();
  return block.timestamp;
}

/**
 * Fast-forward the chain by `seconds`.
 */
export async function advanceSeconds(viem: any, seconds: bigint | number) {
  const testClient = await viem.getTestClient();
  await testClient.increaseTime({ seconds: Number(seconds) });
  await testClient.mine({ blocks: 1 });
}

/**
 * Full happy-path setup: a brand-new funded + submitted job, ready for the
 * policy's optimistic window / dispute workflow.
 */
export async function createFundedSubmittedJob(
  viem: any,
  ctx: {
    token: any;
    commerce: any;
    router: any;
    policy: any;
    client: any;
    provider: any;
    budget?: bigint;
    expiresIn?: bigint;
  },
) {
  const budget = ctx.budget ?? DEFAULT_BUDGET;
  const expiresIn = ctx.expiresIn ?? 86_400n;
  const expiredAt = (await blockTimestamp(viem)) + expiresIn;

  const clientAddr = getAddress(ctx.client.account.address);
  const providerAddr = getAddress(ctx.provider.account.address);

  const commerceAsClient = await viem.getContractAt(
    "AgenticCommerceUpgradeable",
    ctx.commerce.address,
    { client: { wallet: ctx.client } },
  );
  const routerAsClient = await viem.getContractAt(
    "EvaluatorRouterUpgradeable",
    ctx.router.address,
    { client: { wallet: ctx.client } },
  );

  await commerceAsClient.write.createJob([
    providerAddr,
    ctx.router.address,
    expiredAt,
    "Integration job",
    ctx.router.address,
  ]);
  const jobId = 1n;

  await routerAsClient.write.registerJob([jobId, ctx.policy.address]);
  await commerceAsClient.write.setBudget([jobId, budget, "0x"]);

  await ctx.token.write.mint([clientAddr, budget]);
  const tokenAsClient = await viem.getContractAt("ERC20MinimalMock", ctx.token.address, {
    client: { wallet: ctx.client },
  });
  await tokenAsClient.write.approve([ctx.commerce.address, budget]);

  await commerceAsClient.write.fund([jobId, budget, "0x"]);

  const deliverable = keccak256(toBytes("deliverable"));
  const commerceAsProvider = await viem.getContractAt(
    "AgenticCommerceUpgradeable",
    ctx.commerce.address,
    { client: { wallet: ctx.provider } },
  );
  await commerceAsProvider.write.submit([jobId, deliverable, "0x"]);

  return { jobId, deliverable, expiredAt, budget };
}

export { zeroAddress };
