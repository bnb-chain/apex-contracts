import { encodeFunctionData } from "viem";
import { TRUSTED_FORWARDER } from "./constants.js";

export async function deployMockToken(viem: any) {
  return viem.deployContract("MockERC20", ["Test Token", "TEST", 18]);
}

export async function mintTokens(token: any, to: `0x${string}`, amount: bigint) {
  await token.write.mint([to, amount]);
}

export async function deployAPEXProxy(
  viem: any,
  tokenAddress: `0x${string}`,
  treasuryAddress: `0x${string}`
) {
  const impl = await viem.deployContract("AgenticCommerceUpgradeable", [TRUSTED_FORWARDER]);

  const initData = encodeFunctionData({
    abi: impl.abi,
    functionName: "initialize",
    args: [tokenAddress, treasuryAddress],
  });

  const proxy = await viem.deployContract("ERC1967Proxy", [impl.address, initData]);
  return viem.getContractAt("AgenticCommerceUpgradeable", proxy.address);
}

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

export async function deployMockOOv3(viem: any, minimumBond: bigint) {
  return viem.deployContract("MockOptimisticOracleV3", [minimumBond]);
}

export async function createAndFundJob(
  viem: any,
  apex: any,
  token: any,
  client: any,
  providerAddress: `0x${string}`,
  evaluatorAddress: `0x${string}`,
  budget: bigint,
  hookAddress: `0x${string}` = "0x0000000000000000000000000000000000000000",
  expiredAt?: bigint
) {
  if (!expiredAt) {
    const publicClient = await viem.getPublicClient();
    const block = await publicClient.getBlock();
    expiredAt = block.timestamp + BigInt(86400); // 24h from current block time
  }

  const apexAsClient = await viem.getContractAt("AgenticCommerceUpgradeable", apex.address, {
    client: { wallet: client },
  });

  await apexAsClient.write.createJob([
    providerAddress, evaluatorAddress, expiredAt, "Test job", hookAddress,
  ]);

  const jobId = BigInt(1);
  await apexAsClient.write.setBudget([jobId, budget, "0x"]);

  await token.write.mint([client.account.address, budget]);
  const tokenAsClient = await viem.getContractAt("MockERC20", token.address, {
    client: { wallet: client },
  });
  await tokenAsClient.write.approve([apex.address, budget]);

  await apexAsClient.write.fund([jobId, budget, "0x"]);

  return jobId;
}
