/**
 * Hand-committed registry of per-network addresses used by `deploy.ts`
 * (and read directly by `test/e2e/context.ts`).
 *
 * `deploy.ts` reads this table top-to-bottom with a cascade rule:
 *
 *   - paymentToken blank
 *       → FULL-STACK ROTATION. Script deploys a fresh ERC20MinimalMock + fresh
 *         Commerce proxy + fresh Router proxy + fresh Policy. cfg.commerceProxy
 *         and cfg.routerProxy are IGNORED in this branch (warning is printed).
 *         Intended use: "I want to rotate paymentToken". The old Commerce /
 *         Router remain on-chain; clients must drain them via claimRefund.
 *
 *   - paymentToken filled → use that ERC-20 verbatim. Then:
 *       - commerceProxy filled → keep proxy, only deploy new impl + upgradeToAndCall.
 *       - commerceProxy blank  → deploy fresh Commerce AND force-fresh the
 *         Router (otherwise the Router would point at a dead Commerce).
 *       - routerProxy filled AND Commerce was reused → keep proxy, only
 *         deploy new impl + upgradeToAndCall.
 *       - routerProxy blank (or forced fresh by the cascade) → deploy fresh
 *         Router pointing at the Commerce above.
 *
 *   - treasury: filled → passed into commerce.initialize on the fresh path;
 *                on the reuse path it's only stamped into logs (on-chain
 *                platformTreasury is authoritative and mutable via
 *                `setPlatformFee`, which this script never calls).
 *                Blank → falls back to the deployer.
 *
 *   - policy: ALWAYS freshly deployed + whitelisted on the Router. The value
 *     stored here is ignored as input; it only informs the "revoke old
 *     policy" reminder printed at the end of each run.
 *
 * Workflow:
 *   1. Optionally pre-fill `paymentToken` + `treasury` for the target
 *      network below; run `bun run deploy:<env>`.
 *   2. Paste the printed block (only the fields that changed in that run)
 *      back into the same entry and commit.
 */

export type DeployedAddresses = {
  readonly paymentToken?: `0x${string}`;
  readonly treasury?: `0x${string}`;
  readonly commerceProxy?: `0x${string}`;
  readonly routerProxy?: `0x${string}`;
  readonly policy?: `0x${string}`;
};

export const ADDRESSES: Partial<Record<string, DeployedAddresses>> = {
  bscTestnet: {
    // paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", // e.g. USDC on BSC Testnet
    paymentToken: "0x706d99bccefec37ed2ae62876347b8b9399e5f2e",
    treasury: "0x1001b2C085345f388778A975648aA50bcfd0D134",
    commerceProxy: "0x1e677fc06ff772e81051484c8c3845fbef13986d",
    routerProxy: "0x0c729baa3cdac6cc3fdef6a816f6bcb85ae92ed7",
    policy: "0x459c3b7a46aa9dde45fbfc3b3d37bd062dbe6fb8",
  },
  // bsc: {
  //   paymentToken: "0x...", // e.g. USDC on BSC Mainnet
  //   treasury:     "0x...",
  //   commerceProxy: "0x...",
  //   routerProxy:   "0x...",
  //   policy:        "0x...",
  // },
};
