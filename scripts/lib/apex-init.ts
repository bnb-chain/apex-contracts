import { encodeFunctionData, type Abi } from "viem";

/**
 * Shared initializer-calldata and constructor-argument builders used by both
 * `scripts/deploy.ts` (at deployment time) and `scripts/verify.ts` (to
 * reproduce the exact bytes that BscScan / Etherscan will compare against).
 *
 * Keep this file dependency-free beyond `viem` so `verify.ts` doesn't have
 * to boot Hardhat to call these.
 */

export const ERC20_MOCK_CONSTRUCTOR_ARGS = ["Apex Test Token", "APT", 18] as const;

export function commerceInitCalldata(
  abi: Abi,
  args: {
    paymentToken: `0x${string}`;
    treasury: `0x${string}`;
    owner: `0x${string}`;
  },
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [args.paymentToken, args.treasury, args.owner],
  });
}

export function routerInitCalldata(
  abi: Abi,
  args: {
    commerce: `0x${string}`;
    owner: `0x${string}`;
  },
): `0x${string}` {
  return encodeFunctionData({
    abi,
    functionName: "initialize",
    args: [args.commerce, args.owner],
  });
}

export type PolicyConstructorArgs = readonly [
  commerce: `0x${string}`,
  router: `0x${string}`,
  admin: `0x${string}`,
  disputeWindow: bigint,
  initialQuorum: number,
];

export function policyConstructorArgs(args: {
  commerce: `0x${string}`;
  router: `0x${string}`;
  admin: `0x${string}`;
  disputeWindow: bigint;
  initialQuorum: number;
}): PolicyConstructorArgs {
  return [args.commerce, args.router, args.admin, args.disputeWindow, args.initialQuorum] as const;
}
