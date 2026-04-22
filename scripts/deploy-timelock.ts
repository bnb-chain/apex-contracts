import hre from "hardhat";
import { zeroAddress } from "viem";

/**
 * Deploy OpenZeppelin TimelockController for mainnet ACP upgrade path.
 *
 *   minDelay  = TIMELOCK_DELAY seconds (default 48h)
 *   proposers = [UPGRADE_SAFE_ADDR]
 *   executors = [address(0)]        — permissionless execution
 *   admin     = address(0)          — renounced at construction, roles are immutable
 *
 * Required env:
 *   UPGRADE_SAFE_ADDR
 *   TIMELOCK_DELAY      — seconds (default 172800 = 48h)
 */
async function main() {
  const upgradeSafe = process.env.UPGRADE_SAFE_ADDR as `0x${string}`;
  const delay = BigInt(process.env.TIMELOCK_DELAY ?? "172800");
  if (!upgradeSafe) throw new Error("UPGRADE_SAFE_ADDR not set");

  const connection = await hre.network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();

  console.log("APEX TimelockController deployment (mainnet UUPS upgrade path)");
  console.log("=".repeat(60));
  console.log("Network:  ", connection.networkName);
  console.log("Deployer: ", deployer.account.address);
  console.log("UpgradeSafe:", upgradeSafe);
  console.log("Delay:    ", delay.toString(), "sec");
  console.log("");

  const timelock = await viem.deployContract("TimelockController", [
    delay,
    [upgradeSafe],
    [zeroAddress],
    zeroAddress, // admin renounced
  ]);

  console.log("Timelock deployed at:", timelock.address);
  console.log("=".repeat(60));
  console.log("Next steps:");
  console.log(" 1. Record timelock address in deployments/bsc-mainnet.json");
  console.log(" 2. Run rotate-admin.ts with DEFAULT_ADMIN_HOLDER =", timelock.address);
  console.log(" 3. Verify Upgrade Safe can schedule + execute a noop role change");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
