# ERC-8183 Compliance

> **Spec source:** <https://eips.ethereum.org/EIPS/eip-8183>
> **Spec version reviewed:** 2026-02-25 Draft
> **Last reviewed:** 2026-04-22
> **Reviewer:** APEX maintainers

This document tracks how the APEX v1 implementation conforms to the current
ERC-8183 draft. It is refreshed per the "ERC-8183 Spec-Update Protocol" in
`CLAUDE.md` whenever the standard publishes a new revision.

---

## Summary

APEX v1's kernel (`AgenticCommerceUpgradeable`) satisfies **every
normative `MUST` and `SHOULD` clause** in ERC-8183 (2026-02-25 Draft),
including the full 6-state machine, all eight core functions, the
`optParams`-forwarding hook data encoding, the `claimRefund` safety
carve-out, ERC-165 hook checks, and a gas-bounded hook dispatch. Four
intentional, non-blocking deltas are tracked below; none of them violate
a `MUST`. The Router / Policy layer sits on top of the kernel and is
deliberately non-normative (the ERC does not specify evaluators).

---

## Detail Items

Every row below links the spec clause to our implementation. Code anchors
use `file:line` against the repository as of `Last reviewed` above.

### State machine

| Clause                                                      | Our implementation                                              | Status |
| ----------------------------------------------------------- | --------------------------------------------------------------- | ------ |
| 6 states `Open/Funded/Submitted/Completed/Rejected/Expired` | `contracts/IACP.sol:12` `enum JobStatus { ... }`                | ✅     |
| Allowed transitions (spec §State Machine)                   | Enforced by status guards in each core function; see rows below | ✅     |

### Core functions

| Spec function                                                                                                                                      | Our implementation                                             | Status |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------ |
| `createJob(provider, evaluator, expiredAt, description, hook)`, provider MAY be zero, evaluator MUST be nonzero, `expiredAt` MUST be in the future | `contracts/AgenticCommerceUpgradeable.sol:215` (`createJob`)   | ✅     |
| `setProvider(jobId, provider, optParams?)` — client-only, Open-only, provider MUST be currently zero                                               | `contracts/AgenticCommerceUpgradeable.sol:251` (`setProvider`) | ✅     |
| `setBudget(jobId, amount, optParams?)` — client OR provider                                                                                        | `contracts/AgenticCommerceUpgradeable.sol:274` (`setBudget`)   | ✅     |
| `fund(jobId, expectedBudget, optParams?)` — client-only, provider MUST be set, `budget == expectedBudget` front-running guard, nonzero budget      | `contracts/AgenticCommerceUpgradeable.sol:293` (`fund`)        | ✅     |
| `submit(jobId, deliverable, optParams?)` — provider-only, Funded → Submitted                                                                       | `contracts/AgenticCommerceUpgradeable.sol:313` (`submit`)      | ✅     |
| `complete(jobId, reason, optParams?)` — evaluator-only, Submitted → Completed                                                                      | `contracts/AgenticCommerceUpgradeable.sol:329` (`complete`)    | ✅     |
| `reject(jobId, reason, optParams?)` — client when Open, evaluator when Funded/Submitted                                                            | `contracts/AgenticCommerceUpgradeable.sol:364` (`reject`)      | ✅     |
| `claimRefund(jobId)` — anyone after `expiredAt`, Funded/Submitted only                                                                             | `contracts/AgenticCommerceUpgradeable.sol:398` (`claimRefund`) | ✅     |

### Fees

| Clause                                                  | Our implementation                                                                                        | Status |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| Optional platform fee (basis points) on completion only | `setPlatformFee` at `contracts/AgenticCommerceUpgradeable.sol:146`; fee applied in `complete` at line 329 | ✅     |
| Fee NOT deducted on refund                              | Refund paths (`reject`, `claimRefund`) transfer full `job.budget`                                         | ✅     |

### Hooks

| Clause                                                   | Our implementation                                                                      | Status |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------ |
| `IACPHook` interface (two functions, IERC165)            | `contracts/IACPHook.sol`                                                                | ✅     |
| Hook MUST be ERC-165-verified at creation                | `ERC165Checker.supportsInterface` in `createJob` (`AgenticCommerceUpgradeable.sol:224`) | ✅     |
| `job.hook == address(0)` skips hook calls                | Early return in `_beforeHook` / `_afterHook` (`AgenticCommerceUpgradeable.sol:166-189`) | ✅     |
| Before hooks MAY revert to block an action               | Hook reverts bubble verbatim via assembly in `_bubble` (`:191`)                         | ✅     |
| After hooks MAY perform side effects / revert atomically | Same bubble semantics; after-hook reverts undo the core state change                    | ✅     |
| `claimRefund` MUST NOT be hookable                       | `claimRefund` (`:398`) bypasses `_beforeHook` / `_afterHook` entirely                   | ✅     |
| Hook gas limit (SHOULD)                                  | `HOOK_GAS_LIMIT = 1_000_000` applied via `.call{gas: ...}` (`:34, :171, :183`)          | ✅     |

### Hook data encoding

Spec table (§Hooks / Data encoding) → code location in
`contracts/AgenticCommerceUpgradeable.sol`:

