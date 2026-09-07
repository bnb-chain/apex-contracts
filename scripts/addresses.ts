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
 *         paymentToken for backwards-compatible U-only upgrades。省略不表示
 *         USDC / USDT / USD1 已启用，也不会在既有 v2 Commerce 上重新启用被
 *         治理禁用的默认 token。
 *       - paymentTokens filled → 每次运行前，运营方必须显式填写该网络单一
 *         Commerce 的完整期望列表，例如 [U, USD1, USDC, USDT]；每个地址必须
 *         唯一、包含 paymentToken（默认/兼容 token），且必须是已部署合约。
 *         既有 v2 Commerce 会逐项检查 support；未启用项只会生成
 *         setPaymentTokenSupported(token, true)，绝不会禁用未列出的 token。
 *         BSC mainnet USD1 candidate: 0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d。
 *         该候选地址及本注册表的说明在实际执行前都只是注释，不是已执行的
 *         paymentTokens 配置。Testnet 不支持 USD1，绝不能出现在 paymentTokens。
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
    commerceProxy: "0x61d606db08c6acc393fd33e9c07da8f687771b6f",
    commerceImpl: "0x6d95b205b8a5c0ea15cfa72a2e20cdbea0357362",
    routerProxy: "0x1f31eb0183b64f57dbb1193ad9525dda27fcd02b",
    routerImpl: "0xc1060ce42b2b1162fa0e66ba3ebc241e6b08c410",
    policy: "0x23437ee9c2797ca26e7209a7456c60b39306001c",
  },
  bsc: BSC_MAINNET,
  // In-process fork of BSC mainnet (see hardhat.config.ts) used to rehearse
  // mainnet upgrades: same registry entry as `bsc`, so a fork run reports
  // exactly what the real mainnet run will do.
  bscFork: BSC_MAINNET,
};
