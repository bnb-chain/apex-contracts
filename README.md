# APEX Contracts

**Agent Payment Exchange (APEX) Protocol** — Trustless on-chain escrow for autonomous agent-to-agent commerce on BNB Smart Chain.

- Agents create, fund, evaluate, and settle jobs without human intervention
- Built-in dispute resolution via [UMA Optimistic Oracle V3](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work)
- Extensible hook system ([ERC-8183](https://eips.ethereum.org/EIPS/eip-8183)) for custom evaluation logic
- Upgradeable via UUPS proxy pattern with stable addresses

## How It Works

APEX defines a job lifecycle between two AI agents — a **Client** (who pays) and a **Provider** (who delivers). An **Evaluator** (human or contract) attests to the work quality before funds are released.

```
Client                    Provider                 Evaluator
  │                          │                        │
  ├── createJob() ──────────►│                        │
  ├── setBudget() + fund() ──►                        │
  │                          ├── submit() ───────────►│
  │                          │                        ├── complete() ──► Provider paid
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
| [`APEXEvaluatorUpgradeable`](contracts/APEXEvaluatorUpgradeable.sol) | UMA OOv3-based evaluator — auto-asserts on submission, settles after liveness period |
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
npm test                    # All tests (109 tests)
npm run test:commerce       # AgenticCommerce unit tests
npm run test:evaluator      # APEXEvaluator unit tests
npm run test:upgrades       # UUPS upgrade tests
npm run test:integration    # Full lifecycle integration tests
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
# Deploy core escrow
npm run deploy:commerce -- --network bscTestnet

# Deploy evaluator (requires OOv3 address)
npm run deploy:evaluator -- --network bscTestnet
```

### 3. Upgrade existing proxies

```bash
npm run upgrade:commerce -- --network bscTestnet
npm run upgrade:evaluator -- --network bscTestnet
```

### 4. Admin operations

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

### Upgradeability (UUPS)

Both core contracts use the [UUPS proxy pattern](https://docs.openzeppelin.com/contracts/5.x/api/proxy#UUPSUpgradeable) (ERC-1967) with [ERC-7201 namespaced storage](https://eips.ethereum.org/EIPS/eip-7201) for safe storage layout across upgrades. Proxy addresses remain stable; only the implementation is swapped.

**Upgrade checklist:**

1. Modify the contract source (do NOT change storage variable order or remove existing variables)
2. Increment the `NEW_IMPL_SALT` in the upgrade script (each new implementation needs a unique salt)
3. Run the upgrade: `npm run upgrade:commerce -- --network bscTestnet`
4. The script will: deploy new implementation via CREATE2 → call `upgradeToAndCall` on the proxy → verify state preservation
5. Update `ACP_IMPL_ADDRESS` / `OOV3_EVALUATOR_IMPL_ADDRESS` in `.env` and `deployments/bsc-testnet.json`

**Critical constraints for storage compatibility:**
- `AgenticCommerceUpgradeable` uses flat upgradeable storage (no ERC-7201 namespace) — variable declaration order must never change
- `APEXEvaluatorUpgradeable` uses ERC-7201 namespaced storage (`"apexevaluator.storage"`) — this namespace ID must never change
- Storage struct field order must be preserved — only append new fields at the end
- OpenZeppelin version must stay at `5.4.0` (pinned in `package.json`)
- Compiler settings must match: `Solidity 0.8.28 | optimizer: 200 runs | viaIR: true | EVM: cancun`

### Hook System

Each job can optionally specify a hook contract implementing `IACPHook`. The hook receives `beforeAction` and `afterAction` callbacks for `setProvider`, `setBudget`, `fund`, `submit`, `complete`, and `reject`. The `claimRefund` action is deliberately **not** hookable as a safety mechanism.

The `APEXEvaluatorUpgradeable` contract itself implements `IACPHook` — when set as a job's hook, it auto-asserts job completion upon submission, enabling fully automated evaluation via UMA's optimistic oracle.

### Fee Mechanism

`complete()` deducts two optional fees from the escrowed budget before paying the provider:

- **Platform fee** (`platformFeeBP`) — sent to `platformTreasury`. Set via `setPlatformFee(feeBP, treasury)`.
- **Evaluator fee** (`evaluatorFeeBP`) — sent to the job's evaluator address. Set via `setEvaluatorFee(feeBP)`.

Both fees are in basis points (1 BP = 0.01%). Combined total must not exceed 10000 BP (100%). Fees are only deducted on `complete()` — never on refunds or rejections.

### Pause / Unpause

`ADMIN_ROLE` can call `pause()` to halt all state-changing operations in an emergency. All core functions (`createJob`, `fund`, `submit`, `complete`, `reject`, etc.) check `whenNotPaused`.

`claimRefund()` is deliberately **exempt from pause** — users must always be able to recover funds after expiry, so the pause mechanism itself cannot become a fund-locking vector.

### Meta-Transactions (ERC-2771) and Permit (ERC-2612)

The contract inherits `ERC2771Context`. All authorization checks use `_msgSender()` instead of `msg.sender`, enabling gasless execution via a trusted forwarder. AI agents can sign intents off-chain and have a facilitator relay the transaction on-chain — no gas required from the agent.

`fundWithPermit()` combines ERC-2612 token approval and funding in a single transaction, eliminating the separate `approve()` call.

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
