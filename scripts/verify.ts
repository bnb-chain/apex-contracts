import hre, { network } from "hardhat";
import { verifyContract, type VerifyContractArgs } from "@nomicfoundation/hardhat-verify/verify";
import { getAddress } from "viem";

import { ADDRESSES, type DeployedAddresses } from "./addresses.js";
import {
  ERC20_MOCK_CONSTRUCTOR_ARGS,
  commerceInitCalldata,
  policyConstructorArgs,
  routerInitCalldata,
} from "./lib/apex-init.js";

/**
 * Idempotent Etherscan-v2 verification for the full APEX stack.
 *
 *   bun run verify:testnet
 *
 * Reads every address from `scripts/addresses.ts` and every deploy-time
 * parameter from the same env vars `deploy.ts` consumed, so the Etherscan
 * submission is bit-identical to the original deploy transaction.
 *
 * Defaults (match `deploy.ts`):
 *   - Commerce / Router `initialize.owner_`  = deployer wallet
 *   - Policy constructor `admin_`            = deployer wallet
 *   - Policy `disputeWindow_`  = $DISPUTE_WINDOW_SECONDS (fallback 86400)
 *   - Policy `initialQuorum_`  = $INITIAL_QUORUM         (fallback 2)
 *
 * Env overrides (only needed if ownership / admin has been transferred
 * BEFORE you got around to verifying):
 *   - COMMERCE_INITIAL_OWNER  — owner_ passed at Commerce.initialize time
 *   - ROUTER_INITIAL_OWNER    — owner_ passed at Router.initialize time
 *   - POLICY_INITIAL_ADMIN    — admin_ passed at Policy constructor time
 *
 * Individual step failures do NOT abort the run; the script prints a
 * per-step ✓ / ∙ / ✗ and continues. Rerunning is safe — already-verified
 * contracts report as "already verified".
 */

type Logger = (line: string) => void;

function envOpt(key: string): string | undefined {
  const v = process.env[key];
  return v !== undefined && v.length > 0 ? v : undefined;
}

function envWithDefault(key: string, fallback: string): string {
  return envOpt(key) ?? fallback;
}

async function tryVerify(label: string, args: VerifyContractArgs, log: Logger): Promise<void> {
  try {
    const ok = await verifyContract(args, hre);
    log(ok ? `  ✓ ${label}: verified (${args.address})` : `  ∙ ${label}: already verified`);
  } catch (err) {
    const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
    log(`  ✗ ${label}: ${msg}`);
  }
}

function missing(cfg: DeployedAddresses, log: Logger): boolean {
  const required: Array<keyof DeployedAddresses> = [
    "commerceProxy",
    "commerceImpl",
    "routerProxy",
    "routerImpl",
    "policy",
  ];
  const blanks = required.filter((k) => !cfg[k]);
  if (blanks.length === 0) return false;
  log(`\n⚠ ADDRESSES is missing: ${blanks.join(", ")}`);
  log(`  Run \`bun run deploy:<env>\` and paste the printed block into`);
  log(`  scripts/addresses.ts before running verify.\n`);
  return true;
}

