/**
 * deploy-all.ts
 *
 * Deploys AgenticCommerce + APEXEvaluator in one pass, then writes the
 * addresses into:
 *   - deployments/<network>-test.json
 *   - ../bnbagent-sdk/examples/{getting-started,agent-server,client-workflow}/.env
 *
 * Strategy:
 *   - Implementation contracts: deployed via CREATE2 (deterministic address)
 *   - Proxy contracts: deployed DIRECTLY from deployer EOA so that msg.sender
 *     in initialize() is the deployer (and the deployer gets admin roles).
 *
 * Usage:
 *   DOTENV_CONFIG_PATH=.env.test npx hardhat run scripts/deploy-all.ts --network bscTestnet
 */

import hre from "hardhat";
import {
  encodeAbiParameters,
  encodeFunctionData,
  Hex,
  keccak256,
  getCreate2Address,
} from "viem";
// dotenv is loaded in hardhat.config.ts with DOTENV_CONFIG_PATH support
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Constants ───────────────────────────────────────────────────────────────

const SAFE_SINGLETON_FACTORY = "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7" as const;

const PAYMENT_TOKEN_ADDRESS = (
  process.env.PAYMENT_TOKEN_ADDRESS || "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565"
) as `0x${string}`;

const OOV3_ADDRESS = (
  process.env.OOV3_ADDRESS || "0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709"
) as `0x${string}`;

const TRUSTED_FORWARDER = "0x0000000000000000000000000000000000000001" as `0x${string}`;

const LIVENESS_SECONDS = BigInt(process.env.EVALUATOR_LIVENESS || "1800");
const SKIP_BOND_DEPOSIT = process.env.SKIP_BOND_DEPOSIT === "true";

// CREATE2 salts — impls only (same as deploy-commerce.ts / deploy-evaluator.ts)
const APEX_IMPL_SALT = "0x0000000000000000000000000000000000000000000000000000000000008202" as Hex;
const EVAL_IMPL_SALT = "0x0000000000000000000000000000000000000000000000000000000000008300" as Hex;

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function buildProxyBytecode(implAddress: string, initCalldata: Hex): Promise<Hex> {
  const proxyArtifact = await hre.artifacts.readArtifact("ERC1967Proxy");
  const args = encodeAbiParameters(
    [{ name: "implementation", type: "address" }, { name: "data", type: "bytes" }],
    [implAddress as `0x${string}`, initCalldata],
  );
  return (proxyArtifact.bytecode + args.slice(2)) as Hex;
}

/** Deploy implementation via CREATE2 factory (deterministic, idempotent). */
async function deployViaCreate2(
  deployer: any,
  publicClient: any,
  label: string,
  salt: Hex,
  bytecode: Hex,
): Promise<`0x${string}`> {
  const addr = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt,
    bytecodeHash: keccak256(bytecode),
  });

  const existing = await publicClient.getBytecode({ address: addr });
  if (existing) {
    console.log(`  ${label}: already deployed at ${addr} (skip)`);
    return addr;
  }

  console.log(`  ${label}: deploying...`);
  const txHash = await deployer.sendTransaction({
    to: SAFE_SINGLETON_FACTORY,
    data: (salt + bytecode.slice(2)) as Hex,
  });
  await publicClient.waitForTransactionReceipt({ hash: txHash });
  console.log(`  ${label}: deployed at ${addr} (tx ${txHash})`);
  return addr;
}

/**
 * Deploy proxy DIRECTLY from deployer EOA (not via CREATE2 factory).
 * This ensures msg.sender in initialize() is the deployer, so deployer gets admin roles.
 * Uses the deployment JSON to track addresses for idempotency.
 */
