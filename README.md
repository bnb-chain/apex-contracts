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

See [`docs/design.md`](./docs/design.md) for the full design document
(architecture, user flows, risks, verification matrix).

## Layout

```
contracts/   Kernel, Router, Policy, interfaces, test-only mocks/
scripts/     deploy.ts · verify.ts · fund-local.ts · export-abi.ts · addresses.ts · lib/
test/        unit/ (bun test) + e2e/ (5-flow ERC-8183 runner)
docs/        design.md · erc-8183-compliance.md · custom-policy.md · deployment.md
abis/        Slim ABI JSON for the 3 public contracts (run `bun run abis` to regenerate)
```

## Deployments

Source of truth for every deployed address:
[`scripts/addresses.ts`](./scripts/addresses.ts). The table below mirrors
that file — if the two ever disagree, `scripts/addresses.ts` wins.

### BSC Testnet (chainId 97)

Integrators only need the three proxies + the payment token. Implementation
addresses and the treasury are operational details — look them up in
[`scripts/addresses.ts`](./scripts/addresses.ts) if you need them.

| Contract                        | Address                                                                                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `AgenticCommerceUpgradeable`    | [`0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE`](https://testnet.bscscan.com/address/0xa206c0517B6371C6638CD9e4a42Cc9f02A33B0DE) |
| `EvaluatorRouterUpgradeable`    | [`0xd7d36d66d2f1b608a0f943f722d27e3744f66f25`](https://testnet.bscscan.com/address/0xd7d36d66d2f1b608a0f943f722d27e3744f66f25) |
| `OptimisticPolicy`              | [`0x4f4678d4439fec812ac7674bb3efb4c8f5fb78a6`](https://testnet.bscscan.com/address/0x4f4678d4439fec812ac7674bb3efb4c8f5fb78a6) |
| Payment token (USDC on testnet) | [`0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`](https://testnet.bscscan.com/address/0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565) |

Testnet `OptimisticPolicy` runs with a short dispute window for faster
iteration — do not assume these parameters match what a production
mainnet deployment would use.

### BSC Mainnet (chainId 56)

**Not yet officially deployed.** There is no canonical mainnet address set
maintained by this repository today. Integrators who need a mainnet
deployment today must roll their own — see
[`docs/deployment.md`](./docs/deployment.md) for the deploy + verify +
multisig-handoff runbook.

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

# terminal 2 — top up a test EOA with native coin + ERC20MinimalMock
#   (fixed defaults: 10 native coin + 10000 test tokens).
#   Env vars are one-shot CLI prefixes; do NOT add them to .env.
FUND_RECIPIENT=0x... FUND_TOKEN_ADDRESS=0x... bun run fund:local
```

`fund:local` refuses to run on `bsc` or `bscTestnet`. `ERC20MinimalMock`
is a permissionless-mint test token; never use it as a real payment asset.

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
`.env`. See [`test/e2e/README.md`](./test/e2e/README.md) for the full
balance + key matrix.

### Pre-deploy checklist

Before running `deploy:*`, verify each of the following — these are
**deployer responsibilities** and the contracts assume them silently
(audit I01 / I08):

1. **`paymentToken` is a standard ERC-20.** The kernel does not
   reconcile pre/post `balanceOf` in `fund`; it trusts that
   `safeTransferFrom(client, this, budget)` deposits exactly `budget`
   into the proxy and that the held balance does not drift between
   calls. The following classes will cause silent escrow accounting
   drift and revert at settlement:
   - fee-on-transfer / reflection / deflationary tokens,
   - rebasing / elastic-supply tokens,
   - tokens with mid-lifecycle blocklists or fee toggles,
   - any token whose `balanceOf(address)` can decrease without an
     outgoing transfer from `address`.

   Audited stablecoins on BNB Chain (USDT, USDC) are safe choices.
   Confirm against the token's source before calling `initialize`.

2. **Owner is a multisig fronted by a `TimelockController`.** Required
   delays: 48h for `AgenticCommerce`, 24h for `EvaluatorRouter`. Single-
   key ownership is a production mis-configuration; see
   [`docs/design.md`](./docs/design.md) §6 R1.
3. **Voter set on `OptimisticPolicy` has `≥ 3 × voteQuorum` members**
   under independent operational control, with 24/7 monitoring. The
   policy is non-upgradeable; rotating voters means deploying a fresh
   policy and re-whitelisting it on the Router.

### Deploy to BSC Testnet / Mainnet

```bash
cp .env.example .env          # fill BSC_TESTNET_PRIVATE_KEY + ETHERSCAN_API_KEY
bun run deploy:testnet        # first deploy, impl upgrade, OR full-stack rotation
bun run verify:testnet        # zero-arg Etherscan verify
```

**Before transferring ownership to a production multisig, read the post-deploy
checklist in [`docs/deployment.md`](./docs/deployment.md).** That file is
also the source of truth for the reuse-vs-deploy cascade rules and the
`paymentToken` rotation procedure.

## ERC-8183 deviations

See [`docs/erc-8183-compliance.md`](./docs/erc-8183-compliance.md) for the
compliance matrix and each deliberate deviation (upgradeable hook,
evaluator-only `reject`) with its mitigation.

## Security

- `ReentrancyGuardTransient` on every mutating state transition in the
  kernel and on `settle` in the router.
- Hook calls are ERC-165 gated at `createJob` and gas-limited to 1 000 000
  gas at call time (kernel bails out of its own state on hook failure).
- `claimRefund` is **never** pausable and **never** invokes hooks — it is
  the universal escape hatch for clients after `expiredAt`.
- `OptimisticPolicy` enforces `voteQuorum ≤ activeVoterCount` bidirectionally.

Full threat model: [`docs/design.md`](./docs/design.md) §6 Risks.
Please report vulnerabilities through the [BNB Chain Bug Bounty Program](https://bugbounty.bnbchain.org/).
