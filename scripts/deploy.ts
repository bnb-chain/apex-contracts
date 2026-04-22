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
 * Live deploys print a block to paste under ADDRESSES[network] with the
 * resulting commerceProxy / routerProxy / policy. Re-deploy is blocked once
 * those fields are filled — use `upgrade-*.ts` instead.
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

  // Refuse re-deploy once the network has a complete record. A partial entry
  // (paymentToken + treasury only) is fine — that's the pre-deploy state.
  if (ADDRESSES[networkName]?.commerceProxy) {
    throw new Error(
      `scripts/addresses.ts already has commerceProxy set for "${networkName}". ` +
        `Use \`bun run upgrade:commerce:<env>\` / \`upgrade:router:<env>\` instead, ` +
        `or clear the post-deploy fields if you really intend to redeploy.`,
    );
  }

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
  const commerce = await viem.getContractAt("AgenticCommerceUpgradeable", commerceProxy.address);
  console.log(`      impl : ${commerceImpl.address}`);
  console.log(`      proxy: ${commerce.address}`);

  // 3. Router
  console.log(`\n[3/5] Deploying EvaluatorRouterUpgradeable ...`);
  const routerImpl = await viem.deployContract("EvaluatorRouterUpgradeable", []);
  const routerInit = encodeFunctionData({
    abi: routerImpl.abi,
    functionName: "initialize",
    args: [commerce.address, owner],
  });
  const routerProxy = await viem.deployContract("ERC1967Proxy", [routerImpl.address, routerInit]);
  const router = await viem.getContractAt("EvaluatorRouterUpgradeable", routerProxy.address);
  console.log(`      impl : ${routerImpl.address}`);
  console.log(`      proxy: ${router.address}`);

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
    console.log(`    commerceProxy: "${commerce.address}",`);
    console.log(`    routerProxy:   "${router.address}",`);
    console.log(`    policy:        "${policy.address}",\n`);
    console.log(`Post-deploy ownership handoff (required; ownership is on deployer):`);
    console.log(`  commerce.transferOwnership(multisig)  → multisig.acceptOwnership()`);
    console.log(`  router.transferOwnership(multisig)    → multisig.acceptOwnership()`);
    console.log(`  policy.transferAdmin(multisig)        → multisig.acceptAdmin()\n`);
  } else {
    console.log(`Fund a test recipient (replace 0xYourAddr; pass env inline, do NOT edit .env):\n`);
    console.log(
      `  FUND_RECIPIENT=0xYourAddr FUND_TOKEN_ADDRESS=${paymentToken} bun run fund:local\n`,
    );
  }
  console.log(`Implementation addresses (for Etherscan verify only, not persisted):`);
  console.log(`  commerceImpl: ${commerceImpl.address}`);
  console.log(`  routerImpl  : ${routerImpl.address}\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
