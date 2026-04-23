# Governance Scripts Design

**Date:** 2026-04-23  
**Status:** Approved

## Goal

Provide a complete governance script suite for the APEX v1 contract stack covering:
initial deployment post-setup, contract upgrades, parameter configuration, ownership
transfer, Timelock deployment, and Safe multisig integration — with a smooth
transition path from EOA-owned (testnet) to multisig-owned (production).

---

## Context

The existing `scripts/deploy.ts` handles first deploy and impl upgrades, but only
when the deployer EOA is the contract owner. Once ownership transfers to a
multisig, a separate governance layer is needed.

**Contracts and their governance surface:**

| Contract                     | Access control            | Owner functions                                                                                  |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `AgenticCommerceUpgradeable` | `Ownable2StepUpgradeable` | `setPlatformFee`, `pause`, `unpause`, `upgradeToAndCall`, `transferOwnership`                    |
| `EvaluatorRouterUpgradeable` | `Ownable2StepUpgradeable` | `setPolicyWhitelist`, `setCommerce`, `pause`, `unpause`, `upgradeToAndCall`, `transferOwnership` |
| `OptimisticPolicy`           | custom `admin`            | `addVoter`, `removeVoter`, `setQuorum`, `transferAdmin`, `acceptAdmin`                           |
| `TimelockController` (new)   | OZ standard               | `schedule`, `execute`, `cancel`                                                                  |

---

## Architecture

### File Layout

```
scripts/
  addresses.ts              # extended with timelockProxy + multisig fields
  deploy.ts                 # unchanged
  fund-local.ts             # unchanged
  gov/
    lib/
      config.ts             # reads addresses.ts + network, builds GovContext
      exec.ts               # execution layer: EOA / calldata / propose / dry-run
      safe.ts               # Safe SDK wrapper: proposeTransaction + printCalldata
    commerce.ts             # Commerce governance operations
    router.ts               # Router governance operations
    policy.ts               # Policy governance operations
    runbooks/
      transfer-ownership.ts # batch: commerce + router + policy → timelockProxy
      rotate-policy.ts      # deploy new Policy + whitelist + revoke old
      upgrade.ts            # deploy impl(s) + upgradeToAndCall; --commerce/--router/--all
      deploy-timelock.ts    # deploy TimelockController(delay=0)
```

### New `package.json` scripts

```
bun run gov:commerce   -- <op> [args]
bun run gov:router     -- <op> [args]
bun run gov:policy     -- <op> [args]
bun run gov:transfer-ownership [--dry-run] [--propose]
bun run gov:rotate-policy      [--dry-run] [--propose]
bun run gov:upgrade            [--dry-run] [--propose] [--commerce|--router|--all]
bun run gov:deploy-timelock
```

---

## `addresses.ts` Changes

Two new optional fields added to `DeployedAddresses`:

```ts
readonly timelockProxy?: `0x${string}`;   // TimelockController proxy
readonly multisig?: `0x${string}`;        // Gnosis Safe address
```

`multisig` is filled after Safe is deployed. `timelockProxy` is filled after
`gov:deploy-timelock` runs. Both are public on-chain addresses — safe to commit.

---

## Execution Layer (`lib/exec.ts`)

All gov scripts and runbooks construct a `CallItem[]` and pass it to `exec()`.
The execution mode is determined automatically:

```
--dry-run flag
  → connect bscTestnetFork, eth_call simulate each item
  → print gas estimate + result; exit non-zero on revert

no --dry-run, cfg.multisig empty  (EOA mode)
  → sign and send each tx with deployer, wait for confirm, print txHash

no --dry-run, cfg.multisig set, no --propose  (calldata mode)
  → print formatted "to + calldata" for each item (paste into Safe UI)

no --dry-run, cfg.multisig set, --propose
  → call Safe API Kit: single item → standard proposal;
    multiple items → MultiSend batch proposal
```

```ts
type CallItem = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  description: string;
};
```

Scripts never import ethers/viem signers directly — exec layer owns all signing.

---

## `GovContext` (`lib/config.ts`)

```ts
type GovContext = {
  cfg: DeployedAddresses;
  networkName: string;
  deployer: `0x${string}`;
  mode: "eoa" | "calldata" | "propose" | "dry-run";
  contracts: {
    commerce: CommerceContract;
    router: RouterContract;
    policy: PolicyContract | null;
    timelock: TimelockContract | null;
  };
};
```

Config reads `ADDRESSES[networkName]`, constructs typed viem contract instances,
and parses CLI flags (`--propose`, `--dry-run`, operation-specific args).

---

## `lib/safe.ts`

Thin wrapper around `@safe-global/protocol-kit` and `@safe-global/api-kit`:

- `proposeTransaction(ctx, calls)` — initialises Safe client from deployer key,
  encodes MultiSend if `calls.length > 1`, posts to Safe Transaction Service
- `printCalldata(calls)` — formats each `CallItem` as human-readable to+data block

Safe SDK is a dev dependency only; it is never imported by contracts or tests.

---

## Per-Contract Operations

### `commerce.ts`

