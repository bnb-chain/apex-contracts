import hre, { network } from "hardhat";
import { encodeFunctionData, getAddress, parseUnits } from "viem";
import { ADDRESSES } from "./addresses.js";
import {
  ERC20_MOCK_CONSTRUCTOR_ARGS,
  commerceInitCalldata,
  routerInitCalldata,
} from "./lib/apex-init.js";

/**
 * Single idempotent deploy / upgrade / rotation script for the v1 stack.
 *
 * Modes:
 *   - DRY RUN (default): computes and prints the plan below — which contracts
 *     are fresh / need an upgrade / are up-to-date — sends ZERO transactions.
 *   - EXECUTE: pass `--yes` or set `DEPLOY_YES=1` to actually run the plan.
 *
 * Two cascading triggers decide what gets (re)built, in this order:
 *
 *   1. paymentToken blank in ADDRESSES[network]
 *        → deploy fresh ERC20MinimalMock
 *        → deploy fresh Commerce (new proxy) using that token
 *        → deploy fresh Router (new proxy) pointing at that new Commerce
 *        (cfg.commerceProxy / cfg.routerProxy are IGNORED in this branch;
 *         treat this as "rotate everything".)
 *
 *   2. paymentToken filled → use it verbatim
 *        Commerce:
 *          - cfg.commerceProxy filled → keep proxy. Upgrade the impl ONLY if
 *            the compiled bytecode differs from what is behind the proxy
 *            on-chain (immutable regions masked before comparing).
 *          - cfg.commerceProxy blank  → deploy fresh Commerce, AND force the
 *            Router down the fresh path too (see cascade rule below)
 *        Router (`freshRouter = freshCommerce || !cfg.routerProxy`):
 *          - cfg.routerProxy filled and Commerce was reused → keep proxy,
 *            same bytecode-diff rule as Commerce
 *          - else → deploy fresh Router pointing at the Commerce above
 *
 * Policy is redeployed ONLY when needed: fresh Router, blank cfg.policy,
 * bytecode drift, or cfg.policy pointing at a different commerce/router.
 * Constructor params (disputeWindow, initialQuorum) live in immutables and
 * are masked out of the comparison — to rotate params without a code change,
 * blank cfg.policy in scripts/addresses.ts to force a redeploy.
 *
 * Owner-gated calls (upgradeToAndCall, setPolicyWhitelist):
 *   - proxy owner == signer → sent directly.
 *   - otherwise (multisig / another EOA) → NOT sent; the exact Safe
 *     transaction (to / value / data) is printed at the end for the owner to
 *     execute (e.g. paste into Safe{Wallet}). New impls / policies are still
 *     deployed by the signer — deployment is permissionless.
 *
 * Cascade rule — why `freshCommerce → freshRouter` is forced:
 *   Router stores `commerce` in its own storage. If we ever kept the
 *   Router while swapping Commerce, we'd need `router.setCommerce` which
 *   requires `router.pause()`, plus careful drainage of in-flight jobs.
 *   Fresh Router sidesteps all of that. Old Commerce / old Router remain
 *   on-chain so clients can still call `oldCommerce.claimRefund` after
 *   expiry.
 *
 * Invariants (reuse paths only):
 *   - commerce.paymentToken() MUST equal cfg.paymentToken. paymentToken is
 *     immutable on Commerce — a mismatch means cfg is inconsistent.
 *   - router.commerce() MUST equal the Commerce we're using this run.
 *
 * Side effects:
 *   - Never writes to ADDRESSES / scripts/addresses.ts. At the end it prints
 *     only the fields that changed this run; the operator pastes them back
 *     manually.
 */

type AnyViem = Awaited<ReturnType<typeof network.connect>>["viem"];
type PublicClient = Awaited<ReturnType<AnyViem["getPublicClient"]>>;
type Action = "FRESH" | "UPGRADE" | "up-to-date";

const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

