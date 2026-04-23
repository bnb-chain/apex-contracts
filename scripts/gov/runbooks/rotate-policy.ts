import { network } from "hardhat";
import { requireAddress } from "../lib/cli.js";
import { parseAndBuild } from "../lib/config.js";
import { exec } from "../lib/exec.js";
import { isMainScript } from "../lib/is-main.js";
import type { CallItem } from "../lib/types.js";
import { buildSetPolicyWhitelist } from "../router.js";

export function buildRotatePolicyWhitelist(opts: {
  router: `0x${string}`;
  newPolicy: `0x${string}`;
  oldPolicy: `0x${string}` | null;
}): CallItem[] {
  const calls: CallItem[] = [buildSetPolicyWhitelist(opts.router, opts.newPolicy, true)];
  if (opts.oldPolicy) {
    calls.push(buildSetPolicyWhitelist(opts.router, opts.oldPolicy, false));
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
    ["old-policy", "dispute-window", "initial-quorum", "skip-revoke"],
    ["skip-revoke"],
  );
  const { commerceProxy, routerProxy, policy: cfgPolicy } = ctx.cfg;
  if (!commerceProxy || !routerProxy) {
    throw new Error(`commerceProxy + routerProxy required in ADDRESSES[${conn.networkName}]`);
  }

  const skipRevoke = parsed.flags["skip-revoke"] === true;
  let oldPolicy: `0x${string}` | undefined;
  if (skipRevoke) {
    oldPolicy = undefined;
  } else if (typeof parsed.flags["old-policy"] === "string") {
    oldPolicy = requireAddress(parsed.flags, "old-policy");
  } else {
    oldPolicy = cfgPolicy;
  }
  if (!oldPolicy && !skipRevoke) {
    console.error(
      `no old policy found: pass --old-policy <addr>, fill ADDRESSES[${conn.networkName}].policy, or pass --skip-revoke`,
    );
    process.exit(1);
  }

  // Step 1 — deploy the new Policy. Always EOA-direct: address feeds step 2.
  const disputeWindow = BigInt((parsed.flags["dispute-window"] as string) ?? "86400");
  const initialQuorum = Number((parsed.flags["initial-quorum"] as string) ?? "2");
  console.log(`[1/2] deploying new OptimisticPolicy ...`);
  const [walletClient] = await ctx.viem.getWalletClients();
  const newPolicy = await ctx.viem.deployContract("OptimisticPolicy", [
    commerceProxy,
    routerProxy,
    walletClient.account.address,
    disputeWindow,
    initialQuorum,
  ]);
  console.log(`      new policy: ${newPolicy.address}`);

  // Step 2 — whitelist new, revoke old. This is the batch for Safe.
  console.log(`\n[2/2] whitelist/revoke via ${ctx.mode} ...`);
  const calls = buildRotatePolicyWhitelist({
    router: routerProxy,
    newPolicy: newPolicy.address,
    oldPolicy: oldPolicy ?? null,
  });
  await exec(ctx, calls);

  console.log(`\nPaste into ADDRESSES["${conn.networkName}"]:`);
  console.log(`    policy: "${newPolicy.address}",`);
}

if (isMainScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
