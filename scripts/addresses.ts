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
 *       - paymentTokens omitted → initialize the allowlist with only
 *         paymentToken for backwards-compatible U-only upgrades. Omission does
 *         NOT mean USDC / USDT / USD1 are enabled, and it will not re-enable a
 *         governance-disabled default token on an existing v2 Commerce.
 *       - paymentTokens filled → before each run, operators MUST explicitly
 *         list the full desired set for that network's single Commerce, e.g.
 *         [U, USD1, USDC, USDT]; each address MUST be unique, include
 *         paymentToken (the default/compat token), and be a deployed contract.
 *         Existing v2 Commerce is checked per-token for support; missing
 *         entries only generate setPaymentTokenSupported(token, true) and
 *         NEVER disable tokens not listed.
 *         BSC mainnet USD1 candidate: 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d.
 *         That candidate and these notes are commentary only until executed —
 *         they are not an applied paymentTokens config. Testnet does not
 *         support USD1; it MUST NOT appear in paymentTokens there.
 *       - commerceProxy filled → keep proxy; deploy new impl + upgradeToAndCall
 *         ONLY if the compiled bytecode differs from the on-chain impl.
 *       - commerceProxy blank  → deploy fresh Commerce AND force-fresh the
 *         Router (otherwise the Router would point at a dead Commerce).
 *       - routerProxy filled AND Commerce was reused → keep proxy; same
 *         bytecode-diff rule as Commerce.
 *       - routerProxy blank (or forced fresh by the cascade) → deploy fresh
 *         Router pointing at the Commerce above.
 *
 *   - treasury: filled → passed into commerce.initialize on the fresh path;
 *                on the reuse path it's only stamped into logs (on-chain
 *                platformTreasury is authoritative and mutable via
 *                `setPlatformFee`, which this script never calls).
 *                Blank → falls back to the deployer.
 *
 *   - policy: reused when its on-chain bytecode matches the compiled artifact
 *     AND it points at this entry's commerce/router; otherwise a fresh
 *     OptimisticPolicy is deployed + whitelisted on the Router. Constructor
 *     params (disputeWindow / initialQuorum) are immutables and invisible to
 *     the bytecode diff — to rotate params without a code change, blank this
 *     field to force a redeploy.
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
 *      network below; run `bun run deploy:<env>` (dry run — prints the plan),
 *      then re-run with `DEPLOY_YES=1` to execute it.
 *   2. Paste the printed block (only the fields that changed in that run)
 *      back into the same entry and commit.
 *   3. Run `bun run verify:<env>` to Etherscan-verify the whole stack.
 */

export type DeployedAddresses = {
  readonly paymentToken?: `0x${string}`;
  readonly paymentTokens?: readonly `0x${string}`[];
  readonly treasury?: `0x${string}`;
  readonly commerceProxy?: `0x${string}`;
  readonly commerceImpl?: `0x${string}`;
  readonly routerProxy?: `0x${string}`;
  readonly routerImpl?: `0x${string}`;
  readonly policy?: `0x${string}`;
};

const BSC_MAINNET: DeployedAddresses = {
  paymentToken: "0xcE24439F2D9C6a2289F741120FE202248B666666", // e.g. U on BSC Mainnet
  treasury: "0x000000000000000000000000000000000000dEaD",
  commerceProxy: "0xea4daa3100a767e86fded867729ae7446476eba6",
  commerceImpl: "0xd5f9b570c96b5d67702d508c0bfb8b3b09209787",
  routerProxy: "0x51895229e12f9876011789b04f8698af06ccd6da",
  routerImpl: "0xf0cf8f47e5c035f16247ff16e9f367e477ee5007",
  policy: "0x9c01845705b3078aa2e8cff7520a6376fd766de5",
};

export const ADDRESSES: Partial<Record<string, DeployedAddresses>> = {
  bscTestnet: {
    paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", // e.g. U on BSC Testnet
    treasury: "0x1001b2C085345f388778A975648aA50bcfd0D134",
    commerceProxy: "0xa206c0517b6371c6638cd9e4a42cc9f02a33b0de",
    commerceImpl: "0x153783ddbdf5233c591965f04644b1df2d1a7815",
    routerProxy: "0xd7d36d66d2f1b608a0f943f722d27e3744f66f25",
    routerImpl: "0x40c0254610d92f1eb9c2d7d5d2114bc4c99d935e",
    policy: "0xd6a4217588f6b1f5657a92a3e94e6422ad771cea",
  },
  bscTestnetQa: {
    paymentToken: "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", // same U as bscTestnet
    paymentTokens: [
      "0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565", // U (ERC-8183)
      "0xEC1C60D64a06896Df296438c12edD14E974FDE47", // USDC
      "0x337610d27c682E347C9cD60BD4b3b107C9d34dDd", // USDT
    ],
    commerceProxy: "0x61d606db08c6acc393fd33e9c07da8f687771b6f",
    commerceImpl: "0x55c3826b39a0f671b2c3e5d0f1372cad0b911421",
    routerProxy: "0x1f31eb0183b64f57dbb1193ad9525dda27fcd02b",
    routerImpl: "0x646c43adea1bf1b39d1399e1a041095076615eb0",
    policy: "0x781c1848635dcd2c335e16d51af9d4e1112afaf1",
  },
  bsc: BSC_MAINNET,
  // In-process fork of BSC mainnet (see hardhat.config.ts) used to rehearse
  // mainnet upgrades: same registry entry as `bsc`, so a fork run reports
  // exactly what the real mainnet run will do.
  bscFork: BSC_MAINNET,
};
