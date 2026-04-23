import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "../lib/config.js";
import { exec } from "../lib/exec.js";
import { isMainScript } from "../lib/is-main.js";
import type { CallItem } from "../lib/types.js";

const UUPS_ABI = [
  {
    type: "function",
    name: "upgradeToAndCall",
    inputs: [
      { name: "newImplementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

export type UpgradeMode = "all" | "commerce" | "router";

export function buildUpgradeCalls(opts: {
  mode: UpgradeMode;
  commerce: `0x${string}`;
  router: `0x${string}`;
  newCommerceImpl: `0x${string}` | null;
  newRouterImpl: `0x${string}` | null;
}): CallItem[] {
  const calls: CallItem[] = [];
  if ((opts.mode === "all" || opts.mode === "commerce") && opts.newCommerceImpl) {
    calls.push({
      to: opts.commerce,
      data: encodeFunctionData({
        abi: UUPS_ABI,
        functionName: "upgradeToAndCall",
        args: [opts.newCommerceImpl, "0x"],
      }),
      description: `commerce.upgradeToAndCall(${opts.newCommerceImpl}, 0x)`,
    });
  }
  if ((opts.mode === "all" || opts.mode === "router") && opts.newRouterImpl) {
    calls.push({
      to: opts.router,
      data: encodeFunctionData({
        abi: UUPS_ABI,
        functionName: "upgradeToAndCall",
        args: [opts.newRouterImpl, "0x"],
      }),
      description: `router.upgradeToAndCall(${opts.newRouterImpl}, 0x)`,
    });
  }
  return calls;
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const argv = process.env.GOV_ARGS
    ? ["node", "script", ...process.env.GOV_ARGS.split(/\s+/).filter(Boolean)]
    : process.argv;
  const { parsed, ctx } = await parseAndBuild(
    argv,
    conn,
    ["commerce", "router", "all"],
    ["commerce", "router", "all"],
  );

  const modeFlags = ["commerce", "router", "all"].filter((f) => parsed.flags[f] === true);
  let mode: UpgradeMode = "all";
  if (modeFlags.length > 1) throw new Error(`pass only one of --commerce / --router / --all`);
  if (modeFlags.length === 1) mode = modeFlags[0] as UpgradeMode;

  const { commerceProxy, routerProxy } = ctx.cfg;
  if (!commerceProxy || !routerProxy) {
    throw new Error(`commerceProxy + routerProxy required in ADDRESSES[${conn.networkName}]`);
  }

  // Step 1 — deploy impl(s). Always EOA-direct; addresses feed step 2.
  let newCommerceImpl: `0x${string}` | null = null;
  let newRouterImpl: `0x${string}` | null = null;
  if (mode === "all" || mode === "commerce") {
    console.log(`[impl] deploying new AgenticCommerceUpgradeable ...`);
    const impl = await ctx.viem.deployContract("AgenticCommerceUpgradeable", []);
    newCommerceImpl = impl.address;
    console.log(`       commerce impl: ${newCommerceImpl}`);
  }
  if (mode === "all" || mode === "router") {
    console.log(`[impl] deploying new EvaluatorRouterUpgradeable ...`);
    const impl = await ctx.viem.deployContract("EvaluatorRouterUpgradeable", []);
    newRouterImpl = impl.address;
    console.log(`       router impl  : ${newRouterImpl}`);
  }

  const calls = buildUpgradeCalls({
    mode,
    commerce: commerceProxy,
    router: routerProxy,
    newCommerceImpl,
    newRouterImpl,
  });
  console.log(`\n[upgrade] submitting ${calls.length} upgradeToAndCall via ${ctx.mode} ...`);
  await exec(ctx, calls);
}

if (isMainScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
