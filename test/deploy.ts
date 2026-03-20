import { encodeFunctionData } from "viem";
import { MIN_BUDGET } from "./constants.js";

/**
 * Deploy a MockERC20 token
 */
export async function deployMockToken(viem: any) {
  return viem.deployContract("MockERC20", ["Test Token", "TEST", 18]);
}

/**
 * Mint tokens to an address
 */
export async function mintTokens(token: any, to: `0x${string}`, amount: bigint) {
  await token.write.mint([to, amount]);
}

/**
 * Deploy AgenticCommerceUpgradeable behind a UUPS proxy
 * Uses encodeFunctionData with the actual ABI (3-param initialize)
 */
export async function deployAPEXProxy(
  viem: any,
  tokenAddress: `0x${string}`,
  ownerAddress: `0x${string}`,
  minBudget: bigint = MIN_BUDGET
) {
  // Deploy implementation
  const impl = await viem.deployContract("AgenticCommerceUpgradeable");

  // Get the ABI from the deployed contract to encode init data correctly
  const implArtifact = impl.abi;

  // Encode initialize(address owner_, address paymentToken_, uint256 minBudget_)
  const initData = encodeFunctionData({
    abi: implArtifact,
    functionName: "initialize",
    args: [ownerAddress, tokenAddress, minBudget],
  });

  // Deploy proxy with initialization
  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);

  // Return contract instance at proxy address
  return viem.getContractAt("AgenticCommerceUpgradeable", proxy.address);
}

/**
 * Deploy APEXEvaluatorUpgradeable behind a UUPS proxy
 */
export async function deployEvaluatorProxy(
  viem: any,
  ownerAddress: `0x${string}`,
  erc8183Address: `0x${string}`,
  oov3Address: `0x${string}`,
  bondTokenAddress: `0x${string}`,
  liveness: bigint
) {
  const impl = await viem.deployContract("APEXEvaluatorUpgradeable");

  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [ownerAddress, erc8183Address, oov3Address, bondTokenAddress, liveness],
  });

  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);

  return viem.getContractAt("APEXEvaluatorUpgradeable", proxy.address);
}

/**
 * Deploy MockOptimisticOracleV3
 */
export async function deployMockOOv3(viem: any, minimumBond: bigint) {
  return viem.deployContract("MockOptimisticOracleV3", [minimumBond]);
}

/**
 * Create a fully funded job (Open → Funded)
 * Returns jobId (always 1n for freshly deployed contracts)
 */
export async function createAndFundJob(
  viem: any,
  apex: any,
  token: any,
  client: any,
  providerAddress: `0x${string}`,
  evaluatorAddress: `0x${string}`,
  budget: bigint,
  hookAddress: `0x${string}` = "0x0000000000000000000000000000000000000000"
) {
  const expiredAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
    client: { wallet: client },
  });

  await apexAsClient.write.createJob([
    providerAddress,
    evaluatorAddress,
    expiredAt,
    "Test job",
    hookAddress,
  ]);

  const jobId = BigInt(1);
  await apexAsClient.write.setBudget([jobId, budget, "0x"]);

  // Mint and approve
  await token.write.mint([client.account.address, budget]);
  const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
    client: { wallet: client },
  });
  await tokenAsClient.write.approve([apex.address, budget]);

  // Fund
  await apexAsClient.write.fund([jobId, budget, "0x"]);

  return jobId;
}
