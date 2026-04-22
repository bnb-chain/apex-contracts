/**
 * Wall-clock + on-chain-timestamp waiters. Both localhost and testnet advance
 * real time, so the same helpers apply.
 */

export function sleepSeconds(seconds: number): Promise<void> {
  return new Promise((r) => setTimeout(r, Math.max(0, seconds) * 1000));
}

/**
 * Block until the chain's latest block timestamp is `>= targetTs`.
 *
 * Poll interval is adaptive: back off proportionally to the remaining wait,
 * clamped to `[1s, 5s]`. Each tick does a `getBlock()`, so testnet RPC load
 * stays bounded even for long waits (e.g. the 60s expiry path emits ~15 polls).
 */
export async function waitUntilChainTimestamp(
  publicClient: any,
  targetTs: bigint,
  opts: { label?: string; timeoutMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 10 * 60_000);
  while (true) {
    const block = await publicClient.getBlock();
    if (block.timestamp >= targetTs) return;
    if (Date.now() > deadline) {
      throw new Error(
        `waitUntilChainTimestamp timed out${opts.label ? ` (${opts.label})` : ""}: ` +
          `target=${targetTs} current=${block.timestamp}`,
      );
    }
    const remaining = Number(targetTs - block.timestamp);
    const pauseSec = Math.max(1, Math.min(5, Math.ceil(remaining / 3)));
    await sleepSeconds(pauseSec);
  }
}

/**
 * Wait for a tx hash to produce a receipt with `>= 1` confirmation. Returns
 * the receipt. Throws on revert.
 */
export async function waitForReceipt(publicClient: any, hash: `0x${string}`) {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted: ${hash}`);
  }
  return receipt;
}
