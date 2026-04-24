import { network } from "hardhat";
import { getAddress, parseUnits } from "viem";
import { ADDRESSES } from "./addresses.js";
import {
  ERC20_MOCK_CONSTRUCTOR_ARGS,
  commerceInitCalldata,
  routerInitCalldata,
} from "./lib/apex-init.js";

/**
 * Single idempotent deploy / upgrade / rotation script for the v1 stack.
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
 *          - cfg.commerceProxy filled → keep proxy, only deploy new impl +
 *            upgradeToAndCall(newImpl, "0x")
 *          - cfg.commerceProxy blank  → deploy fresh Commerce, AND force the
 *            Router down the fresh path too (see cascade rule below)
 *        Router (`freshRouter = freshCommerce || !cfg.routerProxy`):
 *          - cfg.routerProxy filled and Commerce was reused → keep proxy,
 *            only deploy new impl + upgradeToAndCall
 *          - else → deploy fresh Router pointing at the Commerce above
 *
 * Policy is ALWAYS freshly deployed and whitelisted on the (possibly brand
 * new) Router. cfg.policy is only used to print a "revoke old policy"
 * reminder when the Router was reused.
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
 *   - owner() of both proxies touched MUST equal the deployer signer.
 *     Once ownership has moved to a multisig this script is no longer the
 *     right tool — run upgrades + whitelist changes from the multisig.
 *
 * Side effects:
 *   - Never writes to ADDRESSES / scripts/addresses.ts. At the end it prints
 *     only the fields that changed this run; the operator pastes them back
 *     manually.
 */

