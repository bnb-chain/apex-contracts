/**
 * Wallet factory: local reuses Hardhat's prefunded accounts; testnet builds
 * up to 3 viem wallet clients from env private keys. `clientKey` and
 * `providerKey` default to `ownerKey` in `config.ts`, and `ownerKey` itself
 * defaults to `BSC_TESTNET_PRIVATE_KEY`. So the minimal testnet setup is a
 * single already-required hardhat key that plays every role.
 */

import { createWalletClient, http, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bscTestnet } from "viem/chains";

import type { E2EConfig } from "../config.js";

export interface E2EWallets {
  owner: WalletClient;
  client: WalletClient;
  provider: WalletClient;
  /** Voter addresses used by the E2E Policy; in local mode each entry is a
   *  distinct EOA, in testnet mode voter[0] === owner to keep wallet count
   *  at 3 while satisfying `quorum=1`. */
  voters: WalletClient[];
}

/**
 * Build the 5-role wallet map from Hardhat's prefunded accounts (local) or
 * env private keys (testnet).
 */
export async function loadWallets(viem: any, cfg: E2EConfig): Promise<E2EWallets> {
  if (cfg.kind === "local") {
    const all = await viem.getWalletClients();
    if (all.length < 5) {
      throw new Error(`Local node must expose >=5 prefunded accounts; got ${all.length}.`);
    }
    return {
      owner: all[0],
      client: all[1],
      provider: all[2],
      voters: [all[3], all[4]],
    };
  }

  const keys = cfg.testnet;
  if (!keys) throw new Error("internal: testnet config missing keys");

  const rpcUrl = process.env.BSC_TESTNET_RPC_URL;
  if (!rpcUrl) throw new Error("BSC_TESTNET_RPC_URL env var is required for testnet E2E.");

  function build(pk: `0x${string}`): WalletClient {
    return createWalletClient({
      account: privateKeyToAccount(pk),
      chain: bscTestnet,
      transport: http(rpcUrl),
    });
  }

  const owner = build(keys.ownerKey);
  const client = build(keys.clientKey);
  const provider = build(keys.providerKey);
  // Owner doubles as the sole voter — matches `initialQuorum=1` testnet default.
  return { owner, client, provider, voters: [owner] };
}
