import hre from "hardhat";

/**
 * Deploy EvaluatorRouter (non-proxy, immutable).
 *
 * Required env:
 *   ERC8183_ADDRESS   — deployed ACP proxy address
 *   ROUTER_ADMIN      — initial admin address (normally the deployer EOA; will be rotated to Ops Safe)
 */
async function main() {
  const acpAddress = process.env.ERC8183_ADDRESS;
  const adminAddress = process.env.ROUTER_ADMIN;
  if (!acpAddress) throw new Error("ERC8183_ADDRESS not set");
  if (!adminAddress) throw new Error("ROUTER_ADMIN not set");

  const connection = await hre.network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();

  console.log("APEX EvaluatorRouter deployment");
  console.log("=".repeat(60));
  console.log("Network:  ", connection.networkName);
  console.log("Deployer: ", deployer.account.address);
  console.log("ACP:      ", acpAddress);
  console.log("Admin:    ", adminAddress);
  console.log("");

  const router = await viem.deployContract("EvaluatorRouter", [
    acpAddress as `0x${string}`,
    adminAddress as `0x${string}`,
  ]);

  console.log("Router deployed at:", router.address);
  console.log("=".repeat(60));
  console.log("Next steps:");
  console.log(" 1. Record router address in deployments/<network>.json");
  console.log(" 2. Deploy OptimisticPolicy (scripts/deploy-policy.ts)");
  console.log(" 3. Whitelist policy in router (admin call)");
  console.log(" 4. Rotate admin to Ops Safe (scripts/rotate-admin.ts)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