type ImmutableRefs = Record<string, Array<{ start: number; length: number }>>;

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env var: ${key}`);
}

function sameAddr(a: `0x${string}`, b: `0x${string}`): boolean {
  return getAddress(a) === getAddress(b);
}

/** Zero out immutable value regions so bytecode from two deployments (or the
 *  local artifact, whose immutable slots are zero-filled) compares equal. */
function maskImmutables(code: `0x${string}` | undefined, refs: ImmutableRefs): string {
  let body = (code ?? "0x").slice(2).toLowerCase();
  for (const regions of Object.values(refs)) {
    for (const { start, length } of regions) {
      const from = start * 2;
      const to = from + length * 2;
      if (to <= body.length) {
        body = body.slice(0, from) + "0".repeat(length * 2) + body.slice(to);
      }
    }
  }
  return body;
}

/** Does the deployed code at `addr` match the locally compiled artifact? */
async function codeMatchesArtifact(
  publicClient: PublicClient,
  addr: `0x${string}`,
  contractName: string,
): Promise<boolean> {
  const artifact = await hre.artifacts.readArtifact(contractName);
  const refs = (artifact as { immutableReferences?: ImmutableRefs }).immutableReferences ?? {};
  const onChain = await publicClient.getCode({ address: addr });
  return (
    maskImmutables(onChain, refs) ===
    maskImmutables(artifact.deployedBytecode as `0x${string}`, refs)
  );
}

/** Read the ERC-1967 implementation address behind a proxy. */
async function readImplementation(
  publicClient: PublicClient,
  proxy: `0x${string}`,
): Promise<`0x${string}`> {
  const word = await publicClient.getStorageAt({ address: proxy, slot: ERC1967_IMPL_SLOT });
  const impl = getAddress(`0x${(word ?? "0x").slice(-40).padStart(40, "0")}`);
  if (/^0x0{40}$/.test(impl)) {
    throw new Error(`${proxy} has an empty ERC-1967 implementation slot — not a UUPS proxy?`);
  }
  return impl;
}

async function main(): Promise<void> {
  const { viem, networkName } = await network.connect();
  const publicClient = await viem.getPublicClient();
  const [deployerClient] = await viem.getWalletClients();
  const deployer = getAddress(deployerClient.account.address);

  const execute = process.argv.includes("--yes") || process.env.DEPLOY_YES === "1";
  const cfg = ADDRESSES[networkName] ?? {};
  const owner = deployer;
  const disputeWindow = BigInt(env("DISPUTE_WINDOW_SECONDS", "259200"));
  const initialQuorum = Number(env("INITIAL_QUORUM", "3"));

  // Owner-gated transactions the signer cannot send (proxy owned by a
  // multisig / another EOA). Printed at the end for manual execution.
  const pendingOwnerTxs: Array<{ label: string; to: `0x${string}`; data: `0x${string}` }> = [];

  // Cascade rule: blank paymentToken forces a full-stack rotation. Blank
  // commerceProxy alone also forces a fresh Router so we never end up with
  // a Router pointing at a stale Commerce.
  const freshPaymentToken = !cfg.paymentToken;
  const freshCommerce = freshPaymentToken || !cfg.commerceProxy;
  const freshRouter = freshCommerce || !cfg.routerProxy;

  // ------------------------------------------------------------------------
  // Plan phase (read-only): decide the action + executor for every contract.
  // ------------------------------------------------------------------------
  let commerceAction: Action = "FRESH";
  let commerceOwner: `0x${string}` | null = null; // null → fresh (owner = deployer)
  if (!freshCommerce) {
    const proxyAddr = cfg.commerceProxy!;
    const commerceHandle = await viem.getContractAt("AgenticCommerceUpgradeable", proxyAddr);
    const onChainPaymentToken = await commerceHandle.read.paymentToken();
    if (!sameAddr(onChainPaymentToken, cfg.paymentToken!)) {
      throw new Error(
        `paymentToken mismatch on commerceProxy ${proxyAddr}: ` +
          `on-chain ${onChainPaymentToken}, cfg ${cfg.paymentToken}. ` +
          `paymentToken is immutable on Commerce. To rotate, clear paymentToken ` +
          `in scripts/addresses.ts (the script will then redeploy the full stack).`,
      );
    }
    commerceOwner = await commerceHandle.read.owner();
    const impl = await readImplementation(publicClient, proxyAddr);
    commerceAction = (await codeMatchesArtifact(publicClient, impl, "AgenticCommerceUpgradeable"))
      ? "up-to-date"
      : "UPGRADE";
  }

  let routerAction: Action = "FRESH";
  let routerOwner: `0x${string}` | null = null;
  if (!freshRouter) {
    const proxyAddr = cfg.routerProxy!;
    const routerHandle = await viem.getContractAt("EvaluatorRouterUpgradeable", proxyAddr);
    const onChainCommerce = await routerHandle.read.commerce();
    if (!sameAddr(onChainCommerce, cfg.commerceProxy!)) {
      throw new Error(
        `router.commerce() = ${onChainCommerce} but this run uses ` +
          `commerce ${cfg.commerceProxy}. Fix ADDRESSES["${networkName}"] so ` +
          `commerceProxy matches the router's stored commerce before redeploying.`,
      );
    }
    routerOwner = await routerHandle.read.owner();
    const impl = await readImplementation(publicClient, proxyAddr);
    routerAction = (await codeMatchesArtifact(publicClient, impl, "EvaluatorRouterUpgradeable"))
      ? "up-to-date"
      : "UPGRADE";
  }

  let policyAction: "FRESH" | "up-to-date" = "FRESH";
  if (!freshRouter && cfg.policy) {
    const codeOk = await codeMatchesArtifact(publicClient, cfg.policy, "OptimisticPolicy");
    if (codeOk) {
      // commerce/router are immutables — masked out of the code comparison —
      // so also confirm the deployed policy points at THIS stack.
      const policyHandle = await viem.getContractAt("OptimisticPolicy", cfg.policy);
      const [polCommerce, polRouter] = await Promise.all([
        policyHandle.read.commerce(),
        policyHandle.read.router(),
      ]);
      if (sameAddr(polCommerce, cfg.commerceProxy!) && sameAddr(polRouter, cfg.routerProxy!)) {
        policyAction = "up-to-date";
      }
    }
  }

  const executorOf = (proxyOwner: `0x${string}` | null): string =>
    proxyOwner === null || sameAddr(proxyOwner, deployer)
      ? "direct"
      : `owner ${proxyOwner} — calldata only`;

  console.log(`\n=== APEX v1 deploy ===`);
  console.log(`Network : ${networkName}`);
  console.log(
    `Mode    : ${execute ? "EXECUTE" : "DRY RUN (pass --yes or DEPLOY_YES=1 to execute)"}`,
  );
  console.log(`Deployer: ${deployer}`);
  console.log(`Window  : ${disputeWindow}s`);
  console.log(`Quorum  : ${initialQuorum}`);
  console.log(`Plan    :`);
  console.log(`  paymentToken : ${freshPaymentToken ? "FRESH" : `reuse ${cfg.paymentToken}`}`);
  console.log(
    `  commerce     : ${commerceAction}` +
      (commerceAction === "UPGRADE" ? ` (${executorOf(commerceOwner)})` : ""),
  );
  console.log(
    `  router       : ${routerAction}` +
      (routerAction === "UPGRADE" ? ` (${executorOf(routerOwner)})` : ""),
  );
  console.log(
    `  policy       : ${policyAction}` +
      (policyAction === "FRESH" && !freshRouter ? ` (whitelist: ${executorOf(routerOwner)})` : ""),
  );
  if (freshPaymentToken && (cfg.commerceProxy || cfg.routerProxy)) {
    console.log(
      `\n⚠ paymentToken is blank → full-stack rotation. cfg.commerceProxy ` +
        `and cfg.routerProxy will be ignored; the stack you see below becomes ` +
        `brand new. Old Commerce / Router remain on-chain but leave them out ` +
        `of the registry going forward.`,
    );
  }

  const nothingToDo =
    !freshPaymentToken &&
    commerceAction === "up-to-date" &&
    routerAction === "up-to-date" &&
    policyAction === "up-to-date";
  if (nothingToDo) {
    console.log(`\nEverything is up-to-date — nothing to do.\n`);
    return;
  }
  if (!execute) {
    console.log(`\nDry run — no transactions sent.`);
    console.log(`Re-run with --yes (or DEPLOY_YES=1) to execute the plan above.\n`);
    return;
  }

  // ------------------------------------------------------------------------
  // Execute phase.
  // ------------------------------------------------------------------------

  // 1. paymentToken --------------------------------------------------------
  let paymentToken: `0x${string}`;
  if (freshPaymentToken) {
    console.log(`\n[1/5] paymentToken: deploying ERC20MinimalMock ...`);
    const token = await viem.deployContract("ERC20MinimalMock", [...ERC20_MOCK_CONSTRUCTOR_ARGS]);
    paymentToken = token.address;
    await token.write.mint([deployer, parseUnits("1000000", 18)]);
    console.log(`      addr : ${paymentToken} (minted 1,000,000 APT to deployer)`);
  } else {
    paymentToken = cfg.paymentToken!;
    console.log(`\n[1/5] paymentToken (reused): ${paymentToken}`);
  }

  // 2. treasury ------------------------------------------------------------
  const treasury = cfg.treasury ?? deployer;
  console.log(`\n[2/5] treasury: ${treasury}${cfg.treasury ? "" : " (deployer fallback)"}`);

  // 3. Commerce ------------------------------------------------------------
  let commerce: Awaited<ReturnType<typeof viem.getContractAt<"AgenticCommerceUpgradeable">>>;
  let commerceImplAddr: `0x${string}` | null = null; // non-null → changed this run

  if (freshCommerce) {
    console.log(`\n[3/5] Commerce: deploying fresh impl + proxy ...`);
    const impl = await viem.deployContract("AgenticCommerceUpgradeable", []);
    const initData = commerceInitCalldata(impl.abi, { paymentToken, treasury, owner });
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    commerce = await viem.getContractAt("AgenticCommerceUpgradeable", proxy.address);
    commerceImplAddr = impl.address;
    console.log(`      impl : ${impl.address}`);
    console.log(`      proxy: ${commerce.address}`);
  } else {
    commerce = await viem.getContractAt("AgenticCommerceUpgradeable", cfg.commerceProxy!);
    if (commerceAction === "up-to-date") {
      console.log(`\n[3/5] Commerce: up-to-date — skipped (proxy ${commerce.address})`);
    } else {
      console.log(`\n[3/5] Commerce: reusing proxy ${commerce.address}`);
      const impl = await viem.deployContract("AgenticCommerceUpgradeable", []);
      commerceImplAddr = impl.address;
      console.log(`      new impl : ${impl.address}`);
      const data = encodeFunctionData({
        abi: commerce.abi,
        functionName: "upgradeToAndCall",
        args: [impl.address, "0x"],
      });
      if (sameAddr(commerceOwner!, deployer)) {
        const txHash = await commerce.write.upgradeToAndCall([impl.address, "0x"]);
        console.log(`      upgradeToAndCall tx: ${txHash}`);
      } else {
        pendingOwnerTxs.push({
          label: `commerce.upgradeToAndCall(${impl.address}, "0x")`,
          to: commerce.address,
          data,
        });
        console.log(`      upgradeToAndCall queued for owner ${commerceOwner} (see below)`);
      }
    }
  }

  // 4. Router --------------------------------------------------------------
  let router: Awaited<ReturnType<typeof viem.getContractAt<"EvaluatorRouterUpgradeable">>>;
  let routerImplAddr: `0x${string}` | null = null;

  if (freshRouter) {
    console.log(`\n[4/5] Router: deploying fresh impl + proxy ...`);
    const impl = await viem.deployContract("EvaluatorRouterUpgradeable", []);
    const initData = routerInitCalldata(impl.abi, { commerce: commerce.address, owner });
    const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
    router = await viem.getContractAt("EvaluatorRouterUpgradeable", proxy.address);
    routerImplAddr = impl.address;
    console.log(`      impl : ${impl.address}`);
    console.log(`      proxy: ${router.address}`);
  } else {
    router = await viem.getContractAt("EvaluatorRouterUpgradeable", cfg.routerProxy!);
    if (routerAction === "up-to-date") {
      console.log(`\n[4/5] Router: up-to-date — skipped (proxy ${router.address})`);
    } else {
      console.log(`\n[4/5] Router: reusing proxy ${router.address}`);
      const impl = await viem.deployContract("EvaluatorRouterUpgradeable", []);
      routerImplAddr = impl.address;
      console.log(`      new impl : ${impl.address}`);
      const data = encodeFunctionData({
        abi: router.abi,
        functionName: "upgradeToAndCall",
        args: [impl.address, "0x"],
      });
      if (sameAddr(routerOwner!, deployer)) {
        const txHash = await router.write.upgradeToAndCall([impl.address, "0x"]);
        console.log(`      upgradeToAndCall tx: ${txHash}`);
      } else {
        pendingOwnerTxs.push({
          label: `router.upgradeToAndCall(${impl.address}, "0x")`,
          to: router.address,
          data,
        });
        console.log(`      upgradeToAndCall queued for owner ${routerOwner} (see below)`);
      }
    }
  }

  // 5. OptimisticPolicy + whitelist -----------------------------------------
  let policyAddr: `0x${string}` | null = null;
  if (policyAction === "up-to-date") {
    console.log(`\n[5/5] Policy: up-to-date — skipped (${cfg.policy})`);
  } else {
    console.log(`\n[5/5] Policy: deploying fresh OptimisticPolicy + whitelisting ...`);
    const policy = await viem.deployContract("OptimisticPolicy", [
      commerce.address,
      router.address,
      owner,
      disputeWindow,
      initialQuorum,
    ]);
    policyAddr = policy.address;
    console.log(`      addr : ${policy.address}`);
    if (routerOwner === null || sameAddr(routerOwner, deployer)) {
      await router.write.setPolicyWhitelist([policy.address, true]);
      console.log(`      whitelisted on router ${router.address}`);
    } else {
      pendingOwnerTxs.push({
        label: `router.setPolicyWhitelist(${policy.address}, true)`,
        to: router.address,
        data: encodeFunctionData({
          abi: router.abi,
          functionName: "setPolicyWhitelist",
          args: [policy.address, true],
        }),
      });
      console.log(`      whitelist queued for owner ${routerOwner} (see below)`);
    }
  }

  // ----------------------------------------------------------------------
  // Output
  // ----------------------------------------------------------------------
  console.log(`\n=== DONE ===\n`);

  console.log(`Paste the following into ADDRESSES["${networkName}"] in scripts/addresses.ts`);
  console.log(`(only the fields that changed this run are listed):\n`);
  if (freshPaymentToken) console.log(`    paymentToken:  "${paymentToken}",`);
  if (freshCommerce) console.log(`    commerceProxy: "${commerce.address}",`);
  if (commerceImplAddr) console.log(`    commerceImpl:  "${commerceImplAddr}",`);
  if (freshRouter) console.log(`    routerProxy:   "${router.address}",`);
  if (routerImplAddr) console.log(`    routerImpl:    "${routerImplAddr}",`);
  if (policyAddr) console.log(`    policy:        "${policyAddr}",`);
  console.log(``);

  if (pendingOwnerTxs.length > 0) {
    console.log(`⚠ ${pendingOwnerTxs.length} owner-gated transaction(s) were NOT sent — the`);
    console.log(`  signer is not the owner. Execute them from the owner (e.g. Safe{Wallet}`);
    console.log(`  → New transaction → Transaction Builder, or "custom data"):\n`);
    pendingOwnerTxs.forEach((tx, i) => {
      console.log(`  ${i + 1}. ${tx.label}`);
      console.log(`     to   : ${tx.to}`);
      console.log(`     value: 0`);
      console.log(`     data : ${tx.data}`);
      console.log(``);
    });
    console.log(`  Until these execute, the impl/policy addresses above are deployed but`);
    console.log(`  NOT live behind the proxies.`);
    console.log(``);
  }

  // Warnings for superseded on-chain state.
  if (freshPaymentToken && cfg.paymentToken) {
    console.log(`⚠ Old paymentToken (${cfg.paymentToken}) is deprecated.`);
  }
  if (freshCommerce && cfg.commerceProxy) {
    console.log(`⚠ Old Commerce (${cfg.commerceProxy}) still holds any in-flight escrow.`);
    console.log(`  Clients must call oldCommerce.claimRefund(jobId) after expiredAt.`);
    console.log(`  Consider oldCommerce.pause() via the old owner to block new jobs.`);
  }
  if (freshRouter && cfg.routerProxy) {
    console.log(`⚠ Old Router (${cfg.routerProxy}) is now orphaned but still on-chain.`);
    console.log(
      `  Any jobs created against it continue to route through it until settled/expired.`,
    );
  }
  if (policyAddr && !freshRouter && cfg.policy) {
    console.log(`⚠ Old policy (${cfg.policy}) is still whitelisted on the router.`);
    console.log(`  Revoke via the current router owner:`);
    console.log(`    router.setPolicyWhitelist(${cfg.policy}, false)`);
  }
  if (freshPaymentToken || freshCommerce || freshRouter || (policyAddr && cfg.policy)) {
    console.log(``);
  }

  // Ownership handoff reminder.
  const freshProxyDeployed = freshCommerce || freshRouter;
  if (freshProxyDeployed) {
    console.log(`Post-deploy ownership handoff (required; ownership is on deployer):`);
    if (freshCommerce)
      console.log(`  commerce.transferOwnership(multisig)  → multisig.acceptOwnership()`);
    if (freshRouter)
      console.log(`  router.transferOwnership(multisig)    → multisig.acceptOwnership()`);
    console.log(`  policy.transferAdmin(multisig)        → multisig.acceptAdmin()`);
    console.log(``);
  } else if (policyAddr) {
    console.log(`Transfer admin of the fresh policy when ready:`);
    console.log(`  policy.transferAdmin(multisig)        → multisig.acceptAdmin()`);
    console.log(``);
  }

  if (freshPaymentToken) {
    console.log(`Fund a test recipient (pass env inline, do NOT edit .env):`);
    console.log(
      `  FUND_RECIPIENT=0xYourAddr FUND_TOKEN_ADDRESS=${paymentToken} bun run fund:local`,
    );
    console.log(``);
  }

  const verifyScript =
    networkName === "bscTestnet"
      ? "verify:testnet"
      : networkName === "bscTestnetQa"
        ? "verify:testnet-qa"
        : networkName === "bsc"
          ? "verify:mainnet"
          : null;
  if (verifyScript) {
    console.log(`Next step (after pasting the block above back into addresses.ts):`);
    console.log(`  bun run ${verifyScript}`);
    console.log(``);
    console.log(`If contract source changed this run, also refresh abis/:`);
    console.log(`  bun run abis   (and commit the abis/ diff)`);
    console.log(``);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
