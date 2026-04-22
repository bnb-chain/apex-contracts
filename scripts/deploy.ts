import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseUnits } from "viem";
import { ADDRESSES, getDeployInputs } from "./addresses.js";

/**
 * Deploy the v1 stack in one shot.
 *
 *   1. MockERC20                   (local networks only)
 *   2. AgenticCommerceUpgradeable  (impl + ERC1967Proxy + initialize)
 *   3. EvaluatorRouterUpgradeable  (impl + ERC1967Proxy + initialize)
 *   4. OptimisticPolicy            (constructor)
 *   5. router.setPolicyWhitelist(policy, true)
 *
 * Input resolution:
 *   - owner    : always the deployer signer. Transfer to a multisig
 *                post-deploy via `transferOwnership` / `transferAdmin`.
 *   - paymentToken + treasury:
 *       live networks  — read from ADDRESSES[network] in scripts/addresses.ts
 *       local networks — MockERC20 auto-deployed; treasury = deployer
 *
 * Re-run behaviour on live networks:
 *   - If both `commerceProxy` and `routerProxy` are already set in
 *     ADDRESSES[network], steps 2 + 3 are SKIPPED: the existing proxies
 *     are reused and we only deploy + whitelist a fresh OptimisticPolicy.
 *     The router owner must still be the deployer for the whitelist call
 *     to succeed; if ownership has been transferred to a multisig, run
 *     `setPolicyWhitelist` from the multisig instead.
 *   - If exactly one of the two proxy fields is set, the entry is
 *     inconsistent and the script errors out. Fix the registry first.
 *   - If neither is set, the full stack is deployed.
 */

const LIVE_NETWORKS = new Set(["bsc", "bscTestnet"]);

