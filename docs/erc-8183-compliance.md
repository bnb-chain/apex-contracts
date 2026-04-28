# ERC-8183 Compliance

> **Spec source:** [https://eips.ethereum.org/EIPS/eip-8183](https://eips.ethereum.org/EIPS/eip-8183)
> **Spec version reviewed:** 2026-02-25 Draft
> **Last reviewed:** 2026-04-28
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
carve-out, ERC-165 hook checks, and a gas-bounded hook dispatch. Three
intentional, non-blocking deltas are tracked below; none of them violate
a `MUST`. The Router / Policy layer sits on top of the kernel and is
deliberately non-normative (the ERC does not specify evaluators).

The latest revision (2026-04-28) lands the upgrade-audit fixes: the
kernel now upper-bounds `expiredAt` (`MAX_EXPIRY_DURATION`), guards
`submit` against expired jobs, refuses `hook == address(0)` at creation,
and re-introduces an indexed `provider` topic on `JobFunded` for direct
provider-side `eth_getLogs` filtering. The first three are
spec-compatible tightenings; the last is a deliberate ABI superset over
the normative `JobFunded(jobId, client, amount)` shape (see Delta 1).

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
| `createJob(provider, evaluator, expiredAt, description, hook)`, provider MAY be zero, evaluator MUST be nonzero, `expiredAt` MUST be in the future | `contracts/AgenticCommerceUpgradeable.sol:248` (`createJob`)   | ✅     |
| `setProvider(jobId, provider, optParams?)` — client-only, Open-only, provider MUST be currently zero                                               | `contracts/AgenticCommerceUpgradeable.sol:285` (`setProvider`) | ✅     |
| `setBudget(jobId, amount, optParams?)` — client OR provider, `amount > 0`                                                                          | `contracts/AgenticCommerceUpgradeable.sol:313` (`setBudget`)   | ✅     |
| `fund(jobId, expectedBudget, optParams?)` — client-only, provider MUST be set, `budget == expectedBudget` front-running guard, nonzero budget      | `contracts/AgenticCommerceUpgradeable.sol:333` (`fund`)        | ✅     |
| `submit(jobId, deliverable, optParams?)` — provider-only, Funded → Submitted, `block.timestamp < expiredAt`                                        | `contracts/AgenticCommerceUpgradeable.sol:358` (`submit`)      | ✅     |
| `complete(jobId, reason, optParams?)` — evaluator-only, Submitted → Completed                                                                      | `contracts/AgenticCommerceUpgradeable.sol:376` (`complete`)    | ✅     |
| `reject(jobId, reason, optParams?)` — client when Open, evaluator when Funded/Submitted                                                            | `contracts/AgenticCommerceUpgradeable.sol:411` (`reject`)      | ✅     |
| `claimRefund(jobId)` — anyone after `expiredAt`, Funded/Submitted only                                                                             | `contracts/AgenticCommerceUpgradeable.sol:445` (`claimRefund`) | ✅     |

### Fees

| Clause                                                  | Our implementation                                                                                        | Status |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| Optional platform fee (basis points) on completion only | `setPlatformFee` at `contracts/AgenticCommerceUpgradeable.sol:175`; fee applied in `complete` at line 376 | ✅     |
| Fee NOT deducted on refund                              | Refund paths (`reject`, `claimRefund`) transfer full `job.budget`                                         | ✅     |

### Hooks

| Clause                                                   | Our implementation                                                                                                                                                                                | Status |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `IACPHook` interface (two functions, IERC165)            | `contracts/IACPHook.sol`                                                                                                                                                                          | ✅     |
| Hook MUST be ERC-165-verified at creation                | `ERC165Checker.supportsInterface` in `createJob` (`AgenticCommerceUpgradeable.sol:259`)                                                                                                           | ✅     |
| `job.hook == address(0)` skips hook calls                | Early return in `_beforeHook` / `_afterHook` (`AgenticCommerceUpgradeable.sol:195-217`); unreachable for jobs created post-2026-04-28 because `createJob` now reverts on a zero hook (audit L05). | ✅     |
| Before hooks MAY revert to block an action               | Hook reverts bubble verbatim via assembly in `_bubble` (`:220`)                                                                                                                                   | ✅     |
| After hooks MAY perform side effects / revert atomically | Same bubble semantics; after-hook reverts undo the core state change                                                                                                                              | ✅     |
| `claimRefund` MUST NOT be hookable                       | `claimRefund` (`:445`) bypasses `_beforeHook` / `_afterHook` entirely                                                                                                                             | ✅     |
| Hook gas limit (SHOULD)                                  | `HOOK_GAS_LIMIT = 1_000_000` applied via `.call{gas: ...}` (`:34, :200, :212`)                                                                                                                    | ✅     |

### Hook data encoding

Spec table (§Hooks / Data encoding) → code location in
`contracts/AgenticCommerceUpgradeable.sol`:

| Selector      | Spec encoding                                      | Code anchor                                 | Status |
| ------------- | -------------------------------------------------- | ------------------------------------------- | ------ |
| `setProvider` | `abi.encode(address provider, bytes optParams)`    | `:297` `abi.encode(provider_, optParams)`   | ✅     |
| `setBudget`   | `abi.encode(uint256 amount, bytes optParams)`      | `:322` `abi.encode(amount, optParams)`      | ✅     |
| `fund`        | `optParams` (raw bytes)                            | `:341` raw `optParams` passed through       | ✅     |
| `submit`      | `abi.encode(bytes32 deliverable, bytes optParams)` | `:365` `abi.encode(deliverable, optParams)` | ✅     |
| `complete`    | `abi.encode(bytes32 reason, bytes optParams)`      | `:386` `abi.encode(reason, optParams)`      | ✅     |
| `reject`      | `abi.encode(bytes32 reason, bytes optParams)`      | `:428` `abi.encode(reason, optParams)`      | ✅     |

### Events

The ERC lists nine events ("implementations SHOULD emit at least"). All
nine are emitted by the kernel:

| Spec event                                                  | Our implementation                                      | Status |
| ----------------------------------------------------------- | ------------------------------------------------------- | ------ |
| `JobCreated(jobId, client, provider, evaluator, expiredAt)` | `AgenticCommerceUpgradeable.sol:79` (adds `hook` field) | ✅     |
| `ProviderSet(jobId, provider)`                              | `:87`                                                   | ✅     |
| `BudgetSet(jobId, amount)`                                  | `:88`                                                   | ✅     |
| `JobFunded(jobId, client, amount)`                          | `:97` (adds `indexed provider`)                         | ✅     |
| `JobSubmitted(jobId, provider, deliverable)`                | `:98`                                                   | ✅     |
| `JobCompleted(jobId, evaluator, reason)`                    | `:99`                                                   | ✅     |
| `JobRejected(jobId, rejector, reason)`                      | `:100`                                                  | ✅     |
| `JobExpired(jobId)`                                         | `:101`                                                  | ✅     |
| `PaymentReleased(jobId, provider, amount)`                  | `:102`                                                  | ✅     |
| `Refunded(jobId, client, amount)`                           | `:103`                                                  | ✅     |

### Security considerations (spec §Security Considerations)

| Clause                                           | Our implementation                                                                                             | Status |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------ |
| Reentrancy guard on token-transferring functions | `ReentrancyGuardTransient` + `nonReentrant` on every core function                                             | ✅     |
| SafeERC20 for transfers                          | `using SafeERC20 for IERC20` throughout                                                                        | ✅     |
| Evaluator MUST be set at creation                | `createJob` reverts on `evaluator == address(0)` (`:255`)                                                      | ✅     |
| Single payment token per contract                | `paymentToken` set once in `initialize`; no per-job token                                                      | ✅     |
| Hook gas limit (SHOULD)                          | `HOOK_GAS_LIMIT = 1_000_000`                                                                                   | ✅     |
| Hooks MUST NOT modify core escrow state directly | Kernel uses internal writes only; hooks receive `jobId + selector + data` and cannot call kernel state setters | ✅     |

---

## Non-blocking Deltas

These are intentional differences from the exact spec text. None of them
violate a `MUST`; each is either a `SHOULD` addition, a reference-impl-only
feature, or an explicitly-deferred optional extension.

1. **ABI deviations that follow the ERC reference implementation rather
   than its normative text.** The spec document contradicts itself in
   four places; for each we deliberately track the reference
   implementation to stay compatible with the dominant ABI in the wild,
   except where doing so would silently drop information (`setProvider`
   and `fund`), in which case we follow the normative text:

- `**JobCreated` adds a non-indexed `hook` field\*\* (`:79-86`). Our
  topic0 is
  `keccak256("JobCreated(uint256,address,address,address,uint256,address)")`.
  Indexers wired to the normative 5-parameter signature will NOT
  receive this event; ref-impl-ABI indexers WILL. Removing the field
  on a future UUPS upgrade is an ABI-only, storage-safe change if
  strict normative compatibility is later required.
- `**JobFunded` adds an indexed `provider` topic\*\* (`:89`). Topic0
  becomes `keccak256("JobFunded(uint256,address,address,uint256)")`,
  which is a superset of the normative
  `JobFunded(uint256,address,uint256)` shape. The extra topic lets a
  provider's `eth_getLogs` filter pick up only the jobs assigned to
  it, without joining against `JobCreated` (audit I03). Indexers
  wired to the normative 3-parameter signature will NOT receive
  this event; ref-impl-ABI indexers (which carry `provider`) WILL.
- `**createJob` invokes `_afterHook`\*\* (`:280`) despite the spec's
  Hookable table omitting `createJob`. Mirrors the reference
  implementation.
- `**setProvider` / `fund` match the normative text, not the
  reference implementation.\*\* Our selectors are
  `setProvider(uint256,address,bytes)` and
  `fund(uint256,uint256,bytes)`; the reference impl drops
  `optParams` from `setProvider` and drops `expectedBudget` from
  `fund`. SDKs generated from the normative ABI call our kernel
  successfully; SDKs generated from the reference-impl ABI will
  revert with "function selector not found" on those two functions.
  Keeping the normative form is deliberate (`expectedBudget`
  provides front-running protection that the ref impl omits).

2. **Optional reference-impl features not adopted.** The 2026-02-25
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

3. **Optional extensions not adopted.** ERC-8183 §Extensions introduces
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

- **2026-04-28** — Audit fixes (BNBChain APEX Contracts Upgrade Audit)
  landed. Spec-compatible kernel tightenings: `MAX_EXPIRY_DURATION = 365
days` upper-bounds `expiredAt` (`ExpiryTooLong`, audit L01); `submit`
  now mirrors `fund`'s `block.timestamp >= expiredAt` guard (audit L02);
  `createJob` rejects `hook == address(0)` with `HookRequired`, so every
  job has a real ERC-165 hook (audit L05). The spec still permits the
  zero hook (kernel skips the call), but rejecting at creation closes a
  silent-bypass class. **`JobFunded` regains an `indexed provider`
  topic** (audit I03), reverting the 2026-04-22 alignment with the
  normative 3-parameter shape; the topic0 change is documented as
  Delta 1.2. The kernel still satisfies every normative `MUST`/`SHOULD`;
  no spec-version bump.
- **2026-04-22** — `JobFunded` event aligned to normative spec
  signature `JobFunded(jobId, client, amount)` (the extra `provider`
  field is dropped; `provider` is still resolvable via `getJob` or the
  indexed `JobCreated`). Deltas renumbered from four to three; explicit
  indexer / SDK impact notes added for the remaining `JobCreated` hook
  field and the `setProvider` / `fund` selector divergence. Re-reviewed
  against ERC-8183 2026-02-25 Draft (same spec version). _Reverted on
  2026-04-28; see entry above._
- **2026-04-22** — Initial review against ERC-8183 2026-02-25 Draft. Full
  normative compliance confirmed; four non-blocking deltas recorded. No
  code changes required.
