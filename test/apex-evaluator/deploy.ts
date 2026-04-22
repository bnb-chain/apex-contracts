// Re-exports V1 shared deploy helpers and adds UMA-only helpers for legacy tests.
// Legacy UMA-based evaluator — not used by V1 Router path.

import { encodeFunctionData } from "viem";

export { deployMockToken, mintTokens, deployAPEXProxy, createAndFundJob } from "../deploy.js";

export async function deployEvaluatorProxy(
  viem: any,
  ownerAddress: `0x${string}`,
  erc8183Address: `0x${string}`,
  oov3Address: `0x${string}`,
  bondTokenAddress: `0x${string}`,
  liveness: bigint,
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
