/**
 * Builds the runtime context for an E2E run.
 *
 *  - local   → fresh ERC20MinimalMock + Commerce proxy + Router proxy + Policy, all
 *              tied to Hardhat's prefunded accounts.
 *  - testnet → reuse the live Commerce + Router proxies from
 *              `scripts/addresses.ts`; deploy a fresh short-window Policy,
 *              whitelist it, and add the owner as the sole voter.
 */

import { encodeFunctionData, getAddress, type WalletClient } from "viem";

import { ADDRESSES } from "../../scripts/addresses.js";
import type { E2EConfig } from "./config.js";
import { loadWallets, type E2EWallets } from "./lib/wallets.js";
import { createLogger, type Logger } from "./lib/logging.js";
import { waitForReceipt } from "./lib/wait.js";
import { testnetPreflight } from "./lib/preflight.js";
import { createTimeController, type TimeController } from "./lib/time.js";

export interface E2EContext {
  cfg: E2EConfig;
  log: Logger;
  time: TimeController;

  // Contracts (default client: owner). Per-flow the caller rebinds with
  // `asContract(addr, wallet)` to act as client/provider/voter.
  commerce: any;
  router: any;
  policy: any;
  token: any;

  wallets: E2EWallets;
  paymentToken: `0x${string}`;
  tokenDecimals: number;
  budget: bigint;

  publicClient: any;
  viem: any;

  /** Helper: re-bind contract to a specific wallet client. */
  asCommerce(wallet: WalletClient): Promise<any>;
  asRouter(wallet: WalletClient): Promise<any>;
  asPolicy(wallet: WalletClient): Promise<any>;
  asToken(wallet: WalletClient): Promise<any>;
}

// ---------------------------------------------------------------------------
// Local: fresh deploy everything
// ---------------------------------------------------------------------------

async function buildLocalContext(
  viem: any,
  cfg: E2EConfig,
  log: Logger,
  wallets: E2EWallets,
): Promise<E2EContext> {
  const publicClient = await viem.getPublicClient();
  const ownerAddr = getAddress(wallets.owner.account!.address);
  const withOwner = { client: { wallet: wallets.owner } };

  log.header("Local deploy");

  const token = await viem.deployContract("ERC20MinimalMock", ["E2E Token", "E2E", 18], withOwner);
  log.info(`ERC20MinimalMock : ${token.address}`);

  const commerceImpl = await viem.deployContract("AgenticCommerceUpgradeable", [], withOwner);
  const commerceInit = encodeFunctionData({
    abi: commerceImpl.abi,
    functionName: "initialize",
    args: [token.address, ownerAddr, ownerAddr],
  });
  const commerceProxy = await viem.deployContract(
    "ERC1967Proxy",
    [commerceImpl.address, commerceInit],
    withOwner,
  );
  const commerce = await viem.getContractAt(
    "AgenticCommerceUpgradeable",
    commerceProxy.address,
    withOwner,
  );
  log.info(`Commerce  : ${commerce.address}`);

  const routerImpl = await viem.deployContract("EvaluatorRouterUpgradeable", [], withOwner);
  const routerInit = encodeFunctionData({
    abi: routerImpl.abi,
    functionName: "initialize",
    args: [commerce.address, ownerAddr],
  });
  const routerProxy = await viem.deployContract(
    "ERC1967Proxy",
    [routerImpl.address, routerInit],
    withOwner,
  );
  const router = await viem.getContractAt(
    "EvaluatorRouterUpgradeable",
    routerProxy.address,
    withOwner,
  );
  log.info(`Router    : ${router.address}`);

  const policy = await viem.deployContract(
    "OptimisticPolicy",
    [
      commerce.address,
      router.address,
      ownerAddr,
      BigInt(cfg.disputeWindowSeconds),
      cfg.initialQuorum,
    ],
    withOwner,
  );
  log.info(
    `Policy    : ${policy.address} (window=${cfg.disputeWindowSeconds}s, quorum=${cfg.initialQuorum})`,
  );

  await router.write.setPolicyWhitelist([policy.address, true]);
  for (const v of wallets.voters) {
    await policy.write.addVoter([getAddress(v.account!.address)]);
  }
  log.ok(`whitelisted policy + ${wallets.voters.length} voter(s) added`);

  const budget = 10n ** 18n * BigInt(cfg.budgetUnits);

  // Pre-fund the client once upfront with enough tokens to cover every funded
  // flow (A/B/C/E). Each flow's balance snapshot then sees the same shape as
  // the testnet path, where the user is expected to pre-fund the client EOA.
  const fundedFlowsPerRun = 4;
  const clientAddr = getAddress(wallets.client.account!.address);
  await token.write.mint([clientAddr, budget * BigInt(fundedFlowsPerRun)]);
  log.info(`minted ${fundedFlowsPerRun}×budget to client (${clientAddr})`);

  const ctx: E2EContext = {
    cfg,
    log,
    time: createTimeController("local", publicClient, viem),
    commerce,
    router,
    policy,
    token,
    wallets,
    paymentToken: token.address,
    tokenDecimals: 18,
    budget,
    publicClient,
    viem,
    asCommerce: (wallet) =>
      viem.getContractAt("AgenticCommerceUpgradeable", commerce.address, {
        client: { wallet },
      }),
    asRouter: (wallet) =>
      viem.getContractAt("EvaluatorRouterUpgradeable", router.address, {
        client: { wallet },
      }),
    asPolicy: (wallet) =>
      viem.getContractAt("OptimisticPolicy", policy.address, { client: { wallet } }),
    asToken: (wallet) =>
      viem.getContractAt("ERC20MinimalMock", token.address, { client: { wallet } }),
  };
  return ctx;
}

