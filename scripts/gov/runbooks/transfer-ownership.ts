import { network } from "hardhat";
import { parseAndBuild } from "../lib/config.js";
import { exec } from "../lib/exec.js";
import { isMainScript } from "../lib/is-main.js";
import type { CallItem } from "../lib/types.js";
import { buildTransferOwnership as buildCommerceTransfer } from "../commerce.js";
import { buildTransferOwnership as buildRouterTransfer } from "../router.js";
import { buildTransferAdmin } from "../policy.js";

export function buildTransferAllOwnership(opts: {
  commerce: `0x${string}`;
  router: `0x${string}`;
  policy: `0x${string}`;
  timelock: `0x${string}`;
}): CallItem[] {
  return [
    buildCommerceTransfer(opts.commerce, opts.timelock),
    buildRouterTransfer(opts.router, opts.timelock),
    buildTransferAdmin(opts.policy, opts.timelock),
  ];
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const argv = process.env.GOV_ARGS
    ? ["node", "script", ...process.env.GOV_ARGS.split(/\s+/).filter(Boolean)]
    : process.argv;
  const { ctx } = await parseAndBuild(argv, conn, []);
  const { commerceProxy, routerProxy, policy, timelockProxy } = ctx.cfg;
  if (!commerceProxy || !routerProxy || !policy || !timelockProxy) {
    throw new Error(
      `transfer-ownership requires commerceProxy, routerProxy, policy, and timelockProxy in ADDRESSES[${conn.networkName}]`,
    );
  }

  const calls = buildTransferAllOwnership({
    commerce: commerceProxy,
    router: routerProxy,
    policy,
    timelock: timelockProxy,
  });

  await exec(ctx, calls);

  console.log(`\nAfter execution, the Timelock must accept ownership. Schedule from multisig:`);
  console.log(`  timelock.schedule(commerce, 0, commerce.acceptOwnership.selector, 0, salt, 0)`);
  console.log(`  timelock.schedule(router, 0, router.acceptOwnership.selector, 0, salt, 0)`);
  console.log(`  timelock.schedule(policy, 0, policy.acceptAdmin.selector, 0, salt, 0)`);
  console.log(`Then after minDelay: timelock.execute(...) for each.`);
}

if (isMainScript(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