| Selector      | Spec encoding                                      | Code anchor                                 | Status |
| ------------- | -------------------------------------------------- | ------------------------------------------- | ------ |
| `setProvider` | `abi.encode(address provider, bytes optParams)`    | `:263` `abi.encode(provider_, optParams)`   | ✅     |
| `setBudget`   | `abi.encode(uint256 amount, bytes optParams)`      | `:282` `abi.encode(amount, optParams)`      | ✅     |
| `fund`        | `optParams` (raw bytes)                            | `:303` raw `optParams` passed through       | ✅     |
| `submit`      | `abi.encode(bytes32 deliverable, bytes optParams)` | `:319` `abi.encode(deliverable, optParams)` | ✅     |
| `complete`    | `abi.encode(bytes32 reason, bytes optParams)`      | `:339` `abi.encode(reason, optParams)`      | ✅     |
| `reject`      | `abi.encode(bytes32 reason, bytes optParams)`      | `:381` `abi.encode(reason, optParams)`      | ✅     |

### Events

The ERC lists nine events ("implementations SHOULD emit at least"). All
nine are emitted by the kernel:

| Spec event                                                  | Our implementation                                      | Status |
| ----------------------------------------------------------- | ------------------------------------------------------- | ------ |
| `JobCreated(jobId, client, provider, evaluator, expiredAt)` | `AgenticCommerceUpgradeable.sol:73` (adds `hook` field) | ✅     |
| `ProviderSet(jobId, provider)`                              | `:81`                                                   | ✅     |
| `BudgetSet(jobId, amount)`                                  | `:82`                                                   | ✅     |
| `JobFunded(jobId, client, amount)`                          | `:83` (adds `provider` field — see delta 1)             | ✅     |
| `JobSubmitted(jobId, provider, deliverable)`                | `:84`                                                   | ✅     |
| `JobCompleted(jobId, evaluator, reason)`                    | `:85`                                                   | ✅     |
| `JobRejected(jobId, rejector, reason)`                      | `:86`                                                   | ✅     |
| `JobExpired(jobId)`                                         | `:87`                                                   | ✅     |
| `PaymentReleased(jobId, provider, amount)`                  | `:88`                                                   | ✅     |
| `Refunded(jobId, client, amount)`                           | `:89`                                                   | ✅     |

### Security considerations (spec §Security Considerations)

| Clause                                           | Our implementation                                                                                             | Status |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------ |
| Reentrancy guard on token-transferring functions | `ReentrancyGuardTransient` + `nonReentrant` on every core function                                             | ✅     |
| SafeERC20 for transfers                          | `using SafeERC20 for IERC20` throughout                                                                        | ✅     |
| Evaluator MUST be set at creation                | `createJob` reverts on `evaluator == address(0)` (`:222`)                                                      | ✅     |
| Single payment token per contract                | `paymentToken` set once in `initialize`; no per-job token                                                      | ✅     |
| Hook gas limit (SHOULD)                          | `HOOK_GAS_LIMIT = 1_000_000`                                                                                   | ✅     |
| Hooks MUST NOT modify core escrow state directly | Kernel uses internal writes only; hooks receive `jobId + selector + data` and cannot call kernel state setters | ✅     |

---

## Non-blocking Deltas

These are intentional differences from the exact spec text. None of them
violate a `MUST`; each is either a `SHOULD` addition, a reference-impl-only
feature, or an explicitly-deferred optional extension.

1. **`JobFunded` carries an extra `provider` field.**
   Spec event signature is `JobFunded(jobId, client, amount)`. We emit
   `JobFunded(jobId, client, provider, amount)` at
   `contracts/AgenticCommerceUpgradeable.sol:83`. Spec text uses "SHOULD
   emit at least" so additional indexed fields are permitted. Downstream
   indexers/SDKs compiled against the stock ABI decode the extra topic
   without losing information.

2. **`createJob` invokes `_afterHook`, though the spec's Hookable table
   does not list `createJob`.** See `contracts/AgenticCommerceUpgradeable.sol:246`.
   This mirrors the behaviour of the ERC's reference implementation
   (which also invokes `afterAction` on `createJob` despite the
   normative Hookable table omitting it). Our kernel follows the
   reference impl's behaviour to maximise hook compatibility.

3. **Optional reference-impl features not adopted.** The 2026-02-25
   reference implementation adds `evaluatorFeeBP` and `whitelistedHooks`
   (with `HookNotWhitelisted`). These are not in normative spec text; we
   intentionally skip them:
   - `evaluatorFeeBP`: our evaluator is the Router, which has no economic
     incentive to collect a cut in v1. If this changes, add as a new
     storage slot on a UUPS upgrade.
   - `whitelistedHooks`: ERC-165 verification at creation time + the fact
     that the Router is our canonical hook are sufficient in v1. Client-
     supplied custom hooks are disabled de-facto (every routed job uses
     the Router; bespoke hooks would require a parallel code path).

4. **Optional extensions not adopted.** ERC-8183 §Extensions introduces
   two non-normative interop patterns:
   - **ERC-8004 Reputation interop.** Not implemented. Future work: emit
     reputation signals from a dedicated hook or policy, keeping the
     kernel unchanged. Tracked in `docs/design.md` §7.
   - **ERC-2771 meta-transactions / x402.** Not implemented. The kernel's
     authorisation checks use `msg.sender` rather than `_msgSender()`.
     If introduced, it requires a v2 kernel with `ERC2771Context` and a
     storage-layout audit.

### Router-layer deviation (disclosed separately)

The **Router** layer deviates from one spec `SHOULD`: "Hooks SHOULD NOT be
upgradeable after a job is created." The Router is UUPS and serves as the
hook for every routed job. This is disclosed in the Router NatSpec
header, in `README.md`, and in `docs/design.md` §6 R1, and mitigated by
multisig + Timelock governance and an operational default of "never
upgrade". The kernel itself still satisfies all `MUST` clauses.

---

## Change Log

- **2026-04-22** — Initial review against ERC-8183 2026-02-25 Draft. Full
  normative compliance confirmed; four non-blocking deltas recorded. No
  code changes required.
