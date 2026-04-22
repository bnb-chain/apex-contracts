# APEX Contracts — v1

APEX (Agent Payment Exchange) is an ERC-8183 Agentic Commerce Protocol
deployment coupled with a pluggable, UMA-style Optimistic evaluation policy.

This repository implements a lightweight three-layer architecture:

```
┌────────────────────┐    job.evaluator,     ┌───────────────────────┐
│                    │    job.hook           │                       │
│ AgenticCommerce    │ ──────────────────▶   │  EvaluatorRouter      │
│ Upgradeable (UUPS) │                       │  Upgradeable (UUPS)   │
│ ERC-8183 kernel    │ ◀──────────────────── │  IACPHook + admin     │
└────────────────────┘    hook callbacks     └──────────┬────────────┘
                                                        │
                                                        ▼
                                              ┌───────────────────────┐
                                              │  OptimisticPolicy     │
                                              │  (immutable)          │
                                              │  default-approve +    │
                                              │  client dispute +     │
                                              │  voter quorum reject  │
                                              └───────────────────────┘
```

- `AgenticCommerceUpgradeable` — ERC-8183 job-escrow kernel. Holds funds,
  runs the state machine, calls hooks.
- `EvaluatorRouterUpgradeable` — acts as both `job.evaluator` and `job.hook`.
  Whitelists policies, binds each registered job to a policy, and settles
  jobs by pulling a verdict from the bound policy.
- `OptimisticPolicy` — immutable policy contract. Silence within a dispute
  window auto-approves. A client dispute forces a whitelisted-voter quorum
  to reject; otherwise the job stays pending until the kernel's
  `claimRefund` escape hatch kicks in at expiry.

See `docs/design.md` for the full
design document — architecture, user flows, risks, and verification matrix.

## Layout

```
contracts/
  AgenticCommerceUpgradeable.sol   ERC-8183 kernel (UUPS, Pausable)
  EvaluatorRouterUpgradeable.sol   Routing layer (UUPS, Pausable, ERC-7201)
  OptimisticPolicy.sol             Pluggable optimistic policy (immutable)
  IACP.sol                         Router/Policy ↔ Commerce interface
  IPolicy.sol                      Router ↔ Policy interface
  IACPHook.sol                     ERC-8183 hook interface
  ERC1967Proxy.sol                 Test-helper wrapper around OZ's proxy
  mocks/                           Test-only contracts (not deployed to live networks)
    MockERC20.sol                  Test payment token
    RevertingHook.sol              Proves claimRefund is non-hookable
    AgenticCommerceV2Mock.sol      UUPS upgrade target for commerce tests
    EvaluatorRouterV2Mock.sol      UUPS upgrade target for router tests
scripts/
  deploy.ts                        One-shot stack deployment
  upgrade-commerce.ts              Upgrade the kernel impl
  upgrade-router.ts                Upgrade the router impl (emergency only)
  addresses.ts                     Hand-committed registry of deployed addresses
test/
  unit/                            Unit tests (run by `bun test`)
    helpers.ts                     Shared test fixtures
    AgenticCommerce.test.ts        Kernel state machine
    EvaluatorRouter.test.ts        Hook gating + registration
    OptimisticPolicy.test.ts       Policy admin, dispute + vote
    Lifecycle.test.ts              Integration on the in-memory chain
    Upgrades.test.ts               UUPS upgrade coverage
  e2e/                             End-to-end runner (local + BSC Testnet)
    runner.ts                      Entry point for `bun run e2e:*`
    README.md                      E2E setup + balance requirements
docs/
  design.md                        Canonical design document
  erc-8183-compliance.md           ERC-8183 compliance matrix + change log
```

## Getting started

```bash
cp .env.example .env          # fill in BSC_* keys if deploying
bun install
bun run compile
bun test                      # unit tests, ~1.5s
```

### Local development

Three terminals, one fresh node per session:

```bash
# terminal 1 — local chain (http://127.0.0.1:8545)
bun run node

# terminal 2 — deploy the stack onto that node
bun run deploy:local
#   copy the ready-to-run fund:local command printed at the bottom

# terminal 2 — top up a test EOA with native coin + MockERC20
#   (fixed defaults: 10 native coin + 10000 MockERC20).
#   Env vars are one-shot CLI prefixes; do NOT add them to .env.
FUND_RECIPIENT=0x... FUND_TOKEN_ADDRESS=0x... bun run fund:local
```

`fund:local` refuses to run on `bsc` or `bscTestnet`. MockERC20 is a
permissionless-mint test token; never use it as a real payment asset.

### End-to-end runner

A separate runner in `test/e2e/` drives all 5 ERC-8183 user flows
(silence-approve, dispute-reject, stalemate-expire, open-cancel, never-submit)
against a real chain:

