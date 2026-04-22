import hre from "hardhat";

/**
 * Deploy OptimisticPolicy (non-proxy, immutable).
 *
 * Required env:
 *   ERC8183_ADDRESS     — ACP proxy
 *   ROUTER_ADDRESS      — EvaluatorRouter address
 *   POLICY_ADMIN        — initial admin (deployer EOA, later rotated)
 *   DISPUTE_WINDOW      — seconds (e.g. 259200 for 3 days)
 *   VOTE_QUORUM         — uint16 (e.g. 3)
 *   INITIAL_VOTERS      — comma-separated addresses, count >= VOTE_QUORUM
 */
async function main() {
  const acp = process.env.ERC8183_ADDRESS;
  const router = process.env.ROUTER_ADDRESS;
  const admin = process.env.POLICY_ADMIN;
  const windowSec = process.env.DISPUTE_WINDOW;
  const quorum = process.env.VOTE_QUORUM;
  const votersCsv = process.env.INITIAL_VOTERS;

  if (!acp || !router || !admin || !windowSec || !quorum || !votersCsv) {
    throw new Error(
      "Missing env: need ERC8183_ADDRESS, ROUTER_ADDRESS, POLICY_ADMIN, DISPUTE_WINDOW, VOTE_QUORUM, INITIAL_VOTERS",
    );
  }
  const voters = votersCsv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (voters.length < Number(quorum)) {
    throw new Error(`INITIAL_VOTERS count (${voters.length}) < VOTE_QUORUM (${quorum})`);
  }

  const connection = await hre.network.connect();
  const { viem } = connection;
  const [deployer] = await viem.getWalletClients();

  console.log("APEX OptimisticPolicy deployment");
  console.log("=".repeat(60));
  console.log("Network:       ", connection.networkName);
  console.log("Deployer:      ", deployer.account.address);
  console.log("ACP:           ", acp);
  console.log("Router:        ", router);
  console.log("Admin:         ", admin);
  console.log("disputeWindow: ", windowSec, "sec");
  console.log("voteQuorum:    ", quorum);
  console.log("voters:        ", voters);
  console.log("");

  const policy = await viem.deployContract("OptimisticPolicy", [
    acp as `0x${string}`,
    router as `0x${string}`,
    BigInt(windowSec),
    Number(quorum),
    admin as `0x${string}`,
    voters as `0x${string}`[],
  ]);

  console.log("Policy deployed at:", policy.address);
  console.log("=".repeat(60));
  console.log("Next step: router.setPolicyWhitelist(policy, true) from current router admin");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
