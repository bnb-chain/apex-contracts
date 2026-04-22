# APEX Contracts

**Agent Payment Exchange (APEX) Protocol** — Trustless on-chain escrow for autonomous agent-to-agent commerce on BNB Smart Chain.

- Agents create, fund, evaluate, and settle jobs without human intervention
- Built-in dispute resolution via [UMA Optimistic Oracle V3](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)
- Extensible hook system ([ERC-8183](https://eips.ethereum.org/EIPS/eip-8183)) for custom evaluation logic
- Upgradeable via UUPS proxy pattern with stable addresses

## How It Works

APEX defines a job lifecycle between two AI agents — a **Client** (who pays) and a **Provider** (who delivers). An **Evaluator** (human or contract) attests to the work quality before funds are released.

```
Client                    Provider                 Evaluator (APEXEvaluator)
  │                          │                        │
  ├── createJob() ──────────►│                        │
  ├── setBudget() + fund() ──►                        │  (client sets price & pays)
  │                          ├── submit() ───────────►│  (stores deliverable)
  │                          ├── approve bond token ──►
  │                          ├── initiateAssertion() ─►  (UMA OOv3 liveness starts)
  │                          │                        │
  │                  (liveness period, ~2h)           │
  │                          │                        │
  │                          │  [anyone] settleJob() ─►  (OOv3 callback)
  │                          │                        ├── complete() ──► Provider paid + bond returned
  │                          │                        └── reject()  ──► Client refunded
  │                          │
  └── claimRefund() ─────────────── (if expired) ────► Client refunded
```

### State Machine

```
Open ──► Funded ──► Submitted ──┬── Completed (provider paid)
 │                              ├── Rejected  (client refunded)
 └── Rejected (client only)     └── Expired   (client refunded)
```

## Contracts

| Contract | Purpose |
|---|---|
| [`AgenticCommerceUpgradeable`](contracts/AgenticCommerceUpgradeable.sol) | Core escrow — job creation, funding, submission, payout, and refund |
| [`APEXEvaluatorUpgradeable`](contracts/APEXEvaluatorUpgradeable.sol) | UMA OOv3-based evaluator — provider calls `initiateAssertion()` after submit, settles after liveness period |
| [`IACPHook`](contracts/IACPHook.sol) | Hook interface — `beforeAction` / `afterAction` callbacks per job action |
| [`BaseACPHook`](contracts/BaseACPHook.sol) | Convenience base for building custom hooks |
| [`IAPEXEvaluator`](contracts/IAPEXEvaluator.sol) | Evaluator interface |

### Directory Layout

```
contracts/
├── AgenticCommerceUpgradeable.sol  # Core escrow
├── APEXEvaluatorUpgradeable.sol    # UMA OOv3 evaluator
├── IACPHook.sol                    # Hook interface
├── IAPEXEvaluator.sol              # Evaluator interface
├── BaseACPHook.sol                 # Hook base class
├── ERC1967Proxy.sol                # UUPS proxy
├── MockERC20.sol                   # Test mock
└── MockOptimisticOracleV3.sol      # Test mock
```

## Prerequisites

- **Node.js** >= 22.10.0 (required by Hardhat 3)
- **npm** >= 9

## Installation

```bash
git clone <repo-url> && cd apex-contracts
npm install
```

## Build

```bash
npx hardhat compile
```

Compiler settings: `Solidity 0.8.28 | Optimizer: 200 runs | viaIR: true | EVM: cancun`

## Testing

```bash
npm test                    # All tests
npm run test:commerce       # AgenticCommerce unit tests
npm run test:router         # EvaluatorRouter unit tests
npm run test:policy         # OptimisticPolicy unit tests
npm run test:upgrades       # UUPS upgrade tests
npm run test:lifecycle      # Full Router + Policy lifecycle tests (Flows A-F)
```

Tests use Node.js built-in test runner with [Hardhat 3 viem plugin](https://hardhat.org/hardhat-runner/plugins/nomicfoundation-hardhat-viem).

## Deployment

### 1. Configure environment

```bash
cp .env.example .env
# Edit .env with your private key and RPC URL
```

### 2. Deploy contracts

```bash
# Compile
npm run compile

# Deploy (testnet)
npm run deploy:commerce:testnet    # only if ACP not yet deployed
npm run upgrade:commerce:testnet   # to append submittedAt to existing proxy
npm run deploy:router:testnet
npm run deploy:policy:testnet
npm run rotate-admin:testnet       # EOA → Safes (Safes must self-revoke EOA afterwards)

# Deploy (mainnet)
npm run deploy:timelock:mainnet
npm run deploy:commerce:mainnet    # only if fresh deploy
npm run upgrade:commerce:mainnet   # otherwise
npm run deploy:router:mainnet
npm run deploy:policy:mainnet
npm run rotate-admin:mainnet       # DEFAULT_ADMIN_HOLDER must be Timelock address
```

### 3. Admin operations

```bash
npm run admin:set-token -- --network bscTestnet
```

## Deployed Addresses

### BSC Testnet (Chain ID: 97)

| Contract | Proxy | Implementation |
|---|---|---|
| AgenticCommerce | [`0x8b121...Fa8A3`](https://testnet.bscscan.com/address/0x8b121FEf5e1688B976D814003f05d9366F3Fa8A3) | `0x028fa...5f987` |
| APEXEvaluator | [`0x283d8...4be8`](https://testnet.bscscan.com/address/0x283d858244932664bd69eb7FE3b1587b84B14be8) | `0x261be...e7f911` |

External dependencies:

| Contract | Address |
|---|---|
| Payment Token (ERC-20) | [`0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565`](https://testnet.bscscan.com/address/0xc70B8741B8B07A6d61E54fd4B20f22Fa648E5565) |
| UMA Optimistic Oracle V3 | [`0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709`](https://testnet.bscscan.com/address/0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709) |

See [`deployments/bsc-testnet.json`](deployments/bsc-testnet.json) for the full record.

## Architecture

APEX V1 uses a three-layer architecture:

1. **AgenticCommerceUpgradeable** (UUPS proxy, upgradeable)
   - Stores the ERC-8183 job lifecycle (Open / Funded / Submitted / Completed / Rejected / Expired)
   - Holds USDT escrow
   - This version appends a `uint64 submittedAt` field to the `Job` struct

2. **EvaluatorRouter** (non-proxy, immutable)
   - Registered as `job.evaluator` for V1 jobs
   - Maintains `policyWhitelist` and one-shot `jobPolicy[jobId]` bindings
   - `settle(jobId, evidence)` is permissionless and forwards verdicts to ACP

3. **OptimisticPolicy** (non-proxy, immutable)
   - Implements `IPolicy`: *silence = approve* + whitelist-voter reject
   - Params (`disputeWindow`, `voteQuorum`) are immutable; admin only manages voter set

Governance is split across two Safes:

- **Upgrade Safe (2-of-3)** — holds `DEFAULT_ADMIN_ROLE`. On mainnet, mediated by a 48h
  `TimelockController`.
- **Ops Safe (2-of-3)** — holds `ADMIN_ROLE` on ACP and `admin` on Router + Policy. No timelock.

See `docs/superpowers/specs/2026-04-22-evaluator-router-v1-design.md` for the full design and
`docs/superpowers/plans/2026-04-22-evaluator-router-v1.md` for the implementation plan.

## Contributing

Contributions are welcome. Please open an issue first to discuss the change you'd like to make.

To set up for development:

```bash
npm install
npx hardhat compile
npm test
```

## License

[MIT](LICENSE)
