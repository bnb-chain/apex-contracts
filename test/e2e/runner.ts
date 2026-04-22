/**
 * APEX end-to-end runner.
 *
 * Usage:
 *   bun run e2e:local     (requires `bun run node` in another terminal)
 *   bun run e2e:testnet   (requires .env.testnet + 3 pre-funded wallets)
 *
 * The runner deploys / reuses the APEX stack, then drives all 5 ERC-8183
 * user flows end-to-end (docs/design.md §4). Exit code is 0 iff every flow
 * reported PASS; any flow failure yields non-zero and — when E2E_FAIL_FAST
 * is true (default) — stops the remaining flows.
 */

import { network } from "hardhat";

import { loadConfig } from "./config.js";
import { buildContext } from "./context.js";
import { FLOWS, type FlowResult } from "./flows/index.js";
import { PreflightError } from "./lib/preflight.js";
import { E2EAssertError } from "./lib/assertions.js";

async function main() {
  const { viem, networkName } = await network.connect();

  const cfg = loadConfig(networkName);
  const ctx = await buildContext(viem, cfg);
  const { log } = ctx;

  log.header(`Run flows (${cfg.kind} / ${cfg.networkName})`);
  log.info(
    `config: window=${cfg.disputeWindowSeconds}s expiry=${cfg.jobExpirySeconds}s ` +
      `budget=${cfg.budgetUnits} quorum=${cfg.initialQuorum} failFast=${cfg.failFast}`,
  );

  const results: FlowResult[] = [];
  for (const { name, run } of FLOWS) {
    log.header(name);
    try {
      const r = await run(ctx);
      results.push(r);
      log.ok(`${r.name} PASS${r.jobId !== undefined ? ` (jobId=${r.jobId})` : ""}`);
    } catch (err) {
      const r: FlowResult = { name, passed: false, error: err };
      results.push(r);
      const msg = err instanceof Error ? (err.stack ?? err.message) : String(err);
      log.fail(`${name} FAIL`);
      console.error(msg);
      if (cfg.failFast) break;
    }
  }

  log.header("Summary");
  for (const r of results) {
    const tag = r.passed ? "PASS" : "FAIL";
    console.log(`  [${tag}] ${r.name}${r.jobId !== undefined ? ` jobId=${r.jobId}` : ""}`);
  }
  const ranCount = results.length;
  const passCount = results.filter((r) => r.passed).length;
  const totalCount = FLOWS.length;
  console.log(
    `\n  ${passCount}/${totalCount} passed` +
      (ranCount < totalCount ? ` (stopped early after ${ranCount})` : ""),
  );

  if (passCount !== totalCount) {
    process.exit(1);
  }
}

main().catch((err) => {
  if (err instanceof PreflightError) {
    console.error(`\n[preflight] ${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof E2EAssertError) {
    console.error(`\n[assertion] ${err.message}\n`);
    process.exit(1);
  }
  console.error(err);
  process.exit(1);
});
