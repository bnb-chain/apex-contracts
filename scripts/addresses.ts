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
 *   - commerceImpl / routerImpl: current UUPS implementation addresses behind
 *     each proxy. Read by `scripts/verify.ts` to Etherscan-verify the impl
 *     source. `deploy.ts` updates them on every run (fresh deploy OR
 *     upgradeToAndCall), and the operator pastes them back together with the
 *     proxy address. Purely observational — nothing in the deploy path reads
 *     these.
 *
 * Workflow:
 *   1. Optionally pre-fill `paymentToken` + `treasury` for the target
 *      network below; run `bun run deploy:<env>`.
 *   2. Paste the printed block (only the fields that changed in that run)
 *      back into the same entry and commit.
 *   3. Run `bun run verify:<env>` to Etherscan-verify the whole stack.
 */

export type DeployedAddresses = {
  readonly paymentToken?: `0x${string}`;
  readonly treasury?: `0x${string}`;
  readonly commerceProxy?: `0x${string}`;
  readonly commerceImpl?: `0x${string}`;
  readonly routerProxy?: `0x${string}`;
  readonly routerImpl?: `0x${string}`;
  readonly policy?: `0x${string}`;
};

export const ADDRESSES: Partial<Record<string, DeployedAddresses>> = {
  bscTestnet: {
    paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", // e.g. USDC on BSC Testnet
    treasury: "0x1001b2C085345f388778A975648aA50bcfd0D134",
    commerceProxy: "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de",
    commerceImpl: "0xc0b74dc6b1c95b1452f678741e7907290587d69b",
    routerProxy: "0xd7d36d66d2f1b608a0f943f722d27e3744f66f25",
    routerImpl: "0x9f42b71ae5990e6f5bb58a935fffe32b29a5374a",
    policy: "0x4f4678d4439fec812ac7674bb3efb4c8f5fb78a6",
  },
  // bsc: {
  //   paymentToken:  "0x...", // e.g. USDC on BSC Mainnet
  //   treasury:      "0x...",
  //   commerceProxy: "0x...",
  //   commerceImpl:  "0x...",
  //   routerProxy:   "0x...",
  //   routerImpl:    "0x...",
  //   policy:        "0x...",
  // },
};
