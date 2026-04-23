import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "./lib/config.js";
import { requireAddress, requireString } from "./lib/cli.js";
import { exec } from "./lib/exec.js";
import { isMainScript } from "./lib/is-main.js";
import type { CallItem } from "./lib/types.js";

const POLICY_ABI = [
  {
    type: "function",
    name: "addVoter",
    inputs: [{ name: "voter", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "removeVoter",
    inputs: [{ name: "voter", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setQuorum",
    inputs: [{ name: "newQuorum", type: "uint16" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferAdmin",
    inputs: [{ name: "newAdmin", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export function buildAddVoter(policy: `0x${string}`, voter: `0x${string}`): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({ abi: POLICY_ABI, functionName: "addVoter", args: [voter] }),
    description: `policy.addVoter(${voter})`,
  };
}

export function buildRemoveVoter(policy: `0x${string}`, voter: `0x${string}`): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({ abi: POLICY_ABI, functionName: "removeVoter", args: [voter] }),
    description: `policy.removeVoter(${voter})`,
  };
}

export function buildSetQuorum(policy: `0x${string}`, quorum: number): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({ abi: POLICY_ABI, functionName: "setQuorum", args: [quorum] }),
    description: `policy.setQuorum(${quorum})`,
  };
}

export function buildTransferAdmin(policy: `0x${string}`, newAdmin: `0x${string}`): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({
      abi: POLICY_ABI,
      functionName: "transferAdmin",
      args: [newAdmin],
    }),
    description: `policy.transferAdmin(${newAdmin})`,
  };
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const argv = process.env.GOV_ARGS
    ? ["node", "script", ...process.env.GOV_ARGS.split(/\s+/).filter(Boolean)]
    : process.argv;
  const { parsed, ctx } = await parseAndBuild(argv, conn, ["voter", "quorum", "to"]);
  const policy = ctx.cfg.policy;
  if (!policy) throw new Error(`policy missing in ADDRESSES[${conn.networkName}]`);

  let calls: CallItem[];
  switch (parsed.op) {
    case "addVoter": {
      const voter = requireAddress(parsed.flags, "voter");
      calls = [buildAddVoter(policy, voter)];
      break;
    }
    case "removeVoter": {
      const voter = requireAddress(parsed.flags, "voter");
      calls = [buildRemoveVoter(policy, voter)];
      break;
    }
    case "setQuorum": {
      const raw = requireString(parsed.flags, "quorum");
      const quorum = Number(raw);
      if (!Number.isInteger(quorum) || quorum < 1 || quorum > 65535) {
        throw new Error(`--quorum must be an integer 1..65535, got ${raw}`);
      }
      calls = [buildSetQuorum(policy, quorum)];
      break;
    }
    case "transferAdmin": {
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
      console.log(`[op] policy.transferAdmin(${to})  [source: ${source}]`);
      calls = [buildTransferAdmin(policy, to)];
      break;
    }
    default:
      throw new Error(
        `unknown op: ${parsed.op}. Expected: addVoter | removeVoter | setQuorum | transferAdmin`,
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
