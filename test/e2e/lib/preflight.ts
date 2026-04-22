/**
 * Pre-flight checks run before any transaction is sent. Fail fast with a
 * user-actionable message rather than burning gas on a doomed run.
 */

import { formatEther, formatUnits, getAddress, parseUnits } from "viem";

import type { E2EConfig } from "../config.js";
import type { E2EWallets } from "./wallets.js";
import type { Logger } from "./logging.js";

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

type Role = "owner" | "client" | "provider";

/**
 * Per-role native-gas budget. Summed when a single EOA plays multiple roles.
 * Numbers are empirical BSC Testnet fees observed across the 5 flows.
 */
const MIN_BNB_PER_ROLE: Record<Role, bigint> = {
  owner: 20_000_000_000_000_000n, // 0.02 BNB  (policy deploy + whitelist + voter + voteReject + settle + claimRefund)
  client: 30_000_000_000_000_000n, // 0.03 BNB  (createJob × 5 + registerJob + setBudget + approve + fund + dispute + reject)
  provider: 5_000_000_000_000_000n, // 0.005 BNB (submit ×3)
};

// Flows A, B, C, E all fund(). The Happy-path keeps `(1 − fee) × budget` in
// provider; every other funded flow refunds the client in full. Four budgets
// of pre-loaded balance covers a single run with plenty of slack.
const FUNDED_FLOWS_PER_RUN = 4;

async function nativeBalance(publicClient: any, addr: `0x${string}`): Promise<bigint> {
  return (await publicClient.getBalance({ address: getAddress(addr) })) as bigint;
}

export interface PreflightReport {
  paymentToken: `0x${string}`;
  decimals: number;
  budget: bigint;
}

/**
 * Ensures the commerce + router + owner trio is reachable and the wallets are
 * funded enough to complete a single E2E cycle.
 */
export async function testnetPreflight(
  publicClient: any,
  commerce: any,
  router: any,
  token: any,
  wallets: E2EWallets,
  cfg: E2EConfig,
  log: Logger,
): Promise<PreflightReport> {
  log.header("Preflight");

  // 1. Block number: RPC live.
  const blockNumber = await publicClient.getBlockNumber();
  log.info(`chain block: ${blockNumber}`);

  // 2. Router owner must match the key the runner uses to sign admin txs.
  const currentOwner = getAddress((await router.read.owner()) as `0x${string}`);
  const ownerAddr = getAddress(wallets.owner.account!.address);
  if (currentOwner !== ownerAddr) {
    throw new PreflightError(
      `Router owner mismatch. Router.owner()=${currentOwner}, ` +
        `BSC_TESTNET_PRIVATE_KEY resolves to=${ownerAddr}. ` +
        `Either transfer router ownership back to the deployer key, or ` +
        `point BSC_TESTNET_PRIVATE_KEY at the current owner.`,
    );
  }
  log.ok(`router.owner == BSC_TESTNET_PRIVATE_KEY (${ownerAddr})`);

  // 3. Payment token + decimals.
  const paymentToken = getAddress((await commerce.read.paymentToken()) as `0x${string}`);
  const decimals = Number(await token.read.decimals());
  const budget = parseUnits(String(cfg.budgetUnits), decimals);
  log.info(`paymentToken: ${paymentToken}`);
  log.info(`budget per flow: ${cfg.budgetUnits} token (${budget} minor units)`);

  // 4. Aggregate per-role BNB requirements by address so collapsing multiple
  //    roles into one EOA (the default 1-key mode) correctly sums thresholds.
  const clientAddr = getAddress(wallets.client.account!.address);
  const providerAddr = getAddress(wallets.provider.account!.address);
  const roleByAddress = new Map<`0x${string}`, Role[]>();
  const bind = (addr: `0x${string}`, role: Role) => {
    const arr = roleByAddress.get(addr) ?? [];
    arr.push(role);
    roleByAddress.set(addr, arr);
  };
  bind(ownerAddr, "owner");
  bind(clientAddr, "client");
  bind(providerAddr, "provider");

  const failures: string[] = [];
  for (const [addr, roles] of roleByAddress) {
    const required = roles.reduce((acc, r) => acc + MIN_BNB_PER_ROLE[r], 0n);
    const actual = await nativeBalance(publicClient, addr);
    log.info(
      `${roles.join("+").padEnd(24)} BNB: ${formatEther(actual)}  (need ${formatEther(required)})  ${addr}`,
    );
    if (actual < required) {
      failures.push(
        `${addr} (${roles.join("+")}) BNB=${formatEther(actual)} < required ${formatEther(required)}`,
      );
    }
  }

  // 5. Client payment-token balance.
  const clientTokenBal = (await token.read.balanceOf([clientAddr])) as bigint;
  const requiredToken = budget * BigInt(FUNDED_FLOWS_PER_RUN);
  log.info(
    `client token balance: ${formatUnits(clientTokenBal, decimals)} (need ${formatUnits(requiredToken, decimals)})`,
  );
  if (clientTokenBal < requiredToken) {
    failures.push(
      `client token balance ${formatUnits(clientTokenBal, decimals)} < required ` +
        `${formatUnits(requiredToken, decimals)}. Send at least that to ${clientAddr} (token=${paymentToken}).`,
    );
  }

  if (failures.length > 0) {
    throw new PreflightError(`Preflight failed:\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  }
  log.ok("preflight passed");

  return { paymentToken, decimals, budget };
}
