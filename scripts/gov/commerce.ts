import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "./lib/config.js";
import { exec } from "./lib/exec.js";
import { requireString, requireAddress } from "./lib/cli.js";
import { isMainScript } from "./lib/is-main.js";
import type { CallItem } from "./lib/types.js";

// Minimal ABI fragments we need to encode calldata. Using fragments instead of
// the full artifact keeps this file a pure builder (no viem.getContractAt).
const COMMERCE_ABI = [
  {
    type: "function",
    name: "setPlatformFee",
    inputs: [
      { name: "feeBP_", type: "uint256" },
      { name: "treasury_", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "pause", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "unpause", inputs: [], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export function buildSetPlatformFee(
  commerce: `0x${string}`,
  feeBP: bigint,
  treasury: `0x${string}`,
): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({
      abi: COMMERCE_ABI,
      functionName: "setPlatformFee",
      args: [feeBP, treasury],
    }),
    description: `commerce.setPlatformFee(${feeBP}, ${treasury})`,
  };
}

export function buildPause(commerce: `0x${string}`): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "pause" }),
    description: "commerce.pause()",
  };
}

export function buildUnpause(commerce: `0x${string}`): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "unpause" }),
    description: "commerce.unpause()",
  };
}

export function buildTransferOwnership(commerce: `0x${string}`, newOwner: `0x${string}`): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({
      abi: COMMERCE_ABI,
      functionName: "transferOwnership",
      args: [newOwner],
    }),
    description: `commerce.transferOwnership(${newOwner})`,
  };
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const argv = process.env.GOV_ARGS
    ? ["node", "script", ...process.env.GOV_ARGS.split(/\s+/).filter(Boolean)]
    : process.argv;
  const { parsed, ctx } = await parseAndBuild(argv, conn, ["fee-bp", "treasury", "to"]);
  const commerce = ctx.cfg.commerceProxy;
  if (!commerce) throw new Error(`commerceProxy missing in ADDRESSES[${conn.networkName}]`);

  let calls: CallItem[];
  switch (parsed.op) {
    case "setPlatformFee": {
      const raw = requireString(parsed.flags, "fee-bp");
      const feeBP = BigInt(raw);
      if (feeBP < 0n || feeBP > 10_000n) {
        throw new Error(`--fee-bp must be 0..10000 (BP), got ${feeBP}`);
      }
      const treasury = requireAddress(parsed.flags, "treasury");
      calls = [buildSetPlatformFee(commerce, feeBP, treasury)];
      break;
    }
    case "pause":
      calls = [buildPause(commerce)];
      break;
    case "unpause":
      calls = [buildUnpause(commerce)];
      break;
    case "transferOwnership": {
      const flagTo = parsed.flags["to"];
      let to: `0x${string}`;
      let source: string;
      if (typeof flagTo === "string") {
        to = requireAddress(parsed.flags, "to");
        source = "--to flag";
      } else if (ctx.cfg.timelockProxy) {
        to = ctx.cfg.timelockProxy;
        source = "cfg.timelockProxy";
      } else {
        throw new Error("pass --to <addr> or fill cfg.timelockProxy");
      }
      console.log(`[op] commerce.transferOwnership(${to})  [source: ${source}]`);
      calls = [buildTransferOwnership(commerce, to)];
      break;
    }
    default:
      throw new Error(
        `unknown op: ${parsed.op}. Expected: setPlatformFee | pause | unpause | transferOwnership`,
      );
  }

  await exec(ctx, calls);
}

if (isMainScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