type AnyViem = Awaited<ReturnType<typeof network.connect>>["viem"];

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env var: ${key}`);
}

function sameAddr(a: `0x${string}`, b: `0x${string}`): boolean {
  return getAddress(a) === getAddress(b);
}

async function assertOwner(
  label: string,
  proxy: { read: { owner: () => Promise<`0x${string}`> }; address: `0x${string}` },
  expected: `0x${string}`,
): Promise<void> {
  const actual = await proxy.read.owner();
  if (!sameAddr(actual, expected)) {
    throw new Error(
      `${label} owner mismatch: proxy ${proxy.address} is owned by ${actual}, ` +
        `but signer is ${expected}. Ownership has likely been transferred to a ` +
        `multisig — run upgrades / whitelist changes from the multisig instead.`,
    );
  }
}

async function deployAndUpgrade(
  viem: AnyViem,
  contractName: "AgenticCommerceUpgradeable" | "EvaluatorRouterUpgradeable",
  proxy: {
    write: { upgradeToAndCall: (args: [`0x${string}`, `0x${string}`]) => Promise<`0x${string}`> };
  },
): Promise<{ implAddr: `0x${string}`; txHash: `0x${string}` }> {
  const impl = await viem.deployContract(contractName, []);
  const txHash = await proxy.write.upgradeToAndCall([impl.address, "0x"]);
  return { implAddr: impl.address, txHash };
}

async function main(): Promise<void> {
  const { viem, networkName } = await network.connect();
  const [deployerClient] = await viem.getWalletClients();
  const deployer = getAddress(deployerClient.account.address);

  const cfg = ADDRESSES[networkName] ?? {};
  const owner = deployer;
  const disputeWindow = BigInt(env("DISPUTE_WINDOW_SECONDS", "86400"));
  const initialQuorum = Number(env("INITIAL_QUORUM", "2"));

  // Cascade rule: blank paymentToken forces a full-stack rotation. Blank
  // commerceProxy alone also forces a fresh Router so we never end up with
  // a Router pointing at a stale Commerce.
  const freshPaymentToken = !cfg.paymentToken;
  const freshCommerce = freshPaymentToken || !cfg.commerceProxy;
  const freshRouter = freshCommerce || !cfg.routerProxy;

  console.log(`\n=== APEX v1 deploy ===`);
  console.log(`Network : ${networkName}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`Owner   : ${owner} (deployer — transfer to multisig after deploy)`);
  console.log(`Window  : ${disputeWindow}s`);
  console.log(`Quorum  : ${initialQuorum}`);
  console.log(
    `Plan    : paymentToken=${freshPaymentToken ? "FRESH" : "reuse"}, ` +
      `commerce=${freshCommerce ? "FRESH" : "upgrade impl"}, ` +
      `router=${freshRouter ? "FRESH" : "upgrade impl"}, ` +
      `policy=FRESH`,
  );
  if (freshPaymentToken && (cfg.commerceProxy || cfg.routerProxy)) {
    console.log(
      `\n⚠ paymentToken is blank → full-stack rotation. cfg.commerceProxy ` +
        `and cfg.routerProxy will be ignored; the stack you see below becomes ` +
        `brand new. Old Commerce / Router remain on-chain but leave them out ` +
        `of the registry going forward.`,
    );
  }

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
  let commerceImplAddr: `0x${string}`;

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
    const onChainPaymentToken = await commerce.read.paymentToken();
    if (!sameAddr(onChainPaymentToken, paymentToken)) {
      throw new Error(
        `paymentToken mismatch on commerceProxy ${commerce.address}: ` +
          `on-chain ${onChainPaymentToken}, cfg ${paymentToken}. ` +
          `paymentToken is immutable on Commerce. To rotate, clear paymentToken ` +
          `in scripts/addresses.ts (the script will then redeploy the full stack).`,
      );
    }
    await assertOwner("commerce", commerce, deployer);

    console.log(`\n[3/5] Commerce: reusing proxy ${commerce.address}`);
    const up = await deployAndUpgrade(viem, "AgenticCommerceUpgradeable", commerce);
    commerceImplAddr = up.implAddr;
    console.log(`      new impl           : ${commerceImplAddr}`);
    console.log(`      upgradeToAndCall tx: ${up.txHash}`);
  }

  // 4. Router --------------------------------------------------------------
  let router: Awaited<ReturnType<typeof viem.getContractAt<"EvaluatorRouterUpgradeable">>>;
  let routerImplAddr: `0x${string}`;

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
    const onChainCommerce = await router.read.commerce();
    if (!sameAddr(onChainCommerce, commerce.address)) {
      throw new Error(
        `router.commerce() = ${onChainCommerce} but this run uses ` +
          `commerce ${commerce.address}. Fix ADDRESSES["${networkName}"] so ` +
          `commerceProxy matches the router's stored commerce before redeploying.`,
      );
    }
    await assertOwner("router", router, deployer);

    console.log(`\n[4/5] Router: reusing proxy ${router.address}`);
    const up = await deployAndUpgrade(viem, "EvaluatorRouterUpgradeable", router);
    routerImplAddr = up.implAddr;
    console.log(`      new impl           : ${routerImplAddr}`);
    console.log(`      upgradeToAndCall tx: ${up.txHash}`);
  }

  // 5. OptimisticPolicy (always fresh) + whitelist -------------------------
  console.log(`\n[5/5] Policy: deploying fresh OptimisticPolicy + whitelisting ...`);
  const policy = await viem.deployContract("OptimisticPolicy", [
    commerce.address,
    router.address,
    owner,
    disputeWindow,
    initialQuorum,
  ]);
  console.log(`      addr : ${policy.address}`);
  await router.write.setPolicyWhitelist([policy.address, true]);
  console.log(`      whitelisted on router ${router.address}`);

  // ----------------------------------------------------------------------
  // Output
  // ----------------------------------------------------------------------
  console.log(`\n=== DONE ===\n`);

  console.log(`Paste the following into ADDRESSES["${networkName}"] in scripts/addresses.ts`);
  console.log(`(only the fields that changed this run are listed):\n`);
  if (freshPaymentToken) console.log(`    paymentToken:  "${paymentToken}",`);
  if (freshCommerce) console.log(`    commerceProxy: "${commerce.address}",`);
  console.log(`    commerceImpl:  "${commerceImplAddr}",`);
  if (freshRouter) console.log(`    routerProxy:   "${router.address}",`);
  console.log(`    routerImpl:    "${routerImplAddr}",`);
  console.log(`    policy:        "${policy.address}",`);
  console.log(``);

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
  if (!freshRouter && cfg.policy) {
    console.log(`⚠ Old policy (${cfg.policy}) is still whitelisted on the router.`);
    console.log(`  Revoke via the current router owner:`);
    console.log(`    router.setPolicyWhitelist(${cfg.policy}, false)`);
  }
  if (freshPaymentToken || freshCommerce || freshRouter || (!freshRouter && cfg.policy)) {
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
  } else {
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
      : networkName === "bsc"
        ? "verify:mainnet"
        : null;
  if (verifyScript) {
    console.log(`Next step (after pasting the block above back into addresses.ts):`);
    console.log(`  bun run ${verifyScript}`);
    console.log(``);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