// ---------------------------------------------------------------------------
// Testnet: reuse live proxies, deploy fresh short-window policy
// ---------------------------------------------------------------------------

async function buildTestnetContext(
  viem: any,
  cfg: E2EConfig,
  log: Logger,
  wallets: E2EWallets,
): Promise<E2EContext> {
  const addrs = ADDRESSES[cfg.networkName];
  if (!addrs) {
    throw new Error(`scripts/addresses.ts has no entry for "${cfg.networkName}".`);
  }
  if (!addrs.commerceProxy || !addrs.routerProxy) {
    throw new Error(
      `scripts/addresses.ts["${cfg.networkName}"] is missing commerceProxy and/or routerProxy. ` +
        `Run \`bun run deploy:testnet\` first and paste the printed block into addresses.ts.`,
    );
  }

  const publicClient = await viem.getPublicClient();
  const ownerAddr = getAddress(wallets.owner.account!.address);
  const withOwner = { client: { wallet: wallets.owner } };

  log.header("Testnet context");
  log.info(`Commerce  : ${addrs.commerceProxy}`);
  log.info(`Router    : ${addrs.routerProxy}`);
  log.info(`Owner     : ${ownerAddr}`);
  log.info(`Client    : ${getAddress(wallets.client.account!.address)}`);
  log.info(`Provider  : ${getAddress(wallets.provider.account!.address)}`);

  const commerce = await viem.getContractAt(
    "AgenticCommerceUpgradeable",
    addrs.commerceProxy,
    withOwner,
  );
  const router = await viem.getContractAt(
    "EvaluatorRouterUpgradeable",
    addrs.routerProxy,
    withOwner,
  );
  const paymentToken = getAddress((await commerce.read.paymentToken()) as `0x${string}`);
  const token = await viem.getContractAt("ERC20MinimalMock", paymentToken, withOwner);

  const preflight = await testnetPreflight(
    publicClient,
    commerce,
    router,
    token,
    wallets,
    cfg,
    log,
  );

  // Deploy fresh short-window policy for this run.
  log.header("Policy deploy");
  const policy = await viem.deployContract(
    "OptimisticPolicy",
    [
      commerce.address,
      router.address,
      ownerAddr,
      BigInt(cfg.disputeWindowSeconds),
      cfg.initialQuorum,
    ],
    withOwner,
  );
  log.info(
    `Policy    : ${policy.address} (window=${cfg.disputeWindowSeconds}s, quorum=${cfg.initialQuorum})`,
  );

  // Whitelist + add voters. `await` on `write` returns a tx hash — we wait so
  // the subsequent call sees confirmed state on a reorg-lazy RPC.
  const whitelistHash = await router.write.setPolicyWhitelist([policy.address, true]);
  await waitForReceipt(publicClient, whitelistHash);
  log.tx(whitelistHash, "whitelist");

  for (const v of wallets.voters) {
    const addr = getAddress(v.account!.address);
    const hash = await policy.write.addVoter([addr]);
    await waitForReceipt(publicClient, hash);
    log.tx(hash, `addVoter(${addr})`);
  }
  log.ok(`policy whitelisted + ${wallets.voters.length} voter(s) added`);

  const ctx: E2EContext = {
    cfg,
    log,
    time: createTimeController("testnet", publicClient, viem),
    commerce,
    router,
    policy,
    token,
    wallets,
    paymentToken: preflight.paymentToken,
    tokenDecimals: preflight.decimals,
    budget: preflight.budget,
    publicClient,
    viem,
    asCommerce: (wallet) =>
      viem.getContractAt("AgenticCommerceUpgradeable", commerce.address, {
        client: { wallet },
      }),
    asRouter: (wallet) =>
      viem.getContractAt("EvaluatorRouterUpgradeable", router.address, {
        client: { wallet },
      }),
    asPolicy: (wallet) =>
      viem.getContractAt("OptimisticPolicy", policy.address, { client: { wallet } }),
    asToken: (wallet) =>
      viem.getContractAt("ERC20MinimalMock", paymentToken, { client: { wallet } }),
  };
  return ctx;
}

export async function buildContext(viem: any, cfg: E2EConfig): Promise<E2EContext> {
  const log = createLogger(cfg.networkName);
  const wallets = await loadWallets(viem, cfg);
  return cfg.kind === "local"
    ? buildLocalContext(viem, cfg, log, wallets)
    : buildTestnetContext(viem, cfg, log, wallets);
}
