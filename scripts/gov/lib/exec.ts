import type { AnyViem, CallItem, GovContext } from "./types.js";

export type DryRunResult = {
  ok: boolean;
  gas?: bigint;
  error?: string;
};

export function formatCalldata(calls: CallItem[]): string {
  const lines: string[] = [];
  calls.forEach((c, i) => {
    lines.push(`[${i + 1}/${calls.length}] ${c.description}`);
    lines.push(`  to    : ${c.to}`);
    lines.push(`  data  : ${c.data}`);
    if (c.value !== undefined && c.value !== 0n) lines.push(`  value : ${c.value}`);
    lines.push("");
  });
  return lines.join("\n");
}

export async function execDryRun(
  viem: AnyViem,
  from: `0x${string}`,
  calls: CallItem[],
): Promise<DryRunResult[]> {
  const publicClient = await viem.getPublicClient();
  const results: DryRunResult[] = [];
  for (const c of calls) {
    try {
      const gas = await publicClient.estimateGas({
        account: from,
        to: c.to,
        data: c.data,
        value: c.value ?? 0n,
      });
      results.push({ ok: true, gas });
    } catch (err: unknown) {
      const short = (err as { shortMessage?: unknown })?.shortMessage;
      const msg =
        typeof short === "string" && short.length > 0
          ? short
          : err instanceof Error
            ? err.message
            : String(err);
      results.push({ ok: false, error: msg });
    }
  }
  return results;
}

export async function execEoa(viem: AnyViem, calls: CallItem[]): Promise<`0x${string}`[]> {
  const [walletClient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const hashes: `0x${string}`[] = [];
  for (const c of calls) {
    const hash = await walletClient.sendTransaction({
      to: c.to,
      data: c.data,
      value: c.value ?? 0n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  return hashes;
}

/**
 * Dispatches `calls` to the execution backend selected by `ctx.mode`.
 *
 * CLI-facing: this function may terminate the process (process.exit(1)) when
 * dry-run encounters any reverted call. Do NOT compose it from runbooks
 * expecting to continue on failure — catch at the call site, or drop down to
 * `execDryRun` / `execEoa` / `formatCalldata` directly.
 */
export async function exec(ctx: GovContext, calls: CallItem[]): Promise<void> {
  if (calls.length === 0) {
    console.log("(no calls to execute)");
    return;
  }
  switch (ctx.mode) {
    case "dry-run": {
      const results = await execDryRun(ctx.viem, ctx.deployer, calls);
      results.forEach((r, i) => {
        const c = calls[i]!;
        console.log(`[dry-run] ${c.description}`);
        console.log(`  network : ${ctx.networkName}`);
        if (r.ok) {
          console.log(`  gas     : ${r.gas}`);
          console.log(`  result  : success ✓`);
        } else {
          console.log(`  result  : revert`);
          console.log(`  error   : ${r.error}`);
        }
        console.log("");
      });
      if (results.some((r) => !r.ok)) process.exit(1);
      return;
    }
    case "eoa": {
      const hashes = await execEoa(ctx.viem, calls);
      hashes.forEach((h, i) => {
        console.log(`[eoa] ${calls[i]!.description} → ${h}`);
      });
      return;
    }
    case "calldata": {
      console.log(`Paste the following into Safe (${ctx.cfg.multisig}):\n`);
      console.log(formatCalldata(calls));
      return;
    }
    case "propose": {
      const { proposeToSafe } = await import("./safe.js");
      await proposeToSafe(ctx, calls);
      return;
    }
    default: {
      // exhaustiveness check — ExecMode is a closed union
      const _exhaustive: never = ctx.mode;
      throw new Error(`unknown exec mode: ${String(_exhaustive)}`);
    }
  }
}
