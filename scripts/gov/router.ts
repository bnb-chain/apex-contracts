import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "./lib/config.js";
import { requireAddress, requireString } from "./lib/cli.js";
import { exec } from "./lib/exec.js";
import { isMainScript } from "./lib/is-main.js";
import type { CallItem } from "./lib/types.js";

// Minimal ABI fragments — same pattern as commerce.ts (keeps builders pure).
const ROUTER_ABI = [
  {
    type: "function",
    name: "setPolicyWhitelist",
    inputs: [
      { name: "policy", type: "address" },
      { name: "status", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setCommerce",
    inputs: [{ name: "newCommerce", type: "address" }],
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

export function buildSetPolicyWhitelist(
  router: `0x${string}`,
  policy: `0x${string}`,
  status: boolean,
): CallItem {
  return {
    to: router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "setPolicyWhitelist",
      args: [policy, status],
    }),
    description: `router.setPolicyWhitelist(${policy}, ${status})`,
  };
}

export function buildSetCommerce(router: `0x${string}`, newCommerce: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "setCommerce",
      args: [newCommerce],
    }),
    description: `router.setCommerce(${newCommerce})`,
  };
}

export function buildPause(router: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "pause" }),
    description: "router.pause()",
  };
}

export function buildUnpause(router: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "unpause" }),
    description: "router.unpause()",
  };
}

export function buildTransferOwnership(router: `0x${string}`, newOwner: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "transferOwnership",
      args: [newOwner],
    }),
    description: `router.transferOwnership(${newOwner})`,
  };
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const argv = process.env.GOV_ARGS
    ? ["node", "script", ...process.env.GOV_ARGS.split(/\s+/).filter(Boolean)]
    : process.argv;
  const { parsed, ctx } = await parseAndBuild(argv, conn, ["policy", "status", "commerce", "to"]);
  const router = ctx.cfg.routerProxy;
  if (!router) throw new Error(`routerProxy missing in ADDRESSES[${conn.networkName}]`);

  let calls: CallItem[];
  switch (parsed.op) {
    case "setPolicyWhitelist": {
      const policy = requireAddress(parsed.flags, "policy");
      const statusStr = requireString(parsed.flags, "status");
      if (statusStr !== "true" && statusStr !== "false") {
        throw new Error(`--status must be "true" or "false", got "${statusStr}"`);
      }
      const status = statusStr === "true";
      calls = [buildSetPolicyWhitelist(router, policy, status)];
      break;
    }
    case "setCommerce": {
      const newCommerce = requireAddress(parsed.flags, "commerce");
      calls = [buildSetCommerce(router, newCommerce)];
      break;
    }
    case "pause":
      calls = [buildPause(router)];
      break;
    case "unpause":
      calls = [buildUnpause(router)];
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
      console.log(`[op] router.transferOwnership(${to})  [source: ${source}]`);
      calls = [buildTransferOwnership(router, to)];
      break;
    }
    default:
      throw new Error(
        `unknown op: ${parsed.op}. Expected: setPolicyWhitelist | setCommerce | pause | unpause | transferOwnership`,
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