function env(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v !== undefined && v.length > 0) return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing env var: ${key}`);
}

async function main() {
  const { viem, networkName } = await network.connect();
  const [deployerClient] = await viem.getWalletClients();
  const deployer = getAddress(deployerClient.account.address);
  const isLive = LIVE_NETWORKS.has(networkName);

  // Reuse semantics: both proxies set → skip steps 2/3; both unset → full
  // deploy; otherwise the registry is inconsistent and we bail so the
  // operator doesn't accidentally pair a fresh proxy with a pre-existing
  // sibling that it can't talk to.
  const existing = ADDRESSES[networkName];
  const hasCommerce = !!existing?.commerceProxy;
  const hasRouter = !!existing?.routerProxy;
  if (hasCommerce !== hasRouter) {
    throw new Error(
      `Inconsistent ADDRESSES["${networkName}"]: commerceProxy and routerProxy ` +
        `must both be set or both unset. Fix the entry before redeploying.`,
    );
  }
  const reuseStack = hasCommerce && hasRouter;

  const owner = deployer;
  const disputeWindow = BigInt(env("DISPUTE_WINDOW_SECONDS", "86400"));
  const initialQuorum = Number(env("INITIAL_QUORUM", "2"));

  console.log(`\n=== APEX v1 deploy ===`);
  console.log(`Network : ${networkName}`);
  console.log(`Deployer: ${deployer}`);
  console.log(`Owner   : ${owner} (deployer — transfer to multisig after deploy)`);
  console.log(`Window  : ${disputeWindow}s`);
  console.log(`Quorum  : ${initialQuorum}`);

  // 1. Payment token + treasury
  let paymentToken: `0x${string}`;
  let treasury: `0x${string}`;
  if (isLive) {
    const inputs = getDeployInputs(networkName);
    paymentToken = inputs.paymentToken;
    treasury = inputs.treasury;
    console.log(`\n[1/5] Using configured paymentToken : ${paymentToken}`);
    console.log(`                 configured treasury : ${treasury}`);
  } else {
    console.log(`\n[1/5] Deploying MockERC20 (local network) ...`);
    const token = await viem.deployContract("MockERC20", ["Apex Test Token", "APT", 18]);
    paymentToken = token.address;
    treasury = deployer;
    await token.write.mint([deployer, parseUnits("1000000", 18)]);
    console.log(`      token    : ${paymentToken}`);
    console.log(`      treasury : ${treasury} (deployer)`);
  }

  // 2. Commerce
  let commerce: Awaited<ReturnType<typeof viem.getContractAt<"AgenticCommerceUpgradeable">>>;
  let commerceImplAddr: `0x${string}` | null = null;
  if (reuseStack) {
    const proxyAddr = existing!.commerceProxy!;
    commerce = await viem.getContractAt("AgenticCommerceUpgradeable", proxyAddr);
    console.log(`\n[2/5] Reusing commerceProxy: ${proxyAddr}`);
  } else {
    console.log(`\n[2/5] Deploying AgenticCommerceUpgradeable ...`);
    const commerceImpl = await viem.deployContract("AgenticCommerceUpgradeable", []);
    const commerceInit = encodeFunctionData({
      abi: commerceImpl.abi,
      functionName: "initialize",
      args: [paymentToken, treasury, owner],
    });
    const commerceProxy = await viem.deployContract("ERC1967Proxy", [
      commerceImpl.address,
      commerceInit,
    ]);
    commerce = await viem.getContractAt("AgenticCommerceUpgradeable", commerceProxy.address);
    commerceImplAddr = commerceImpl.address;
    console.log(`      impl : ${commerceImpl.address}`);
    console.log(`      proxy: ${commerce.address}`);
  }

  // 3. Router
  let router: Awaited<ReturnType<typeof viem.getContractAt<"EvaluatorRouterUpgradeable">>>;
  let routerImplAddr: `0x${string}` | null = null;
  if (reuseStack) {
    const proxyAddr = existing!.routerProxy!;
    router = await viem.getContractAt("EvaluatorRouterUpgradeable", proxyAddr);
    console.log(`\n[3/5] Reusing routerProxy: ${proxyAddr}`);
  } else {
    console.log(`\n[3/5] Deploying EvaluatorRouterUpgradeable ...`);
    const routerImpl = await viem.deployContract("EvaluatorRouterUpgradeable", []);
    const routerInit = encodeFunctionData({
      abi: routerImpl.abi,
      functionName: "initialize",
      args: [commerce.address, owner],
    });
    const routerProxy = await viem.deployContract("ERC1967Proxy", [routerImpl.address, routerInit]);
    router = await viem.getContractAt("EvaluatorRouterUpgradeable", routerProxy.address);
    routerImplAddr = routerImpl.address;
    console.log(`      impl : ${routerImpl.address}`);
    console.log(`      proxy: ${router.address}`);
  }

  // 4. OptimisticPolicy
  console.log(`\n[4/5] Deploying OptimisticPolicy ...`);
  const policy = await viem.deployContract("OptimisticPolicy", [
    commerce.address,
    router.address,
    owner,
    disputeWindow,
    initialQuorum,
  ]);
  console.log(`      addr : ${policy.address}`);

  // 5. Whitelist the policy. Owner == deployer, so this always runs.
  console.log(`\n[5/5] Whitelisting policy on router ...`);
  await router.write.setPolicyWhitelist([policy.address, true]);
  console.log(`      whitelisted`);

  console.log(`\n=== DONE ===\n`);
  if (isLive) {
    console.log(`Paste the following under ADDRESSES["${networkName}"] in scripts/addresses.ts:\n`);
    if (!reuseStack) {
      console.log(`    commerceProxy: "${commerce.address}",`);
      console.log(`    routerProxy:   "${router.address}",`);
    }
    console.log(`    policy:        "${policy.address}",\n`);
    if (!reuseStack) {
      console.log(`Post-deploy ownership handoff (required; ownership is on deployer):`);
      console.log(`  commerce.transferOwnership(multisig)  → multisig.acceptOwnership()`);
      console.log(`  router.transferOwnership(multisig)    → multisig.acceptOwnership()`);
      console.log(`  policy.transferAdmin(multisig)        → multisig.acceptAdmin()\n`);
    } else {
      console.log(`Transfer admin of the fresh policy to the multisig when ready:`);
      console.log(`  policy.transferAdmin(multisig)        → multisig.acceptAdmin()\n`);
    }
  } else {
    console.log(`Fund a test recipient (replace 0xYourAddr; pass env inline, do NOT edit .env):\n`);
    console.log(
      `  FUND_RECIPIENT=0xYourAddr FUND_TOKEN_ADDRESS=${paymentToken} bun run fund:local\n`,
    );
  }
  if (commerceImplAddr || routerImplAddr) {
    console.log(`Implementation addresses (for Etherscan verify only, not persisted):`);
    if (commerceImplAddr) console.log(`  commerceImpl: ${commerceImplAddr}`);
    if (routerImplAddr) console.log(`  routerImpl  : ${routerImplAddr}`);
    console.log("");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