async function main(): Promise<void> {
  const { viem, networkName } = await network.connect();
  const [deployerClient] = await viem.getWalletClients();
  const deployer = getAddress(deployerClient.account.address);

  const cfg = ADDRESSES[networkName] ?? {};
  const log: Logger = (line) => console.log(line);

  log(`\n=== APEX v1 verify ===`);
  log(`Network : ${networkName}`);
  log(`Deployer: ${deployer}`);

  if (missing(cfg, log)) {
    process.exit(1);
  }

  const commerceProxy = cfg.commerceProxy!;
  const commerceImpl = cfg.commerceImpl!;
  const routerProxy = cfg.routerProxy!;
  const routerImpl = cfg.routerImpl!;
  const policy = cfg.policy!;
  const treasury = cfg.treasury ?? deployer;
  const paymentToken = cfg.paymentToken;

  const commerceInitialOwner = (envOpt("COMMERCE_INITIAL_OWNER") ?? deployer) as `0x${string}`;
  const routerInitialOwner = (envOpt("ROUTER_INITIAL_OWNER") ?? deployer) as `0x${string}`;
  const policyInitialAdmin = (envOpt("POLICY_INITIAL_ADMIN") ?? deployer) as `0x${string}`;
  const disputeWindow = BigInt(envWithDefault("DISPUTE_WINDOW_SECONDS", "86400"));
  const initialQuorum = Number(envWithDefault("INITIAL_QUORUM", "2"));

  // We need the ABIs of the impl contracts to recompute the initialize
  // calldata bytes that were baked into each ERC1967Proxy constructor.
  const commerceHandle = await viem.getContractAt("AgenticCommerceUpgradeable", commerceProxy);
  const routerHandle = await viem.getContractAt("EvaluatorRouterUpgradeable", routerProxy);

  log(`\n[1/5] AgenticCommerceUpgradeable (impl)`);
  await tryVerify("commerceImpl", { address: commerceImpl, constructorArgs: [] }, log);

  log(`\n[2/5] EvaluatorRouterUpgradeable (impl)`);
  await tryVerify("routerImpl", { address: routerImpl, constructorArgs: [] }, log);

  log(`\n[3/5] ERC1967Proxy → Commerce`);
  if (!paymentToken) {
    log(`  ∙ paymentToken blank in addresses.ts — cannot reproduce initialize`);
    log(`    calldata. Fill paymentToken and rerun.`);
  } else {
    const commerceInit = commerceInitCalldata(commerceHandle.abi, {
      paymentToken,
      treasury,
      owner: commerceInitialOwner,
    });
    await tryVerify(
      "commerceProxy",
      {
        address: commerceProxy,
        contract: "contracts/ERC1967Proxy.sol:ERC1967Proxy",
        constructorArgs: [commerceImpl, commerceInit],
      },
      log,
    );
  }

  log(`\n[4/5] ERC1967Proxy → Router`);
  const routerInit = routerInitCalldata(routerHandle.abi, {
    commerce: commerceProxy,
    owner: routerInitialOwner,
  });
  await tryVerify(
    "routerProxy",
    {
      address: routerProxy,
      contract: "contracts/ERC1967Proxy.sol:ERC1967Proxy",
      constructorArgs: [routerImpl, routerInit],
    },
    log,
  );

  log(`\n[5/5] OptimisticPolicy`);
  await tryVerify(
    "policy",
    {
      address: policy,
      constructorArgs: [
        ...policyConstructorArgs({
          commerce: commerceProxy,
          router: routerProxy,
          admin: policyInitialAdmin,
          disputeWindow,
          initialQuorum,
        }),
      ],
    },
    log,
  );

  // Optional: verify self-deployed ERC20MinimalMock if the paymentToken
  // looks like one of ours. External tokens (USDC etc.) are already
  // verified upstream — skip them silently.
  if (paymentToken) {
    log(`\n[bonus] paymentToken`);
    try {
      const token = await viem.getContractAt("ERC20MinimalMock", paymentToken);
      const [name, symbol, decimals] = await Promise.all([
        token.read.name(),
        token.read.symbol(),
        token.read.decimals(),
      ]);
      const [mockName, mockSymbol, mockDecimals] = ERC20_MOCK_CONSTRUCTOR_ARGS;
      if (name === mockName && symbol === mockSymbol && decimals === mockDecimals) {
        await tryVerify(
          "paymentToken (ERC20MinimalMock)",
          {
            address: paymentToken,
            contract: "contracts/mocks/ERC20MinimalMock.sol:ERC20MinimalMock",
            constructorArgs: [...ERC20_MOCK_CONSTRUCTOR_ARGS],
          },
          log,
        );
      } else {
        log(`  ∙ paymentToken (${name}/${symbol}): external token, skipped`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.split("\n")[0] : String(err);
      log(`  ∙ paymentToken: not inspectable as ERC-20 (${msg}); skipped`);
    }
  }

  log(`\n=== DONE ===\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