```bash
# Local (requires `bun run node` in another terminal) — completes in ~15s
bun run e2e:local

# BSC Testnet — reuses live proxies + short-window Policy — completes in ~12min
bun run e2e:testnet
```

Testnet requires 3 pre-funded wallets (owner, client, provider) configured via
`.env.testnet`. See [`test/e2e/README.md`](./test/e2e/README.md) for the full
balance + key matrix.

### Deploy to BSC Testnet / Mainnet

Prerequisite — fill the pre-deploy inputs in
[`scripts/addresses.ts`](./scripts/addresses.ts) for the target network, then
commit:

```ts
export const ADDRESSES: Partial<Record<string, DeployedAddresses>> = {
  bscTestnet: {
    paymentToken: "0x...", // e.g. USDC on BSC Testnet
    treasury: "0x...", // EOA or multisig that collects platform fees
    // commerceProxy / routerProxy / policy come back from deploy stdout
  },
};
```

Then:

```bash
cp .env.example .env.testnet
# fill BSC_TESTNET_PRIVATE_KEY (and ETHERSCAN_API_KEY if you plan to verify)
bun run deploy:testnet
```

Ownership is always the **deployer** at deploy time. Paste the printed
`commerceProxy` / `routerProxy` / `policy` block back into the same
`ADDRESSES` entry and commit.

Re-running `deploy:<env>`:

- **Both `commerceProxy` and `routerProxy` already set** → the script reuses
  the existing proxies and only deploys + whitelists a fresh `OptimisticPolicy`.
  Paste the new `policy` line back into `ADDRESSES`. This path requires the
  router owner to still be the deployer; once ownership has been transferred
  to the multisig, whitelist new policies from the multisig instead.
- **Only one of the two is set** → the entry is inconsistent and the script
  errors out. Fix the registry first.
- **Neither is set** → full stack is deployed; use
  `bun run upgrade:commerce:<env>` / `bun run upgrade:router:<env>` afterwards
  to upgrade impls in place.

Upgrade scripts import addresses directly from `scripts/addresses.ts`, so
they run with zero parameters. Each run always deploys a fresh impl and
calls `upgradeToAndCall`, so only run them when the Solidity source
actually changed.

### Post-deploy ownership transfer

Deployer holds full control of Commerce / Router / Policy immediately after
deploy. Transfer to the production multisig ASAP via the two-step flow (the
multisig must accept on the second step for the change to take effect):

```solidity
// Commerce + Router use OpenZeppelin Ownable2Step
commerce.transferOwnership(multisig);
router.transferOwnership(multisig);
// ... then, signed by the multisig:
commerce.acceptOwnership();
router.acceptOwnership();

// OptimisticPolicy uses a matching custom pattern
policy.transferAdmin(multisig);
// ... signed by the multisig:
policy.acceptAdmin();
```

After the multisig has accepted ownership, it MUST:

1. Add ≥ `INITIAL_QUORUM` voters via `policy.addVoter(addr)`.
2. Whitelist any additional policies via
   `router.setPolicyWhitelist(addr, true)` (the deployer-run policy is
   whitelisted automatically before ownership handoff).

### Deployed addresses

Canonical source of truth: [`scripts/addresses.ts`](./scripts/addresses.ts).
Implementation addresses are ephemeral and not tracked — derive them from the
latest `Upgraded` event on each proxy when needed for Etherscan verification.

## ERC-8183 deviations

This deployment knowingly deviates from the spec in two places. Both are
documented and mitigated:

- **Upgradeable contracts (`SHOULD NOT` for hooks).** The Router is UUPS
  upgradeable and acts as the hook for every registered job. Mitigation:
  multisig + TimelockController; the operational default is NEVER UPGRADE.
  For policy replacement use drain-and-redeploy via `router.pause()`.
- **`reject` on Funded/Submitted is evaluator-only.** Spec allows multiple
  legitimate rejectors; this kernel deliberately narrows the surface.

See `docs/design.md §5 Contract Details` and `§6 Risks` for the full list.

## Security

- `ReentrancyGuardTransient` on every mutating state-transition in the
  kernel and on `settle` in the router.
- Hook calls are ERC-165 gated at `createJob` and gas-limited to 1 000 000
  gas at call time (kernel bails out of its own state on hook failure).
- `claimRefund` is **never** pausable and **never** invokes hooks — it is
  the universal escape hatch for clients after `expiredAt`.
- `OptimisticPolicy` enforces `voteQuorum ≤ activeVoterCount` bidirectionally
  (`setQuorum` and `removeVoter` can both revert to maintain the invariant).

Please report vulnerabilities privately to `security@apex.example`.
