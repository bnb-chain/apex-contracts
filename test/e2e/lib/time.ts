/**
 * Uniform time-advance helpers.
 *
 *  - local   → use Hardhat node's `evm_increaseTime` + `evm_mine` so the
 *              runner completes in seconds.
 *  - testnet → real wall-clock sleep + poll chain timestamp.
 *
 * Flows call only `advanceSeconds` / `waitUntilTs` and remain network-agnostic.
 */

import type { NetworkKind } from "../config.js";
import { sleepSeconds, waitUntilChainTimestamp } from "./wait.js";

export interface TimeController {
  kind: NetworkKind;
  /** Move the chain forward by `seconds` (may block real-time on testnet). */
  advanceSeconds(seconds: number): Promise<void>;
  /** Block until the chain timestamp is `>= targetTs`. */
  waitUntilTs(targetTs: bigint, label?: string): Promise<void>;
  /** Current chain timestamp. */
  now(): Promise<bigint>;
}

export function createTimeController(
  kind: NetworkKind,
  publicClient: any,
  viem: any,
): TimeController {
  if (kind === "local") {
    return {
      kind,
      async advanceSeconds(seconds: number) {
        const testClient = await viem.getTestClient();
        await testClient.increaseTime({ seconds: Math.max(1, Math.ceil(seconds)) });
        await testClient.mine({ blocks: 1 });
      },
      async waitUntilTs(targetTs: bigint, label?: string) {
        const block = await publicClient.getBlock();
        if (block.timestamp >= targetTs) return;
        const delta = Number(targetTs - block.timestamp) + 1;
        const testClient = await viem.getTestClient();
        await testClient.increaseTime({ seconds: delta });
        await testClient.mine({ blocks: 1 });
        const after = await publicClient.getBlock();
        if (after.timestamp < targetTs) {
          throw new Error(
            `local waitUntilTs failed${label ? ` (${label})` : ""}: ` +
              `target=${targetTs} current=${after.timestamp}`,
          );
        }
      },
      async now() {
        return (await publicClient.getBlock()).timestamp;
      },
    };
  }

  return {
    kind,
    async advanceSeconds(seconds: number) {
      await sleepSeconds(seconds);
    },
    async waitUntilTs(targetTs: bigint, label?: string) {
      await waitUntilChainTimestamp(publicClient, targetTs, { label });
    },
    async now() {
      return (await publicClient.getBlock()).timestamp;
    },
  };
}