| Operation           | Contract function                 | CLI args                                   |
| ------------------- | --------------------------------- | ------------------------------------------ |
| `setPlatformFee`    | `setPlatformFee(feeBP, treasury)` | `--fee-bp <uint>` `--treasury <addr>`      |
| `pause`             | `pause()`                         | —                                          |
| `unpause`           | `unpause()`                       | —                                          |
| `transferOwnership` | `transferOwnership(newOwner)`     | `--to <addr>` (default: cfg.timelockProxy) |

### `router.ts`

| Operation            | Contract function                    | CLI args                                   |
| -------------------- | ------------------------------------ | ------------------------------------------ |
| `setPolicyWhitelist` | `setPolicyWhitelist(policy, status)` | `--policy <addr>` `--status <true\|false>` |
| `setCommerce`        | `setCommerce(newCommerce)`           | `--commerce <addr>`                        |
| `pause`              | `pause()`                            | —                                          |
| `unpause`            | `unpause()`                          | —                                          |
| `transferOwnership`  | `transferOwnership(newOwner)`        | `--to <addr>` (default: cfg.timelockProxy) |

### `policy.ts`

| Operation       | Contract function         | CLI args                                   |
| --------------- | ------------------------- | ------------------------------------------ |
| `addVoter`      | `addVoter(voter)`         | `--voter <addr>`                           |
| `removeVoter`   | `removeVoter(voter)`      | `--voter <addr>`                           |
| `setQuorum`     | `setQuorum(quorum)`       | `--quorum <uint>`                          |
| `transferAdmin` | `transferAdmin(newAdmin)` | `--to <addr>` (default: cfg.timelockProxy) |

---

## Runbooks

### `deploy-timelock.ts`

Deploys `TimelockController` with `minDelay=0`, `proposers=[multisig]`,
`executors=[multisig]`. EOA direct send only (no Safe needed — Safe isn't
owner yet at this point). Prints address to paste into `addresses.ts`.

`minDelay=0` is intentional for testnet. On mainnet, multisig calls
`timelock.updateDelay(86400)` to activate a 24-hour delay — no redeployment
needed.

### `transfer-ownership.ts`

Transfers all contract ownership to `timelockProxy` in a single Safe Batch:

1. `commerce.transferOwnership(timelockProxy)`
2. `router.transferOwnership(timelockProxy)`
3. `policy.transferAdmin(timelockProxy)`

After execution, `timelockProxy.acceptOwnership()` (Commerce + Router) and
`timelockProxy.acceptAdmin()` (Policy) must be called. These are scheduled by
the multisig via `timelock.schedule(...)` + `timelock.execute(...)`. The runbook
prints the exact calldata for these follow-up calls.

### `rotate-policy.ts`

Policy impl address is needed before building the Safe batch:

1. Deploy new `OptimisticPolicy` — **EOA direct send** (address needed for batch)
2. Safe Batch (2 items):
   - `router.setPolicyWhitelist(newPolicy, true)`
   - `router.setPolicyWhitelist(oldPolicy, false)`

If `cfg.policy` is empty and `--old-policy` is not passed, the runbook prints
an error and exits 1 before touching the chain. Old policy revocation is skipped
only when `--skip-revoke` is explicitly passed.

### `upgrade.ts`

Supports `--commerce`, `--router`, or `--all` (default).

For each selected contract:

1. Deploy new impl — **EOA direct send** (address needed for upgradeToAndCall)
2. Safe Batch (1–2 items):
   - `commerce.upgradeToAndCall(newCommerceImpl, "0x")` _(if --commerce or --all)_
   - `router.upgradeToAndCall(newRouterImpl, "0x")` _(if --router or --all)_

Impl deployment and upgrade proposal are separate steps, always shown clearly
in console output.

---

## dry-run Mode

Connects to `bscTestnetFork` (already in `hardhat.config.ts`). For each
`CallItem`, calls `eth_call` with `from=deployer`. Output:

```
[dry-run] setPlatformFee(100, 0x1234...)
  network : bscTestnetFork
  gas     : 28,450
  result  : success ✓

[dry-run] pause()
  network : bscTestnetFork
  gas     : 21,200
  result  : success ✓
```

On revert, prints the decoded revert reason and exits with code 1, preventing
any `--propose` from being submitted.

---

## New Dependencies

```
@safe-global/protocol-kit   ^5.x   (devDependency)
@safe-global/api-kit        ^2.x   (devDependency)
```

No changes to Solidity contracts or existing test infrastructure.

---

## Success Criteria

| Scenario                     | Verification                                            |
| ---------------------------- | ------------------------------------------------------- |
| EOA mode executes            | `gov:commerce -- setPlatformFee` confirms on-chain      |
| dry-run succeeds             | `--dry-run` prints gas, no revert                       |
| dry-run blocks invalid input | bad feeBP prints revert reason, exits 1                 |
| calldata printed             | multisig set, no `--propose`: formatted to+data printed |
| Safe proposal created        | `--propose`: tx appears in Safe UI pending signatures   |
| transfer-ownership runbook   | all owner/admin = timelockProxy after execution         |
| upgrade runbook `--dry-run`  | both upgradeToAndCall simulate successfully             |
| Timelock delay=0 active      | commerce/router calls execute immediately via timelock  |
