/**
 * Hand-committed registry of per-network addresses used by deploy and upgrade
 * scripts. Each entry has two kinds of fields:
 *
 *   - Pre-deploy inputs (REQUIRED before running `deploy:<env>`):
 *       paymentToken - ERC-20 used for job escrow + platform fees
 *       treasury     - receives platformFeeBP on every completed job
 *
 *   - Post-deploy outputs (FILLED by copy-pasting `deploy.ts` stdout):
 *       commerceProxy, routerProxy, policy
 *
 * Local / forked networks intentionally have no entry here: `deploy.ts`
 * auto-deploys a MockERC20 and uses the deployer as the treasury. The
 * resulting MockERC20 address is printed to stdout for fund-local.ts to pick
 * up via `.env`.
 *
 * Workflow (live networks):
 *   1. Fill `paymentToken` + `treasury` for the target network below, commit.
 *   2. Run `bun run deploy:<env>`.
 *   3. Paste the printed `commerceProxy` / `routerProxy` / `policy` into the
 *      same entry, commit. Upgrade scripts import them directly thereafter.
 */

export type DeployedAddresses = {
  // Deploy inputs (required before first deploy).
  readonly paymentToken: `0x${string}`;
  readonly treasury: `0x${string}`;
  // Deploy outputs (undefined until `deploy.ts` has run successfully).
  readonly commerceProxy?: `0x${string}`;
  readonly routerProxy?: `0x${string}`;
  readonly policy?: `0x${string}`;
};

export const ADDRESSES: Partial<Record<string, DeployedAddresses>> = {
  bscTestnet: {
    paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", // e.g. USDC on BSC Testnet
    treasury: "0x1001b2C085345f388778A975648aA50bcfd0D134",
    // commerceProxy: "0x...",
    // routerProxy: "0x...",
    // policy: "0x...",
  },
  // bsc: {
  //   paymentToken: "0x...", // e.g. USDC on BSC Mainnet
  //   treasury:     "0x...",
  //   commerceProxy: "0x...",
  //   routerProxy:   "0x...",
  //   policy:        "0x...",
  // },
};

/**
 * Pre-deploy inputs. Called by `deploy.ts` on live networks before the stack
 * is deployed. Throws when the network has no entry.
 */
export function getDeployInputs(network: string): {
  paymentToken: `0x${string}`;
  treasury: `0x${string}`;
} {
  const a = ADDRESSES[network];
  if (!a) {
    throw new Error(
      `No ADDRESSES entry for network "${network}" in scripts/addresses.ts. ` +
        `Add paymentToken + treasury before running deploy.`,
    );
  }
  return { paymentToken: a.paymentToken, treasury: a.treasury };
}

/**
 * Fully-populated addresses (post-deploy). Called by `upgrade-*.ts`. Throws
 * when the network entry is missing any of the post-deploy fields.
 */
export function getAddresses(network: string): Required<DeployedAddresses> {
  const a = ADDRESSES[network];
  if (!a || !a.commerceProxy || !a.routerProxy || !a.policy) {
    throw new Error(
      `Missing post-deploy fields for network "${network}" in scripts/addresses.ts. ` +
        `Paste the block printed by deploy.ts under ADDRESSES.`,
    );
  }
  return a as Required<DeployedAddresses>;
}
