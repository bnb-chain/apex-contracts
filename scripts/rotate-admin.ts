import hre from "hardhat";

/**
 * Rotate admin/role on ACP + Router + Policy from deployer EOA to the configured Safes.
 *
 * BEHAVIOR:
 *   - ACP.grantRole(DEFAULT_ADMIN_ROLE, <UpgradeSafe or TimelockController>)
 *   - ACP.grantRole(ADMIN_ROLE, OpsSafe)
 *   - Router.transferAdmin(OpsSafe)
 *   - Policy.transferAdmin(OpsSafe)
 *
 * This script does NOT revoke the deployer roles — the Safes must do that
 * themselves via a follow-up Safe transaction. Printing the exact calldata at the end.
 *
 * Required env:
 *   ERC8183_ADDRESS
 *   ROUTER_ADDRESS
 *   POLICY_ADDRESS
 *   OPS_SAFE_ADDR
 *   DEFAULT_ADMIN_HOLDER — on mainnet = TimelockController address; on testnet = UpgradeSafe address
 */

const ROLE_ABI = [
  {
    name: "DEFAULT_ADMIN_ROLE",
    type: "function",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    name: "ADMIN_ROLE",
    type: "function",
    inputs: [],
    outputs: [{ type: "bytes32" }],
    stateMutability: "view",
  },
  {
    name: "grantRole",
    type: "function",
    inputs: [
      { name: "role", type: "bytes32" },
      { name: "account", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

async function main() {
  const acpAddr = process.env.ERC8183_ADDRESS as `0x${string}`;
  const routerAddr = process.env.ROUTER_ADDRESS as `0x${string}`;
  const policyAddr = process.env.POLICY_ADDRESS as `0x${string}`;
  const opsSafe = process.env.OPS_SAFE_ADDR as `0x${string}`;
  const defaultAdminHolder = process.env.DEFAULT_ADMIN_HOLDER as `0x${string}`;
  if (!acpAddr || !routerAddr || !policyAddr || !opsSafe || !defaultAdminHolder) {
    throw new Error(
      "Missing env: need ERC8183_ADDRESS, ROUTER_ADDRESS, POLICY_ADDRESS, OPS_SAFE_ADDR, DEFAULT_ADMIN_HOLDER",
    );
  }

  const connection = await hre.network.connect();
  const { viem } = connection;
  const publicClient = await viem.getPublicClient();
  const [deployer] = await viem.getWalletClients();

  console.log("APEX admin rotation");
  console.log("=".repeat(60));
  console.log("Network:                ", connection.networkName);
  console.log("Deployer:               ", deployer.account.address);
  console.log("ACP:                    ", acpAddr);
  console.log("Router:                 ", routerAddr);
  console.log("Policy:                 ", policyAddr);
  console.log("Ops Safe:               ", opsSafe);
  console.log("DEFAULT_ADMIN_HOLDER:   ", defaultAdminHolder);
  console.log("");

  const defaultAdminRole = await publicClient.readContract({
    address: acpAddr,
    abi: ROLE_ABI,
    functionName: "DEFAULT_ADMIN_ROLE",
  });
  const adminRole = await publicClient.readContract({
    address: acpAddr,
    abi: ROLE_ABI,
    functionName: "ADMIN_ROLE",
  });

  console.log("1. Granting DEFAULT_ADMIN_ROLE on ACP to DEFAULT_ADMIN_HOLDER...");
  const tx1 = await deployer.writeContract({
    address: acpAddr,
    abi: ROLE_ABI,
    functionName: "grantRole",
    args: [defaultAdminRole, defaultAdminHolder],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx1 });
  console.log("   tx:", tx1);

  console.log("2. Granting ADMIN_ROLE on ACP to Ops Safe...");
  const tx2 = await deployer.writeContract({
    address: acpAddr,
    abi: ROLE_ABI,
    functionName: "grantRole",
    args: [adminRole, opsSafe],
  });
  await publicClient.waitForTransactionReceipt({ hash: tx2 });
  console.log("   tx:", tx2);

  console.log("3. Transferring Router admin to Ops Safe...");
  const router = await viem.getContractAt("EvaluatorRouter", routerAddr);
  const tx3 = await router.write.transferAdmin([opsSafe]);
  await publicClient.waitForTransactionReceipt({ hash: tx3 });
  console.log("   tx:", tx3);

  console.log("4. Transferring Policy admin to Ops Safe...");
  const policy = await viem.getContractAt("OptimisticPolicy", policyAddr);
  const tx4 = await policy.write.transferAdmin([opsSafe]);
  await publicClient.waitForTransactionReceipt({ hash: tx4 });
  console.log("   tx:", tx4);

  console.log("");
  console.log("=".repeat(60));
  console.log("NEXT — Safes must revoke deployer themselves:");
  console.log(`  From <DEFAULT_ADMIN_HOLDER> (Safe or Timelock):`);
  console.log(`    acp.revokeRole(${defaultAdminRole}, ${deployer.account.address})`);
  console.log(`  From OPS_SAFE_ADDR:`);
  console.log(`    acp.revokeRole(${adminRole}, ${deployer.account.address})`);
  console.log("Router and Policy admin transfer are already applied (single-step).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
