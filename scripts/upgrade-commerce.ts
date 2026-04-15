import hre from "hardhat";
import {
  encodeAbiParameters,
  Hex,
  keccak256,
  getCreate2Address,
} from "viem";
// dotenv is loaded in hardhat.config.ts with DOTENV_CONFIG_PATH support

const SAFE_SINGLETON_FACTORY =
  "0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7" as const;

const TRUSTED_FORWARDER =
  "0x0000000000000000000000000000000000000001" as `0x${string}`;

/** Current APEX proxy address */
const PROXY_ADDRESS =
  (process.env.ERC8183_ADDRESS || "") as `0x${string}`;

/** Fixed salt for implementation deployment (CREATE2).
 *  No need to increment — different bytecode produces different addresses automatically. */
const IMPL_SALT =
  "0x0000000000000000000000000000000000000000000000000000000000008100" as Hex;

const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const ADMIN_ROLE_ABI = [
  {
    name: "DEFAULT_ADMIN_ROLE",
    type: "function",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    name: "hasRole",
    type: "function",
    inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }],
    outputs: [{ type: "bool" }],
    stateMutability: "view",
  },
] as const;

const STATE_ABI = [
  { name: "paymentToken", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
  { name: "jobCounter", type: "function", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { name: "platformTreasury", type: "function", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
] as const;

const UPGRADE_ABI = [
  {
    name: "upgradeToAndCall",
    type: "function",
    inputs: [
      { name: "newImplementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

async function main() {
  if (!PROXY_ADDRESS) throw new Error("ERC8183_ADDRESS not set in env");

  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  const codeAt = async (address: string) =>
    publicClient.getBytecode({ address: address as `0x${string}` });

  console.log("APEX AgenticCommerce Upgrade");
  console.log("=".repeat(70));
  console.log("Network:", connection.networkName);
  console.log("Deployer:", deployer.account.address);
  console.log("");

  // Step 1: Check current state
  console.log("1. Current State:");
  console.log("   Proxy:", PROXY_ADDRESS);

  const currentImplSlot = await publicClient.getStorageAt({
    address: PROXY_ADDRESS,
    slot: IMPL_SLOT as `0x${string}`,
  });
  const currentImpl = "0x" + currentImplSlot?.slice(26);
  console.log("   Current Implementation:", currentImpl);

  const defaultAdminRole = await publicClient.readContract({
    address: PROXY_ADDRESS,
    abi: ADMIN_ROLE_ABI,
    functionName: "DEFAULT_ADMIN_ROLE",
  });
  const isAdmin = await publicClient.readContract({
    address: PROXY_ADDRESS,
    abi: ADMIN_ROLE_ABI,
    functionName: "hasRole",
    args: [defaultAdminRole, deployer.account.address],
  });

  console.log("   Deployer is DEFAULT_ADMIN_ROLE:", isAdmin);
  if (!isAdmin) {
    throw new Error(`Deployer ${deployer.account.address} does not have DEFAULT_ADMIN_ROLE`);
  }

  // Step 2: Deploy new implementation via CREATE2
  console.log("");
  console.log("2. Deploying New Implementation...");

  const implArtifact = await hre.artifacts.readArtifact("AgenticCommerceUpgradeable");
  const constructorArgs = encodeAbiParameters([{ type: "address" }], [TRUSTED_FORWARDER]);
  const implBytecode = (implArtifact.bytecode + constructorArgs.slice(2)) as Hex;

  const newImplAddress = getCreate2Address({
    from: SAFE_SINGLETON_FACTORY,
    salt: IMPL_SALT,
    bytecodeHash: keccak256(implBytecode),
  });

  console.log("   New Implementation:", newImplAddress);

  if (!(await codeAt(newImplAddress))) {
    const txHash = await deployer.sendTransaction({
      to: SAFE_SINGLETON_FACTORY,
      data: (IMPL_SALT + implBytecode.slice(2)) as Hex,
    });
    await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("   Deployed. Tx:", txHash);
  } else {
    console.log("   Already deployed (skip)");
  }

  // Step 3: Upgrade proxy
  console.log("");
  console.log("3. Upgrading Proxy...");

  const upgradeTx = await deployer.writeContract({
    address: PROXY_ADDRESS,
    abi: UPGRADE_ABI,
    functionName: "upgradeToAndCall",
    args: [newImplAddress, "0x"],
  });
  await publicClient.waitForTransactionReceipt({ hash: upgradeTx });
  console.log("   Upgraded. Tx:", upgradeTx);

  // Step 4: Verify upgrade
  console.log("");
  console.log("4. Verifying...");

  const newImplSlot = await publicClient.getStorageAt({
    address: PROXY_ADDRESS,
    slot: IMPL_SLOT as `0x${string}`,
  });
  const actualNewImpl = "0x" + newImplSlot?.slice(26);
  console.log("   Implementation:", actualNewImpl);
  console.log("   Match:", actualNewImpl.toLowerCase() === newImplAddress.toLowerCase() ? "✓ OK" : "✗ FAILED");

  const [paymentToken, jobCounter, treasury] = await Promise.all([
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "paymentToken" }),
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "jobCounter" }),
    publicClient.readContract({ address: PROXY_ADDRESS, abi: STATE_ABI, functionName: "platformTreasury" }),
  ]);

  console.log("   State preserved:");
  console.log("     paymentToken:     ", paymentToken);
  console.log("     platformTreasury: ", treasury);
  console.log("     jobCounter:       ", jobCounter.toString());

  console.log("");
  console.log("=".repeat(70));
  console.log("Upgrade Complete!");
  console.log("Proxy (unchanged):", PROXY_ADDRESS);
  console.log("Old Implementation:", currentImpl);
  console.log("New Implementation:", newImplAddress);
  console.log("=".repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
