# ERC-8183 Compliance

> **Spec source:** [https://eips.ethereum.org/EIPS/eip-8183](https://eips.ethereum.org/EIPS/eip-8183)
> **Spec version reviewed:** 2026-02-25 Draft
> **Last reviewed:** 2026-09-16
> **Reviewer:** APEX maintainers

This document tracks how the APEX v1 implementation conforms to the current
ERC-8183 draft. It is refreshed per the "ERC-8183 Spec-Update Protocol" in
`CLAUDE.md` whenever the standard publishes a new revision.

---

## Summary

APEX v1's kernel (`AgenticCommerceUpgradeable`) satisfies **every
normative `MUST` and `SHOULD` clause** in ERC-8183 (2026-02-25 Draft)
**except one**: `fund`'s "SHALL revert if … budget is zero", which is
deliberately relaxed to support zero-price (free) jobs — see Delta 4.
The rest holds: the full 6-state machine, all eight core functions, the
`optParams`-forwarding hook data encoding, the `claimRefund` safety
carve-out, ERC-165 hook checks, and a gas-bounded hook dispatch. Five
intentional deltas are tracked below; Deltas 1–3 and 5 do not violate a
`MUST`, Delta 4 does and says so explicitly. The Router / Policy layer
sits on top of the kernel and is deliberately non-normative (the ERC
does not specify evaluators).

The latest revision (2026-09-16) records multi-token payments. The
kernel keeps a single `paymentToken` as its default and compatibility
fallback, but now also maintains an owner-curated allowlist and binds a
payment token to each job at creation. `paymentToken()` therefore no
longer describes the settlement asset of every job; `jobPaymentToken(jobId)`
does. This is recorded as Delta 5 — the spec's single-token assumption
lives in its Security Considerations, not in a normative `MUST`.

The 2026-04-28 revision landed the upgrade-audit fixes: the
kernel now upper-bounds `expiredAt` (`MAX_EXPIRY_DURATION`), guards
`submit` against expired jobs, refuses `hook == address(0)` at creation,
re-introduces an indexed `provider` topic on `JobFunded` for direct
provider-side `eth_getLogs` filtering, and persists the provider's
`deliverable` hash to the `Job` struct in `submit` so on-chain consumers
can read it directly without rebuilding state from logs (audit I05).
The first three plus the deliverable-storage addition are
spec-compatible tightenings; the indexed `provider` is a deliberate
ABI superset over the normative `JobFunded(jobId, client, amount)`
shape (see Delta 1).

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

| Spec function                                                                                                                                                                                | Our implementation                                                    | Status     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| `createJob(provider, evaluator, expiredAt, description, hook)`, provider MAY be zero, evaluator MUST be nonzero, `expiredAt` MUST be in the future                                           | `contracts/AgenticCommerceUpgradeable.sol:335` (`createJob`)          | ✅         |
| _(non-spec)_ `createJobWithToken(provider, evaluator, expiredAt, description, hook, token)` — same as `createJob` but binds an explicit allowlisted payment token                            | `contracts/AgenticCommerceUpgradeable.sol:346` (`createJobWithToken`) | ⚠️ Delta 5 |
| `setProvider(jobId, provider, optParams?)` — client-only, Open-only, provider MUST be currently zero                                                                                         | `contracts/AgenticCommerceUpgradeable.sol:410` (`setProvider`)        | ✅         |
| `setBudget(jobId, amount, optParams?)` — client OR provider                                                                                                                                  | `contracts/AgenticCommerceUpgradeable.sol:442` (`setBudget`)          | ✅         |
| `fund(jobId, expectedBudget, optParams?)` — client-only, provider MUST be set, `budget == expectedBudget` front-running guard, **nonzero budget** (spec: "SHALL revert if … budget is zero") | `contracts/AgenticCommerceUpgradeable.sol:471` (`fund`)               | ⚠️ Delta 4 |
| `submit(jobId, deliverable, optParams?)` — provider-only, Funded → Submitted, `block.timestamp < expiredAt`, persists `deliverable` to storage                                               | `contracts/AgenticCommerceUpgradeable.sol:500` (`submit`)             | ✅         |
| `complete(jobId, reason, optParams?)` — evaluator-only, Submitted → Completed                                                                                                                | `contracts/AgenticCommerceUpgradeable.sol:523` (`complete`)           | ✅         |
| `reject(jobId, reason, optParams?)` — client when Open, evaluator when Funded/Submitted                                                                                                      | `contracts/AgenticCommerceUpgradeable.sol:559` (`reject`)             | ✅         |
| `claimRefund(jobId)` — anyone after `expiredAt`, Funded/Submitted only                                                                                                                       | `contracts/AgenticCommerceUpgradeable.sol:594` (`claimRefund`)        | ✅         |

### Fees

| Clause                                                                                                            | Our implementation                                                                                        | Status |
| ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------ |
| Optional platform fee (basis points) on completion only, capped at `MAX_PLATFORM_FEE_BP = 1_000` (10%, audit I07) | `setPlatformFee` at `contracts/AgenticCommerceUpgradeable.sol:246`; fee applied in `complete` at line 539 | ✅     |
| Fee NOT deducted on refund                                                                                        | Refund paths (`reject`, `claimRefund`) transfer full `job.budget`                                         | ✅     |

### Hooks

| Clause                                                   | Our implementation                                                                                                                                                                                  | Status |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `IACPHook` interface (two functions, IERC165)            | `contracts/IACPHook.sol`                                                                                                                                                                            | ✅     |
| Hook MUST be ERC-165-verified at creation                | `ERC165Checker.supportsInterface` in `_createJob` (`AgenticCommerceUpgradeable.sol:371`)                                                                                                            | ✅     |
| `job.hook == address(0)` skips hook calls                | Early return in `_beforeHook` / `_afterHook` (`AgenticCommerceUpgradeable.sol:278, :291`); unreachable for jobs created post-2026-04-28 because `createJob` now reverts on a zero hook (audit L05). | ✅     |
| Before hooks MAY revert to block an action               | Hook reverts bubble verbatim via assembly in `_bubble` (`:302`)                                                                                                                                     | ✅     |
| After hooks MAY perform side effects / revert atomically | Same bubble semantics; after-hook reverts undo the core state change                                                                                                                                | ✅     |
| `claimRefund` MUST NOT be hookable                       | `claimRefund` (`:594`) bypasses `_beforeHook` / `_afterHook` entirely                                                                                                                               | ✅     |
| Hook gas limit (SHOULD)                                  | `HOOK_GAS_LIMIT = 1_000_000` applied via `.call{gas: ...}` (`:34, :282, :294`)                                                                                                                      | ✅     |

### Hook data encoding

Spec table (§Hooks / Data encoding) → code location in
`contracts/AgenticCommerceUpgradeable.sol`:

| Selector             | Spec encoding                                      | Code anchor                                                 | Status     |
| -------------------- | -------------------------------------------------- | ----------------------------------------------------------- | ---------- |
| `createJob`          | _(absent from spec table; see Delta 1.3)_          | `:397` `abi.encode(msg.sender, provider, evaluator)`        | ⚠️ Delta 1 |
| `createJobWithToken` | _(non-spec selector; see Delta 5)_                 | `:398` `abi.encode(msg.sender, provider, evaluator, token)` | ⚠️ Delta 5 |
| `setProvider`        | `abi.encode(address provider, bytes optParams)`    | `:422` `abi.encode(provider_, optParams)`                   | ✅         |
| `setBudget`          | `abi.encode(uint256 amount, bytes optParams)`      | `:450` `abi.encode(amount, optParams)`                      | ✅         |
| `fund`               | `optParams` (raw bytes)                            | `:483` raw `optParams` passed through                       | ✅         |
| `submit`             | `abi.encode(bytes32 deliverable, bytes optParams)` | `:507` `abi.encode(deliverable, optParams)`                 | ✅         |
| `complete`           | `abi.encode(bytes32 reason, bytes optParams)`      | `:534` `abi.encode(reason, optParams)`                      | ✅         |
| `reject`             | `abi.encode(bytes32 reason, bytes optParams)`      | `:577` `abi.encode(reason, optParams)`                      | ✅         |

### Events

The ERC lists nine events ("implementations SHOULD emit at least"). All
nine are emitted by the kernel:

| Spec event                                                  | Our implementation                                       | Status |
| ----------------------------------------------------------- | -------------------------------------------------------- | ------ |
| `JobCreated(jobId, client, provider, evaluator, expiredAt)` | `AgenticCommerceUpgradeable.sol:116` (adds `hook` field) | ✅     |
| `ProviderSet(jobId, provider)`                              | `:124`                                                   | ✅     |
| `BudgetSet(jobId, amount)`                                  | `:125`                                                   | ✅     |
| `JobFunded(jobId, client, amount)`                          | `:134` (adds `indexed provider`)                         | ✅     |
| `JobSubmitted(jobId, provider, deliverable)`                | `:135`                                                   | ✅     |
| `JobCompleted(jobId, evaluator, reason)`                    | `:136`                                                   | ✅     |
| `JobRejected(jobId, rejector, reason)`                      | `:137`                                                   | ✅     |
| `JobExpired(jobId)`                                         | `:138`                                                   | ✅     |
| `PaymentReleased(jobId, provider, amount)`                  | `:139`                                                   | ✅     |
| `Refunded(jobId, client, amount)`                           | `:140`                                                   | ✅     |

Two non-spec events accompany the payment-token allowlist (Delta 5):
`PaymentTokenSupportUpdated(token, supported)` (`:142`) and
`JobPaymentTokenBound(jobId, token)` (`:143`). The latter is emitted on
every job creation, so an indexer can resolve a job's settlement asset
from logs alone without calling `jobPaymentToken`.

### Security considerations (spec §Security Considerations)

| Clause                                           | Our implementation                                                                                                                                                                                                                                                                                                                                                                                                | Status     |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Reentrancy guard on token-transferring functions | `ReentrancyGuardTransient` + `nonReentrant` on every core function                                                                                                                                                                                                                                                                                                                                                | ✅         |
| SafeERC20 for transfers                          | `using SafeERC20 for IERC20` throughout                                                                                                                                                                                                                                                                                                                                                                           | ✅         |
| Evaluator MUST be set at creation                | `_createJob` reverts on `evaluator == address(0)` (`:367`)                                                                                                                                                                                                                                                                                                                                                        | ✅         |
| Single payment token per contract                | No longer holds. `paymentToken` (`:86`) is still set once in `initialize` and is immutable, but it is now the default and the pre-upgrade fallback rather than the contract-wide settlement asset: `_createJob` writes `_jobPaymentTokens[jobId]` (`:391`) and every value/transfer path resolves through `jobPaymentToken(jobId)` (`:402`). Tokens must be on the owner-curated allowlist (`:107`). See Delta 5. | ⚠️ Delta 5 |
| Hook gas limit (SHOULD)                          | `HOOK_GAS_LIMIT = 1_000_000`                                                                                                                                                                                                                                                                                                                                                                                      | ✅         |
| Hooks MUST NOT modify core escrow state directly | Kernel uses internal writes only; hooks receive `jobId + selector + data` and cannot call kernel state setters                                                                                                                                                                                                                                                                                                    | ✅         |

---

## Non-blocking Deltas

These are intentional differences from the exact spec text. Deltas 1–3
and 5 do not violate a `MUST`; each is either a `SHOULD` addition, a
reference-impl-only feature, an explicitly-deferred optional extension,
or a departure from a Security-Considerations assumption. Delta 4 is the
one exception: it relaxes a normative `SHALL` on `fund` to support
zero-price jobs, and is disclosed as such.

1. **ABI deviations that follow the ERC reference implementation rather
   than its normative text.** The spec document contradicts itself in
   four places; for each we deliberately track the reference
   implementation to stay compatible with the dominant ABI in the wild,
   except where doing so would silently drop information (`setProvider`
   and `fund`), in which case we follow the normative text:

- `**JobCreated` adds a non-indexed `hook` field\*\* (`:116-123`). Our
  topic0 is
  `keccak256("JobCreated(uint256,address,address,address,uint256,address)")`.
  Indexers wired to the normative 5-parameter signature will NOT
  receive this event; ref-impl-ABI indexers WILL. Removing the field
  on a future UUPS upgrade is an ABI-only, storage-safe change if
  strict normative compatibility is later required.
- `**JobFunded` adds an indexed `provider` topic\*\* (`:134`). Topic0
  becomes `keccak256("JobFunded(uint256,address,address,uint256)")`,
  which is a superset of the normative
  `JobFunded(uint256,address,uint256)` shape. The extra topic lets a
  provider's `eth_getLogs` filter pick up only the jobs assigned to
  it, without joining against `JobCreated` (audit I03). Indexers
  wired to the normative 3-parameter signature will NOT receive
  this event; ref-impl-ABI indexers (which carry `provider`) WILL.
- `**createJob` invokes `_afterHook` only\*\* (`:399`). Spec's
  Hookable table omits `createJob`; the reference implementation
  invokes a post-action hook here. We follow the reference impl
  but **deliberately omit `_beforeHook`** (audit I09): a
  `beforeAction` here would let the hook veto its own installation,
  which is not a useful security primitive (the kernel has not yet
  bound the hook so any veto is a self-DoS). Hooks observing job
  creation receive an `afterAction` callback exactly once, after
  the kernel state write commits.
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

4. **Zero-price jobs (relaxes a normative `SHALL`).** The spec's `fund`
   clause reads "SHALL revert if … budget is zero"; our kernel instead
   lets a zero-budget job reach `Funded`, skipping the escrow transfer.
   `setBudget(jobId, 0, …)` MAY be called by either the client or the
   provider (the spec puts no amount constraint on `setBudget` itself),
   and `fund` keeps every other gate: `jobHasBudget` (an explicit
   `setBudget` MUST precede `fund` — reverts `ZeroBudget` otherwise),
   `expectedBudget` front-running protection, `ProviderNotSet`, expiry.
   Safety rests on three facts: every kernel transfer site
   (`fund`/`complete`/`reject`/`claimRefund`) guards `amount > 0`, so no
   zero-value token calls occur; the Router / Policy layer never reads
   `job.budget`; and `job.budget` is immutable once the job leaves
   `Open`, so a provider always sees the final funded amount when it
   verifies the job against its signed quote off-chain before working —
   a client that zeroes a price unilaterally only buys itself a
   permanent refusal of service. Sellers opt in by quoting price 0.
   We intend to propose zero-price semantics upstream to the ERC-8183
   Draft; if the ERC adopts a different mechanism this delta will be
   revisited.

5. **Per-job payment token (departs from a Security-Considerations
   assumption).** The spec's Security Considerations assume one payment
   token per contract. The kernel now binds a token to each job at
   creation and settles that job in it. No normative `MUST`/`SHALL`
   covers this — the single-token statement is an assumption about the
   reference design, not a requirement on implementations.

   Surface: `paymentToken()` (`:86`) keeps the spec signature and stays
   immutable, but now means "default token"; `jobPaymentToken(jobId)`
   (`:402`, added to `IACP`) is the authoritative per-job asset;
   `createJobWithToken(...)` (`:346`) is a non-spec entry point that
   names the token explicitly; `initializeMultiToken(tokens)` (`:209`)
   and `setPaymentTokenSupported(token, supported)` (`:254`) maintain
   the owner-curated allowlist that gates both creation and funding.

   Safety rests on four facts. A job's token is written once in
   `_createJob` (`:391`) and never mutated, and every transfer site in
   that job's lifecycle (`fund`, `complete`, `reject`, `claimRefund`)
   resolves the same `jobPaymentToken(jobId)`, so escrow in and payout
   out are always the same asset. The kernel never aggregates balances
   across jobs, so there is no cross-token accounting to get wrong.
   `createJob` retains its exact normative signature and behaviour, so
   spec-conformant SDKs keep working and simply get the default token.
   And `jobPaymentToken` falls back to `paymentToken` when the per-job
   slot is zero, so jobs created before the upgrade are unaffected.

   The allowlist only verifies on-chain that the target address holds
   code; it cannot detect fee-on-transfer, rebasing, pausable or
   upgradeable behaviour. Vetting every token against the class
   requirements documented on `paymentToken` remains a deployer
   responsibility — see `docs/deployment.md` §4.

   Integrator impact: do not treat `paymentToken()` as the settlement
   asset of an arbitrary job; read `jobPaymentToken(jobId)` or index the
   `JobPaymentTokenBound` event. Hook authors now receive a
   `createJobWithToken` selector whose payload carries four fields
   (`client, provider, evaluator, token`) instead of three.

### Router-layer deviation (disclosed separately)

The **Router** layer deviates from one spec `SHOULD`: "Hooks SHOULD NOT be
upgradeable after a job is created." The Router is UUPS and serves as the
hook for every routed job. This is disclosed in the Router NatSpec
header, in `README.md`, and in `docs/design.md` §6 R1, and mitigated by
multisig + Timelock governance and an operational default of "never
upgrade". The kernel itself still satisfies all `MUST` clauses.

---

## Change Log

- **2026-09-16** (PR #19) — Multi-token payments. The kernel keeps a
  single immutable `paymentToken` as its default and pre-upgrade
  fallback, and adds an owner-curated allowlist plus a token bound to
  each job at creation. `IACP` gains `jobPaymentToken(jobId)`; the
  kernel gains the non-spec `createJobWithToken`, `initializeMultiToken`
  and `setPaymentTokenSupported`, and the `PaymentTokenSupportUpdated` /
  `JobPaymentTokenBound` events. `createJob` keeps its normative
  signature and resolves to the default token, so spec-conformant SDKs
  are unaffected. Recorded as Delta 5 with the full safety argument (a
  job's token is immutable and every transfer site in that job resolves
  the same one; no cross-job aggregation; zero-slot fallback keeps
  pre-upgrade jobs intact). The compliance matrix row asserting "single
  payment token per contract" is retired accordingly. Deployment note:
  `initializeMultiToken` is a mandatory step of the upgrade — skipping
  it leaves the allowlist empty and reverts `createJob` and every
  non-zero-budget `fund` with `UnsupportedPaymentToken`. No spec-version
  bump. Source anchors throughout this document refreshed against the
  post-PR line numbers.
- **2026-07-21** (PR #12) — Zero-price jobs. `setBudget` accepts
  `amount == 0` from either the client or the provider (the audit-I02
  up-front rejection is deliberately relaxed), and `fund` skips the
  escrow transfer when `job.budget == 0`, letting a free job reach
  `Funded` as a mutual opt-in. This relaxes `fund`'s normative "SHALL
  revert if … budget is zero" — recorded as Delta 4 with the full
  safety argument (all transfer sites guard `> 0`; Router / Policy
  never read `job.budget`; budget is immutable after `Open`, so
  providers verify the final funded amount against their signed quote
  before working). `jobHasBudget` still gates `fund` (`ZeroBudget`).
  No spec-version bump.
- **2026-04-28** (PR-4) — Final two informational items closed.
  Kernel: appended `bytes32 deliverable` to the `IACP.Job` struct and
  `submit` now persists the provider's deliverable hash to job storage
  in addition to the `JobSubmitted` event (audit I05). Future verifying
  policies, arbitration contracts, and on-chain reputation registries
  can read the deliverable directly via `getJob(jobId)` instead of
  reconstructing it from logs. The `Job` struct grew by one trailing
  slot — safe for first-time deployment; never reorder. Documentation:
  `paymentToken` / `initialize` / `fund` NatSpec and `README.md`'s
  pre-deploy checklist now spell out the plain-ERC-20 requirement
  (audit I01) — fee-on-transfer, rebasing, blocklist-toggling, and any
  balance-mutating tokens are out of scope; deployer-side
  responsibility, no kernel code change. `docs/design.md` §7 Open
  Items pruned: the `deliverable`-storage and FOT-token v2 candidates
  are removed (one delivered, one explicitly out of scope). No spec-
  version bump.
- **2026-04-28** (PR-3) — Final batch of audit fixes (P2). Kernel
  layer: `MAX_PLATFORM_FEE_BP = 1_000` hard-caps `setPlatformFee` at
  10% (audit I07); `setProvider` reverts with `ProviderAlreadySet`
  instead of the generic `WrongStatus` (audit I05 / error-name half).
  Router layer: `RouterStorage` appends `jobInflightCount`, bumped on
  `registerJob` and decremented on the kernel's
  `afterAction(complete | reject)` callback or — for the non-hookable
  `claimRefund` path — via the new permissionless `markExpired(jobId)`
  entry; `setCommerce` now requires `inflightJobCount() == 0` so a
  kernel switch cannot orphan in-flight escrow (audit L03). Governance
  language tightened to make the multisig + Timelock requirement
  normative `MUST` rather than advisory `SHOULD` (audit I08), and
  `createJob`'s `_afterHook`-only posture is now explicitly defended
  in Delta 1.3 (audit I09). No spec-version bump.
- **2026-04-28** (PR-1 + PR-2) — Audit fixes (BNBChain APEX Contracts
  Upgrade Audit) P0 + P1 landed. Spec-compatible kernel tightenings:
  `MAX_EXPIRY_DURATION = 365 days` upper-bounds `expiredAt`
  (`ExpiryTooLong`, audit L01); `submit` now mirrors `fund`'s
  `block.timestamp >= expiredAt` guard (audit L02); `createJob`
  rejects `hook == address(0)` with `HookRequired`, so every job has
  a real ERC-165 hook (audit L05). The spec still permits the zero
  hook (kernel skips the call), but rejecting at creation closes a
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