async function deployDirect(
  deployer: any,
  publicClient: any,
  label: string,
  bytecode: Hex,
  existingAddr?: string,
): Promise<`0x${string}`> {
  // Reuse existing deployment if it still has code
  if (existingAddr) {
    const code = await publicClient.getBytecode({ address: existingAddr as `0x${string}` });
    if (code) {
      console.log(`  ${label}: already deployed at ${existingAddr} (skip)`);
      return existingAddr as `0x${string}`;
    }
  }

  console.log(`  ${label}: deploying directly from deployer...`);
  const txHash = await deployer.sendTransaction({
    data: bytecode,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  const addr = receipt.contractAddress;
  if (!addr) throw new Error(`${label}: no contractAddress in receipt`);
  console.log(`  ${label}: deployed at ${addr} (tx ${txHash})`);
  return addr;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log("=".repeat(70));
  console.log("APEX deploy-all (commerce + evaluator)");
  console.log("=".repeat(70));
  console.log("Network:          ", connection.networkName);
  console.log("Deployer:         ", deployer.account.address);
  console.log("Payment token:    ", PAYMENT_TOKEN_ADDRESS);
  console.log("OOv3:             ", OOV3_ADDRESS);
  console.log("Liveness:         ", LIVENESS_SECONDS.toString(), "s");
  console.log("Trusted forwarder: ", TRUSTED_FORWARDER);
  console.log("Skip bond deposit:", SKIP_BOND_DEPOSIT);
  console.log("");

  // Verify CREATE2 factory
  if (!(await publicClient.getBytecode({ address: SAFE_SINGLETON_FACTORY }))) {
    throw new Error(`CREATE2 factory not found at ${SAFE_SINGLETON_FACTORY}`);
  }

  // Load existing deployment for proxy address reuse
  const networkName = connection.networkName;
  const deploymentPath = path.join(__dirname, "..", "deployments", `${networkName}-test.json`);
  let existing: any = {};
  if (fs.existsSync(deploymentPath)) {
    try { existing = JSON.parse(fs.readFileSync(deploymentPath, "utf-8")); } catch {}
  }

  // ── 1. AgenticCommerce ───────────────────────────────────────────────────
  console.log("── 1. AgenticCommerce ──────────────────────────────────────────");
  const commerceArtifact = await hre.artifacts.readArtifact("AgenticCommerceUpgradeable");
  const commerceConstructorArgs = encodeAbiParameters(
    [{ name: "trustedForwarder_", type: "address" }],
    [TRUSTED_FORWARDER],
  );
  const commerceImplBytecode = (commerceArtifact.bytecode + commerceConstructorArgs.slice(2)) as Hex;

  const commerceImplAddr = await deployViaCreate2(
    deployer, publicClient,
    "Commerce impl",
    APEX_IMPL_SALT,
    commerceImplBytecode,
  );

  const commerceInitData = encodeFunctionData({
    abi: commerceArtifact.abi,
    functionName: "initialize",
    args: [PAYMENT_TOKEN_ADDRESS, deployer.account.address, deployer.account.address],
  });
  const commerceProxyBytecode = await buildProxyBytecode(commerceImplAddr, commerceInitData);

  const commerceProxyAddr = await deployDirect(
    deployer, publicClient,
    "Commerce proxy",
    commerceProxyBytecode,
    existing?.contracts?.AgenticCommerce?.proxy,
  );

  // ── 2. APEXEvaluator ────────────────────────────────────────────────────
  console.log("");
  console.log("── 2. APEXEvaluator ────────────────────────────────────────────");
  const evalArtifact = await hre.artifacts.readArtifact("APEXEvaluatorUpgradeable");
  const evalImplBytecode = evalArtifact.bytecode as Hex;

  const evalImplAddr = await deployViaCreate2(
    deployer, publicClient,
    "Evaluator impl",
    EVAL_IMPL_SALT,
    evalImplBytecode,
  );

  const evalInitData = encodeFunctionData({
    abi: evalArtifact.abi,
    functionName: "initialize",
    args: [deployer.account.address, commerceProxyAddr, OOV3_ADDRESS, PAYMENT_TOKEN_ADDRESS, LIVENESS_SECONDS],
  });
  const evalProxyBytecode = await buildProxyBytecode(evalImplAddr, evalInitData);

  const evalProxyAddr = await deployDirect(
    deployer, publicClient,
    "Evaluator proxy",
    evalProxyBytecode,
    existing?.contracts?.APEXEvaluator?.proxy,
  );

  // ── 3. Verify ────────────────────────────────────────────────────────────
  console.log("");
  console.log("── 3. Verify ───────────────────────────────────────────────────");

  const VERIFY_ABI = [
    { name: "erc8183",      type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "oov3",         type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "bondToken",    type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "liveness",     type: "function", inputs: [], outputs: [{ type: "uint64"  }], stateMutability: "view" },
    { name: "owner",        type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
    { name: "paymentToken", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  ] as const;

  const [erc8183, oov3, bondToken, liveness, evalOwner] = await Promise.all([
    publicClient.readContract({ address: evalProxyAddr, abi: VERIFY_ABI, functionName: "erc8183" }),
    publicClient.readContract({ address: evalProxyAddr, abi: VERIFY_ABI, functionName: "oov3" }),
    publicClient.readContract({ address: evalProxyAddr, abi: VERIFY_ABI, functionName: "bondToken" }),
    publicClient.readContract({ address: evalProxyAddr, abi: VERIFY_ABI, functionName: "liveness" }),
    publicClient.readContract({ address: evalProxyAddr, abi: VERIFY_ABI, functionName: "owner" }),
  ]);

  console.log("  Evaluator.erc8183:  ", erc8183);
  console.log("  Evaluator.oov3:     ", oov3);
  console.log("  Evaluator.bondToken:", bondToken);
  console.log("  Evaluator.liveness: ", liveness.toString(), "s");
  console.log("  Evaluator.owner:    ", evalOwner);

  // ── 3b. Whitelist evaluator as hook on commerce ──────────────────────────
  console.log("");
  console.log("── 3b. Whitelist evaluator as hook ─────────────────────────────");

  const WHITELIST_ABI = [
    { name: "whitelistedHooks", type: "function", inputs: [{ name: "hook", type: "address" }], outputs: [{ type: "bool" }], stateMutability: "view" },
    { name: "setHookWhitelist",  type: "function", inputs: [{ name: "hook", type: "address" }, { name: "status", type: "bool" }], outputs: [], stateMutability: "nonpayable" },
  ] as const;

  const alreadyWhitelisted = await publicClient.readContract({
    address: commerceProxyAddr,
    abi: WHITELIST_ABI,
    functionName: "whitelistedHooks",
    args: [evalProxyAddr],
  });

  if (alreadyWhitelisted) {
    console.log("  Evaluator hook: already whitelisted (skip)");
  } else {
    console.log("  Whitelisting evaluator as hook...");
    const whitelistTx = await deployer.writeContract({
      address: commerceProxyAddr,
      abi: WHITELIST_ABI,
      functionName: "setHookWhitelist",
      args: [evalProxyAddr, true],
    });
    await publicClient.waitForTransactionReceipt({ hash: whitelistTx });
    console.log("  Evaluator whitelisted (tx", whitelistTx, ")");
  }

  // ── 4. Write deployment JSON ─────────────────────────────────────────────
  const deploymentData = {
    network: networkName,
    chainId: 97,
    contracts: {
      AgenticCommerce: {
        proxy: commerceProxyAddr,
        implementation: commerceImplAddr,
      },
      APEXEvaluator: {
        proxy: evalProxyAddr,
        implementation: evalImplAddr,
      },
    },
    externalContracts: {
      paymentToken: PAYMENT_TOKEN_ADDRESS,
      umaOOv3: OOV3_ADDRESS,
    },
  };

  fs.mkdirSync(path.dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentData, null, 2) + "\n");
  console.log("");
  console.log(`  Deployment saved → ${deploymentPath}`);

  // ── 5. Update .env.test with deployed addresses ──────────────────────────
  const envTestPath = path.join(__dirname, "..", ".env.test");
  if (fs.existsSync(envTestPath)) {
    let envContent = fs.readFileSync(envTestPath, "utf-8");
    envContent = setEnvVar(envContent, "ERC8183_ADDRESS", commerceProxyAddr);
    envContent = setEnvVar(envContent, "ACP_IMPL_ADDRESS", commerceImplAddr);
    envContent = setEnvVar(envContent, "APEX_EVALUATOR_ADDRESS", evalProxyAddr);
    envContent = setEnvVar(envContent, "OOV3_EVALUATOR_IMPL_ADDRESS", evalImplAddr);
    fs.writeFileSync(envTestPath, envContent);
    console.log("  .env.test updated with deployed addresses");
  }

  // ── 6. Update SDK example .env files ────────────────────────────────────
  const sdkExamplesBase = path.join(__dirname, "..", "..", "bnbagent-sdk", "examples");
  const exampleDirs = ["getting-started", "agent-server", "client-workflow"];

  for (const dir of exampleDirs) {
    const envExamplePath = path.join(sdkExamplesBase, dir, ".env.example");
    const envPath = path.join(sdkExamplesBase, dir, ".env");

    if (!fs.existsSync(sdkExamplesBase)) {
      console.log(`  WARN: SDK examples dir not found at ${sdkExamplesBase}, skipping`);
      break;
    }

    let envContent: string;
    if (fs.existsSync(envPath)) {
      envContent = fs.readFileSync(envPath, "utf-8");
    } else if (fs.existsSync(envExamplePath)) {
      envContent = fs.readFileSync(envExamplePath, "utf-8");
    } else {
      console.log(`  WARN: no .env or .env.example in ${dir}, skipping`);
      continue;
    }

    envContent = setEnvVar(envContent, "ERC8183_ADDRESS", commerceProxyAddr);
    envContent = setEnvVar(envContent, "APEX_EVALUATOR_ADDRESS", evalProxyAddr);
    envContent = setEnvVar(envContent, "PAYMENT_TOKEN_ADDRESS", PAYMENT_TOKEN_ADDRESS);
    fs.writeFileSync(envPath, envContent);
    console.log(`  ${dir}/.env updated`);
  }

  // ── 7. Summary ───────────────────────────────────────────────────────────
  console.log("");
  console.log("=".repeat(70));
  console.log("Deployment complete!");
  console.log("=".repeat(70));
  console.log(`ERC8183_ADDRESS=${commerceProxyAddr}`);
  console.log(`APEX_EVALUATOR_ADDRESS=${evalProxyAddr}`);
  console.log(`PAYMENT_TOKEN_ADDRESS=${PAYMENT_TOKEN_ADDRESS}`);
}

/**
 * Set (or add) a KEY=VALUE line in an env file string.
 * Handles both commented-out (# KEY=...) and uncommented (KEY=...) lines.
 */
function setEnvVar(content: string, key: string, value: string): string {
  const commented = new RegExp(`^#\\s*${key}=.*$`, "m");
  const uncommented = new RegExp(`^${key}=.*$`, "m");

  if (uncommented.test(content)) {
    return content.replace(uncommented, `${key}=${value}`);
  } else if (commented.test(content)) {
    return content.replace(commented, `${key}=${value}`);
  } else {
    return content.trimEnd() + `\n${key}=${value}\n`;
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
