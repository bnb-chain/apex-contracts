# APEX v1 · Design

> Status: DRAFT · Author: BNB Chain · Last updated: 2026-04-28
>
> Authoritative design document for APEX v1. It reflects the current
> on-chain code and is updated whenever behaviour changes. ERC-8183
> conformance is tracked separately in `docs/erc-8183-compliance.md`.

---

## 1 · Goals

Three decoupled layers:

1. **`AgenticCommerceUpgradeable`** — ERC-8183 kernel. UUPS-upgradeable.
   Lightweight: retains the full normative ERC-8183 surface and drops every
   non-spec feature (meta-transactions, permit, role-based access control,
   hook whitelist, evaluator fee).
2. **`EvaluatorRouterUpgradeable`** — routing layer. UUPS-upgradeable.
   Acts simultaneously as the `job.evaluator` and `job.hook` for every job
   registered with it. Maintains `jobId → policy` and pulls verdicts from
   policies on demand.
3. **`OptimisticPolicy`** — reference policy. Immutable (non-upgradeable).
   Default-approve; the client MAY `dispute`; whitelisted voters MAY
   `voteReject`; the Router's permissionless `settle()` path applies the
   verdict.

---

## 2 · Architecture

```
┌────────────────────────────────────────────────────────┐
│ AgenticCommerceUpgradeable        (UUPS)               │
│  - Full ERC-8183 kernel                                │
│  - 6 states · 8 core functions · hook support          │
│  - Ownable2Step + Pausable                             │
└───────────────┬────────────────────────────────────────┘
                │ job.evaluator == router
                │ job.hook      == router
                │ commerce ──► afterAction(SUBMIT) ──► router
                ▼
┌────────────────────────────────────────────────────────┐
│ EvaluatorRouterUpgradeable        (UUPS)               │
│  - IACPHook (submit notification goes through here)    │
│  - registerJob(jobId, policy)                          │
│  - settle(jobId, evidence) → pulls verdict from policy │
│  - Ownable2Step + ERC-7201 namespaced storage          │
└───────────────┬────────────────────────────────────────┘
                │ router ──► policy.onSubmitted()  (once, at submit)
                │ router ──► policy.check()        (every settle)
                ▼
┌────────────────────────────────────────────────────────┐
│ IPolicy                                                │
│  - onSubmitted(jobId, deliverable, optParams)          │
│  - check(jobId, evidence) → (verdict, reason)          │
└───────────────┬────────────────────────────────────────┘
                │ implemented by
                ▼
┌────────────────────────────────────────────────────────┐
│ OptimisticPolicy                  (immutable)          │
│  - Client → dispute(jobId)                             │
│  - Voter  → voteReject(jobId)                          │
│  - Router → check() → Pending / Approve / Reject       │
│  - Admin  → addVoter / removeVoter / setQuorum         │
│  - Admin  → transferAdmin / acceptAdmin (two-step)     │
└────────────────────────────────────────────────────────┘
```

### Why three layers

- **Commerce** is the protocol layer. It stays minimal and compliant so
  off-chain agents, wallets and indexers can treat it as a standard
  ERC-8183 node.
- **Router** is the orchestration layer. It is the only external address
  the kernel sees; policies can be swapped behind the Router without the
  kernel noticing. It also carries hook duties, so individual policies do
  not need to implement `IACPHook`.
- **Policy** is the strategy layer. Per-job pluggable. Each policy has its
  own rules, voter set, window configuration and failure modes.

---

## 3 · Roles

| Role               | Permissions                                                                       | Typical holder |
| ------------------ | --------------------------------------------------------------------------------- | -------------- |
| **Commerce Owner** | `setPlatformFee` (≤ 10%), `pause`, UUPS upgrade                                   | Multisig       |
| **Router Owner**   | `setPolicyWhitelist`, `setCommerce` (paused + drained), `pause`, UUPS upgrade     | Multisig       |
| **Policy Admin**   | `addVoter`, `removeVoter`, `setQuorum`, `transferAdmin`                           | Per-policy     |
| **Voter**          | `voteReject(jobId)`                                                               | Whitelist addr |
| **Client**         | `createJob`, `setBudget`, `fund`, `registerJob`, `dispute`                        | 1 per job      |
| **Provider**       | `submit`, `settle` (permissionless but usually provider)                          | 1 per job      |
| **Anyone**         | `claimRefund` (after expiry), `router.markExpired` (closes the bookkeeping after) | —              |

---

## 4 · User Flows

### 4.1 · One-time deployment

```
CommerceOwner
  1. Deploy Commerce proxy
     commerce.initialize(paymentToken, treasury, commerceOwner)
  2. commerce.setPlatformFee(500, treasury)             // optional 5% platform fee

RouterOwner
  3. Deploy Router proxy
     router.initialize(commerce, routerOwner)

PolicyAdmin
  4. Deploy OptimisticPolicy(commerce, router, admin, disputeWindow, initialQuorum)
  5. policy.addVoter(voter1)
  6. policy.addVoter(voter2)
  7. policy.addVoter(voter3)                             // ≥ quorum, more recommended

RouterOwner
  8. router.setPolicyWhitelist(policy, true)
```

> The canonical one-shot deploy is `scripts/deploy.ts`. Ownership initially
> lands on the deployer; hand it to a multisig via `transferOwnership` /
> `transferAdmin` as printed by the script.

### 4.2 · Flow A — Happy Path (silence approves)

```
Day 0  │ Client
       │   ├─ commerce.createJob(provider, evaluator = router,
       │   │                      expiredAt = now + 30d, description,
       │   │                      hook = router)                 → jobId
       │   ├─ router.registerJob(jobId, policy)
       │   ├─ commerce.setBudget(jobId, 100 USDC, "")
       │   ├─ USDC.approve(commerce, 100)
       │   └─ commerce.fund(jobId, 100, "")                      [Funded]
       │
Day 1  │ Provider
       │   └─ commerce.submit(jobId, deliverableHash, optParams)
       │        ├─ commerce → router.afterAction(SUBMIT)
       │        └─ router   → policy.onSubmitted(jobId, deliverable, optParams)
       │             └─ submittedAt[jobId] = Day 1               [Submitted]
       │
Day 1-4│ Client inspects the deliverable and takes no action
       │
Day 4  │ Anyone (typically Provider, to collect payment)
       │   └─ router.settle(jobId, "")
       │        ├─ policy.check() → (Approve, REASON_APPROVED)
       │        └─ commerce.complete(jobId, reason, "")          [Completed]
       │             ├─  5 USDC → treasury  (platform fee)
       │             └─ 95 USDC → Provider ✅
```

### 4.3 · Flow B — Disputed and Rejected (quorum reached)

```
Day 0-1 │ … same as Flow A (createJob → fund → submit)
        │   submittedAt[jobId] = Day 1
        │
Day 2   │ Client (unhappy with the deliverable)
        │   └─ policy.dispute(jobId)                [disputed = true]
        │
Day 2-4 │ Voter A → policy.voteReject(jobId)         rejectVotes = 1
        │ Voter B → policy.voteReject(jobId)         rejectVotes = 2
        │ Voter C → policy.voteReject(jobId)         rejectVotes = 3 (= quorum)
        │
Day 4   │ Anyone (typically Client)
        │   └─ router.settle(jobId, "")
        │        ├─ policy.check() → (Reject, REASON_REJECTED)
        │        └─ commerce.reject(jobId, reason, "")           [Rejected]
        │             └─ 100 USDC → Client ✅
```

> Rule 1 (`disputed && rejectVotes ≥ snapshot quorum → Reject`) does
> **not** require `disputeWindow` to elapse first. Once quorum is
> reached, `settle` can reject immediately. The "snapshot quorum" is the
> value of `voteQuorum` recorded at the time `dispute()` was called —
> later admin updates do not change the rejection threshold for a
> dispute already in flight (audit L08).

### 4.4 · Flow C — Disputed stalemate → race (auto-approve OR Expired)

```
Day 0-1  │ … same as Flow A (expiredAt = Day 30, disputeWindow = 3d)
Day 2    │ Client disputes
Day 2-5  │ Only 1 voter casts voteReject (quorum = 3, never reached)

Day 5    │ disputeWindow elapses with quorum unreached.
         │ policy.check() falls through to the default-approve branch:
         │   (Approve, REASON_APPROVED)        ← audit H01: silence by
         │                                       voters approves regardless
         │                                       of whether dispute was raised
Day 5-30 │ Race window:
         │   Anyone (typically Provider) → router.settle(jobId, "")
         │     → commerce.complete(jobId, ...)                  [Completed]
         │     → 95 USDC → Provider ✅ (5% fee → treasury)
         │ OR
         │   Anyone (typically Client)  → commerce.claimRefund(jobId)
         │     → 100 USDC → Client ✅                            [Expired]
         │
         │ Whoever moves first wins. Providers MUST settle before
         │ expiredAt to collect; otherwise the client can refund.
```

> Rationale for the auto-approve fall-through (audit H01): without it,
> a zero-cost `dispute()` would pin every legitimately submitted job at
> PENDING forever, letting the client recover the escrow at expiry while
> the provider receives nothing. Treating voter silence as approval —
> identical to the undisputed path — restores the optimistic game-
> theoretic balance: a dispute is only effective when voters back it up
> within the window.

### 4.5 · Flow D — Cancel while Open

```
Day 0 │ Client createJob → setBudget → (not funded yet)
Day 0 │ Client
      │   └─ commerce.reject(jobId, reason, "")                  [Rejected]
      │      (Open state client reject; no escrow, no refund)
```

### 4.6 · Flow E — Funded but provider never submits

```
Day 0  │ Client fund                                              [Funded]
Day 0-30│ Provider never submits
Day 30 │ Anyone → commerce.claimRefund(jobId)                    [Expired]
       │    100 USDC → Client ✅
       │
       │ (Router drain bookkeeping, audit L03)
       │ Anyone → router.markExpired(jobId)
       │    jobInflightCount−−
       │    jobPolicy[jobId] = 0
```

> `claimRefund` is intentionally non-hookable, so the Router cannot
> observe this exit through `afterAction`. `markExpired` is the
> permissionless reconciliation entry that lets the Router-side
> counter return to zero — required before `setCommerce` will accept
> a kernel switch (R6 drain SOP).

### 4.7 · Economic outcomes

| Path                                              | Client balance | Provider balance | Duration                |
| ------------------------------------------------- | -------------- | ---------------- | ----------------------- |
| A · Happy                                         | −100           | +95 (5% fee)     | Min 3 days              |
| B · Rejected                                      | 0              | 0                | ≤3 days (prompt voting) |
| C · Disputed → window elapses → 1st-mover race:   |                |                  |                         |
| &nbsp;&nbsp;&nbsp;&nbsp;C₁ Provider settles first | −100           | +95 (5% fee)     | After `disputeWindow`   |
| &nbsp;&nbsp;&nbsp;&nbsp;C₂ Client refunds first   | 0              | 0                | After `expiredAt`       |
| D · Open cancel                                   | 0              | 0                | Immediate               |
| E · Never submitted                               | 0              | 0                | After `expiredAt`       |

---

## 5 · Contract Details

### 5.1 · `AgenticCommerceUpgradeable.sol`

- **Inheritance:** `Initializable` + `Ownable2StepUpgradeable` +
  `PausableUpgradeable` + `UUPSUpgradeable` + `ReentrancyGuardTransient`.
- **Storage:** flat upgradeable layout, 6 slots + `__gap[44]`. Fields:
  `paymentToken`, `platformFeeBP`, `platformTreasury`, `jobCounter`,
  `mapping(uint256 => Job) jobs`, `mapping(uint256 => bool) jobHasBudget`.
  **Never reorder or remove fields**; only append by shrinking `__gap`.
- **ERC-8183 surface** (all `MUST` + `SHOULD`): `createJob`, `setProvider`,
  `setBudget`, `fund`, `submit`, `complete`, `reject`, `claimRefund`.
  - `setProvider` reverts with `ProviderAlreadySet` (audit I05) when
    `job.provider != 0`. The dedicated error lets clients distinguish
    "already bound" from a generic status mismatch.
  - `setBudget` callable by client or provider. `amount == 0` reverts
    with `ZeroBudget` (audit I02), so the kernel can treat
    `Funded ⇒ budget > 0` as a hard invariant.
  - `fund(jobId, expectedBudget, optParams)` enforces `job.budget ==
expectedBudget` as front-running protection.
  - `claimRefund` is **not** `whenNotPaused` and **not** hookable — this is
    the universal escape hatch.
  - Hook dispatch goes through `HOOK_GAS_LIMIT = 1_000_000` and verifies
    `IACPHook` via ERC-165 at `createJob` time.
  - `createJob` rejects `hook == address(0)` with `HookRequired` (audit L05)
    and rejects `expiredAt > now + MAX_EXPIRY_DURATION` (`365 days`,
    audit L01) so escrow can never be locked beyond a well-defined
    horizon. `createJob` invokes `_afterHook` only — `_beforeHook` is
    intentionally absent so a hook cannot veto its own installation
    (audit I09; documented as Delta 1.3 in the compliance doc).
  - `submit` rejects `block.timestamp >= job.expiredAt` with
    `WrongStatus`, mirroring `fund` (audit L02). Late submissions
    cannot be front-run by `claimRefund`. The `deliverable` hash is
    persisted to the `Job` struct in addition to the `JobSubmitted`
    event (audit I05) so on-chain consumers — verifying policies,
    arbitration contracts, reputation registries — can read it
    directly via `getJob(jobId)` without rebuilding state from logs.
- **Events:** aligned with the ERC-8183 standard set. Two deliberate
  ABI superset deviations:
  - `JobCreated` appends a non-indexed `hook` address.
  - `JobFunded` appends an indexed `provider` topic so providers can
    `eth_getLogs` for jobs assigned to them without joining against
    `JobCreated` (audit I03). Both are documented in
    `docs/erc-8183-compliance.md` Delta 1.
- **Admin:** `setPlatformFee(feeBP, treasury)`, `pause`, `unpause`.
  `setPlatformFee` is hard-capped at `MAX_PLATFORM_FEE_BP = 1_000`
  (10%, audit I07) — even a compromised owner cannot route more than
  10% of any future settlement to the treasury. The cap is a
  `constant`, so raising it requires a UUPS upgrade.
- **Token assumption — deploy contract, not a v2 todo (audit I01):**
  the kernel supports **plain ERC-20s only**. `fund` performs a single
  `safeTransferFrom(client, this, budget)` and trusts the post-transfer
  balance to equal `budget`; it does NOT reconcile pre/post `balanceOf`.
  This is intentional v1 scope. The following classes will cause
  silent escrow drift and revert at settlement (clients still recover
  via `claimRefund` after `expiredAt`, but providers and treasury
  cannot collect):
  - fee-on-transfer / reflection / deflationary tokens,
  - rebasing / elastic-supply tokens,
  - tokens with mid-lifecycle blocklists or fee toggles,
  - any token whose `balanceOf(address)` can decrease without an
    outgoing `transfer` from `address`.

  Confirming `paymentToken` against the token's source is part of the
  pre-deploy checklist in `README.md`. The runtime warning lives on
  the `paymentToken` storage NatSpec and on the `initialize` and
  `fund` function NatSpec, so etherscan / IDE / SDK introspection all
  surface it. Adding `balanceOf`-delta reconciliation in `fund` is
  out of scope for v1 (BNB Chain stablecoins do not need it; the gas
  cost is not justified for the typical case).

- **Not implemented (intentional):** `fundWithPermit`, ERC-2771
  meta-transactions, `AccessControl` multi-role (we use `Ownable2Step`),
  hook whitelist, `evaluatorFeeBP`.

### 5.2 · `EvaluatorRouterUpgradeable.sol`

- **Inheritance:** `Initializable` + `Ownable2StepUpgradeable` +
  `PausableUpgradeable` + `UUPSUpgradeable` + `ReentrancyGuardTransient`
  - `IACPHook`.
- **Storage:** ERC-7201 namespace `apex.router.storage.v1`. Fields:
  `commerce`, `mapping(uint256 => address) jobPolicy`,
  `mapping(address => bool) policyWhitelist`,
  `uint256 jobInflightCount` (audit L03; appended in PR-3, gates
  `setCommerce`). **Never change the namespace**; only append to
  `RouterStorage`.
- **Pause semantics:** `pause()` is the emergency brake. It blocks
  `registerJob` **and** `settle` (new jobs and new verdict write-backs).
  `beforeAction` / `afterAction` are **not** gated by pause — they are
  invoked synchronously by the kernel on every mutating call, and pausing
  them would cascade reverts into unrelated kernel flows (e.g. another
  job's `fund` / `submit`). Clients always keep the `commerce.claimRefund`
  escape (neither pausable nor hookable).
  - This serves two goals:
    1. When a Router bug is discovered, admin can freeze all pending
       verdict write-backs before shipping a UUPS upgrade.
    2. It enables the "stop new / drain old" SOP in R6 — pause first,
       then either upgrade in place or deploy a fresh Router.
- **Public functions:**
  - `registerJob(uint256 jobId, address policy)` — `whenNotPaused` +
    `nonReentrant` (audit I06; defence-in-depth — current external
    surface is a `view`, but the guard locks in CEI for any future
    policy upgrade). Caller MUST be `commerce.jobs(jobId).client`. Job
    MUST be Open. `job.evaluator == address(this)` and
    `job.hook == address(this)`. `policyWhitelist[policy] == true`.
    One-shot: `jobPolicy[jobId] == address(0)`. On success, increments
    `jobInflightCount` (audit L03).
  - `settle(uint256 jobId, bytes calldata evidence)` — permissionless,
    `nonReentrant` + `whenNotPaused`. Reads `policy = jobPolicy[jobId]`,
    calls `policy.check(jobId, evidence)`, then:
    - `verdict == 1 (Approve)` → `commerce.complete(jobId, reason, "")`
    - `verdict == 2 (Reject)` → `commerce.reject(jobId, reason, "")`
    - `verdict == 0 (Pending)` → revert `NotDecided`
    - any other value → revert `UnknownVerdict(verdict)`
  - `markExpired(uint256 jobId)` — permissionless, `nonReentrant`
    (audit L03). Closes the bookkeeping gap left by the
    non-hookable `claimRefund` path: reads `commerce.getJob(jobId)`,
    requires `status == Expired`, then deletes `jobPolicy[jobId]` and
    decrements `jobInflightCount`. Required before `setCommerce` can
    succeed once any routed job has exited via `claimRefund`.
  - `beforeAction(jobId, selector, data)` — `IACPHook`. Requires
    `msg.sender == commerce`. On `fund` selector, enforces
    `jobPolicy[jobId] != 0` (prevents funding an unregistered job).
    Other selectors: noop. Marked `view`. **Not** `nonReentrant` —
    access control is `msg.sender == commerce` and the function sits on
    the reentrant path `settle → commerce.complete → router.afterAction`.
  - `afterAction(jobId, selector, data)` — `IACPHook`. Requires
    `msg.sender == commerce`. - On `submit` selector, decodes `(bytes32 deliverable, bytes
optParams)` and forwards both verbatim to
    `policy.onSubmitted(jobId, deliverable, optParams)`. The Router
    does NOT interpret `optParams` — it is transported so policies
    can bind extra commitments (URI, manifest hash, ZK public inputs,
    ...) without a Router upgrade. - On `complete` / `reject` selectors, when `jobPolicy[jobId] != 0`
    the Router deletes the binding and decrements `jobInflightCount`
    (audit L03; mirrors the bookkeeping driven by `markExpired` for
    the `claimRefund` exit). The guard absorbs the legitimate
    Open-state `reject` of a routed job that never made it past
    `registerJob` — `jobPolicy` is zero in that case and the
    counter is left untouched. - Other selectors: noop. - Same `nonReentrant` rationale as `beforeAction`.
  - `supportsInterface` — declares `IACPHook` and `IERC165`.
  - `inflightJobCount() → uint256` — view; mirrors `RouterStorage.jobInflightCount`.
- **Admin:**
  - `setPolicyWhitelist(address policy, bool status)`.
  - `setCommerce(address newCommerce)` — allowed only while paused
    AND while `jobInflightCount == 0` (audit L03). Migration hatch
    (see R6 drain SOP).
  - `pause()` / `unpause()` — `onlyOwner`.
  - `_authorizeUpgrade` — `onlyOwner`.

> **Reject path under Router (audit L06):** the Router is the
> evaluator for every routed job, so the kernel's "evaluator-only
> reject in `Funded` / `Submitted`" branch is reachable **only**
> through `settle()` returning `VERDICT_REJECT`. There is no
> Router-level admin reject — rejections are policy-driven (e.g.
> `OptimisticPolicy` requires `dispute() + quorum`). Open-state
> rejections remain client-driven via `commerce.reject(jobId, …)`,
> and the Router observes the terminal transition through
> `afterAction`.

### 5.3 · `OptimisticPolicy.sol`

- **Inheritance:** plain contract, non-upgradeable. No `Pausable`, no
  `ReentrancyGuard` — every state-mutating function writes one mapping slot
  and emits one event, no external calls.
- **Constructor:**
  `(commerce_, router_, admin_, disputeWindow_, initialQuorum_)`. Stores
  `commerce`, `router`, `disputeWindow` as immutable; seeds `admin` and
  `voteQuorum`. `initialQuorum_ == 0` reverts (`QuorumZero`).
- **Mutable config:** `voteQuorum` (admin-updatable). Live updates
  do not affect in-flight disputes — see `disputeQuorumSnapshot` below
  (audit L08).
- **Per-job state:**
  - `mapping(uint256 => uint64) submittedAt`
  - `mapping(uint256 => bool)   disputed`
  - `mapping(uint256 => uint16) rejectVotes`
  - `mapping(uint256 => uint16) disputeQuorumSnapshot` — quorum
    threshold captured at `dispute()` time; used by `check()` /
    `voteReject()` so admin updates after the dispute is open cannot
    move the goalposts (audit L08).
  - `mapping(uint256 => mapping(address => bool)) hasVoted`
- **Voter whitelist:** `mapping(address => bool) isVoter` with
  `uint16 activeVoterCount`.
- **Functions:**
  - `onSubmitted(jobId, deliverable, optParams)` — router-only.
    `submittedAt[jobId]` is recorded on first call; a second call
    reverts (`AlreadyInitialised`). Reverts with `SubmissionTooLate`
    when `block.timestamp + disputeWindow > job.expiredAt` so the
    dispute window is structurally guaranteed to fit before
    `claimRefund` becomes callable (audit L07). `optParams` is accepted
    for `IPolicy` compatibility and intentionally ignored by the
    optimistic policy (not persisted to storage).
  - `dispute(jobId)` — reads `commerce.getJob(jobId)` and requires the
    caller to be `job.client`. Reverts if `submittedAt == 0`
    (`NotSubmitted`), if already disputed (`AlreadyDisputed`), or if the
    dispute window has elapsed (`OutsideDisputeWindow`). Flips `disputed`
    to `true` and snapshots the current `voteQuorum` into
    `disputeQuorumSnapshot[jobId]` (audit L08).
  - `voteReject(jobId)` — voter-only (`NotVoter`). Requires `disputed ==
true` (`NotDisputed`), first-time voter (`AlreadyVoted`), the kernel
    job still in `Submitted` state (`WrongJobStatus`, audit I04 — voting
    on a Completed/Rejected/Expired job has no settlement effect and only
    wastes gas), and `block.timestamp < submittedAt + disputeWindow`
    (`OutsideDisputeWindow`). The voting window mirrors the dispute
    window so a voter cannot front-run a pending `settle` after the
    window has closed and flip a default-approve verdict into REJECT —
    enforcing the §4.4 statement that "a dispute is only effective when
    voters back it up within the window". Records the vote and
    increments `rejectVotes[jobId]`. Emits `QuorumReached` exactly on
    the vote that first crosses `disputeQuorumSnapshot[jobId]`.
  - `check(jobId, evidence)` — router-only (enforced by caller context);
    `view`:
    - `submittedAt == 0` → `(Pending, 0)`
    - `disputed && rejectVotes ≥ disputeQuorumSnapshot` →
      `(Reject, REASON_REJECTED)`.
    - Otherwise — `now ≥ submittedAt + disputeWindow` →
      `(Approve, REASON_APPROVED)`. **This is also reached for
      disputed jobs that fail to muster quorum within the window**
      (audit H01); silence by voters auto-approves identically to the
      undisputed path.
    - Else → `(Pending, 0)`.
  - Admin:
    - `addVoter(addr)` — requires `!isVoter[addr]`; increments
      `activeVoterCount`.
    - `removeVoter(addr)` — requires `isVoter[addr]`; reverts with
      `WouldBreakQuorum` if `activeVoterCount - 1 < voteQuorum`
      (invariant: `voteQuorum ≤ activeVoterCount`).
    - `setQuorum(uint16 newQuorum)` — reverts if `0` (`QuorumZero`) or
      `> activeVoterCount` (`QuorumOutOfRange`). Takes effect on all
      in-flight jobs immediately.
    - `transferAdmin(newAdmin)` + `acceptAdmin()` — two-step transfer,
      mirrors `Ownable2Step` semantics.
- **Reason codes (public constants):**
  - `REASON_APPROVED = keccak256("OPTIMISTIC_APPROVED")`
  - `REASON_REJECTED = keccak256("OPTIMISTIC_REJECTED")`

### 5.4 · `IACP.sol` (implementation-level interface)

> **Not a strict ERC-8183 subset.** Internal contract between Router /
> Policy and the Commerce kernel. Integrating a third-party ERC-8183
> kernel requires writing an adapter against this interface.

Declares:

- `enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }`
- `struct Job { ... }` — mirrors the kernel storage layout.
- `getJob(uint256) → Job memory`
- `complete(uint256, bytes32, bytes)`
- `reject(uint256, bytes32, bytes)`
- `paymentToken() → address`

### 5.5 · `IPolicy.sol`

```solidity
interface IPolicy {
  function onSubmitted(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;
  function check(
    uint256 jobId,
    bytes calldata evidence
  ) external view returns (uint8 verdict, bytes32 reason);
}
```

Verdict values:

- `0` = Pending (no action; Router reverts with `NotDecided`).
- `1` = Approve (Router calls `Commerce.complete`).
- `2` = Reject (Router calls `Commerce.reject`).

For a walk-through on authoring a new `IPolicy` implementation — required
invariants, worked example, deployment + whitelisting flow — see
`docs/custom-policy.md`.

### 5.6 · `IACPHook.sol`

ERC-8183 normative hook interface. Unchanged from the spec:

```solidity
interface IACPHook is IERC165 {
  function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
  function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}
```

---

## 6 · Risks

### R1 · Upgradeable Router violates the ERC-8183 hook `SHOULD`

> Spec text: "Hooks SHOULD NOT be upgradeable after a job is created."

The Router is UUPS, and every job registered with it has the Router as its
hook. For all active routed jobs, the hook is therefore upgradeable.

**This is a `SHOULD` deviation, not a `MUST` violation.** Every ERC-8183
`MUST` clause at the kernel layer remains satisfied. We disclose the
deviation in contract NatSpec and in `README.md`, so strict-compliance
integrators can audit or skip the Router.

**Defence-in-depth mitigations (audit I08 — governance is `MUST`,
not `SHOULD`):**

1. **Governance — multisig everywhere.** Commerce Owner, Router Owner,
   and Policy Admin **MUST** be multisigs (Gnosis Safe or equivalent);
   owner-level thresholds **MUST** be `≥ 3-of-5`. Single-key ownership
   on either proxy is an immediate post-deploy mis-configuration that
   blocks production rollout.
2. **Timelock between Safe and proxies — non-optional.** A
   `TimelockController` MUST sit between the multisig and each UUPS
   proxy. Required delays: **48h for Commerce**, **24h for Router**.
   Policy admin ops (`addVoter` / `setQuorum`) may stay at 0h since
   they are not safety-critical, but ownership transfer of the policy
   admin role itself SHOULD go through the same timelock.
3. **Operational default: never upgrade.** Treat the Router as
   effectively immutable; only ship upgrades for critical bugs, and
   treat each upgrade as a security incident — incident report,
   blameless post-mortem, and external review of the upgrade diff.
4. **Explicit NatSpec disclosure** on the Router contract header
   already encodes the deviation; the README and `docs/erc-8183-compliance.md`
   mirror it. Strict-compliance integrators can audit or skip the
   Router accordingly.
5. **Upgrade review SOP.** Every Router upgrade proposal MUST include:
   (a) the new impl's git SHA; (b) a testnet-verified etherscan link;
   (c) a diff of `beforeAction` / `afterAction` (expected: no behaviour
   change); (d) explicit multisig sign-off that hook semantics for
   in-flight jobs are unchanged; (e) confirmation that
   `jobInflightCount` invariants survive the upgrade (storage append
   only, no slot collision).
6. **Prefer drain-and-redeploy over upgrade.** When a Router defect
   needs a structural fix, prefer running the §6 R6 drain SOP and
   deploying a fresh `Router2` rather than upgrading the existing
   proxy in place. Upgrades are reserved for fixes that are too urgent
   for the drain timeline.

### R2 · Router is the single hook entry for every routed job

A Router hook bug (whether or not introduced by an upgrade) affects every
in-flight routed job: a buggy `afterAction` breaks `submit`; a buggy
`beforeAction` breaks `fund`.

**Mitigations:** (a) keep the Router hook surface minimal — only `FUND`
and `SUBMIT` have real logic, all other selectors are noop; (b) exhaustive
selector-path tests; (c) Router owner on multisig; (d) clients always have
`claimRefund` as an escape hatch — it is explicitly not hookable.

### R3 · Default-approve with absent voters

If the entire voter set is offline or disengaged, every legitimately
disputed job auto-approves once `disputeWindow` elapses. Silence is
designed to mean approval but can instead mean absence. This applies
**both** to undisputed jobs (Flow A) and to disputed jobs whose voters
fail to reach quorum within the window (Flow C₁ in §4.7) — the audit
H01 fix makes the two paths identical so a zero-cost dispute cannot
freeze settlement.

**Mitigations:** (a) this is an accepted trade-off for the optimistic
design — no on-chain change in v1; (b) run `≥ 3 × voteQuorum` voters with
24/7 monitoring to lower absence probability; (c) `disputeWindow` MUST
fit fully before `expiredAt` — `OptimisticPolicy.onSubmitted` enforces
this on every submit (audit L07) so a provider cannot be set up to lose
payment by submitting too close to expiry; (d) v2 may introduce
per-job `disputeWindow` so clients can opt into mandatory-review jobs.

### R4 · Voter collusion

After a dispute, `voteQuorum` colluding voters can reject arbitrary jobs,
letting the client claim endless refunds. This is the root trust
assumption of `OptimisticPolicy`.

**Mitigations:** (a) curate voters carefully; (b) each voter uses its own
multisig; (c) when trust degrades, deploy a fresh policy with a new voter
set and un-whitelist the old policy.

### R5 · IACP is implementation-level, not standard-level

`IACP` is the internal contract between Router/Policy and Commerce; it is
not a strict ERC-8183 subset. The Router cannot plug directly into a
third-party ERC-8183 kernel without an adapter.

**Mitigations:** `Router.setCommerce(newCommerce)` is gated by
`whenPaused` AND `jobInflightCount == 0` (audit L03 — see R6),
giving admin a migration hatch once in-flight jobs are demonstrably
drained. A future `ACPAdapter` contract can bridge any spec-compliant
kernel.

### R6 · In-flight jobs cannot be force-migrated

`job.evaluator` and `job.hook` are pinned at `createJob` time with no
override path. If Commerce or Router develops a state bug, in-flight jobs
cannot be moved to a fresh contract.

**Mitigation:** use the pause switches on both contracts to run a
"stop new / drain old" SOP — never attempt in-flight rewrites.

**Router drain SOP (audit L03 + L04)**

1. `RouterOwner → router.pause()` blocks **new** `registerJob` and
   `settle`. `beforeAction` / `afterAction` remain unaffected, so
   other kernel paths are not cascade-reverted. This is the
   intentionally asymmetric pause semantics flagged by audit L04 —
   asymmetry exists so a Router bug does not cascade-revert unrelated
   `fund` / `submit` calls on the kernel; the universal client
   escape (`commerce.claimRefund`) is never pausable nor hookable.
2. Wait for routed jobs to reach a terminal kernel status. Three
   exit paths exist; the Router-side counter `jobInflightCount`
   tracks reconciliation:
   - **Settle (Approve / Reject)** — `router.settle(jobId, …)` (or
     a kernel-direct `complete` / `reject` for routed jobs that the
     evaluator handles directly) drives `commerce.complete` /
     `commerce.reject`, which fires `afterAction(complete | reject)`
     and decrements `jobInflightCount` automatically.
   - **claimRefund (kernel-direct refund)** — anyone calls
     `commerce.claimRefund(jobId)` after `expiredAt`; the kernel
     skips hooks (per ERC-8183 `MUST`), so the Router-side counter
     is **not** decremented automatically. Anyone then calls
     `router.markExpired(jobId)` to reconcile bookkeeping.
   - **Open-state cancellation** — client calls
     `commerce.reject(jobId, …)` while the job is still Open. The
     Router observes the terminal transition through
     `afterAction(reject)` and decrements automatically.
3. Once `router.inflightJobCount() == 0`, `router.setCommerce(...)`
   succeeds. Until that point, attempting to repoint the Router at
   a new kernel reverts `HasInflightJobs` — escrow on the old
   kernel can never be orphaned by a hot switch.
4. Optional: permanently pause or deprecate the old Router after
   migration; clients still keep `claimRefund` as the universal
   escape hatch on the kernel.

**Commerce drain SOP**

1. `CommerceOwner → commerce.pause()` blocks `createJob`, `fund`,
   `submit`, `complete`, `reject`. `claimRefund` is **not** gated by
   pause, so refund remains available.
2. In-flight jobs past `expiredAt` can refund immediately via
   `claimRefund(jobId)`; jobs still within the window wait for
   `expiredAt`. After every routed job has refunded, run the Router
   SOP above (`markExpired` per job) so the Router can also be
   migrated cleanly if needed.
3. Deploy `Commerce2`; new jobs flow through it.
4. Permanently pause the old Commerce; the only live path is
   `claimRefund`, returning escrow to clients.

**Intentionally unsupported capabilities**

- Rewriting `job.evaluator` or `job.hook` on an existing job.
- Migrating in-flight jobs between Commerce instances (only path is
  `claimRefund` on the old instance and re-create on the new one).
- Force-settling an in-flight job stuck in a broken policy (wait for
  `expiredAt` and `claimRefund`).
- `Router.setCommerce` while any routed job is still in flight on
  the current kernel — the kernel switch would orphan their escrow
  and break the `inflightJobCount` invariant.

All fallback paths rely on the same invariant: `claimRefund` is the
universal escape hatch — never pausable, never hookable, always callable
after `expiredAt`. Every dead-end path ultimately returns the client's
escrow.

### R7 · ERC-8183 spec drift

ERC-8183 is still in `Draft`. Future spec revisions may invalidate parts
of this implementation.

**Mitigations:** (a) minor drift → UUPS upgrade; (b) moderate drift →
UUPS upgrade + Router interface change; (c) major drift → fresh
deployment with manual migration. `docs/erc-8183-compliance.md` tracks
the spec version we have reviewed against and is refreshed per the
protocol in `CLAUDE.md`.

---

## 7 · Open Items

No blocking issues. Revisit in v2:

- [ ] Per-job policy configuration (e.g. client-selected `disputeWindow`).
- [ ] Voter staking / slashing.
- [ ] Voter incentives (funded from platform fee or an evaluator fee).
- [ ] ERC-8004 reputation registry integration.
- [ ] Adapter for third-party ERC-8183 kernels.
- [ ] "Freeze + drain" admin path for emergency migration.
- [ ] ERC-2771 meta-transactions if agent relayers become a requirement.

---

## 8 · Scope

### 8.1 · Implementation files

- `contracts/AgenticCommerceUpgradeable.sol`
- `contracts/EvaluatorRouterUpgradeable.sol`
- `contracts/OptimisticPolicy.sol`
- `contracts/IACP.sol`
- `contracts/IPolicy.sol`
- `contracts/IACPHook.sol`
- `contracts/ERC1967Proxy.sol` (thin wrapper around OZ's proxy for
  hardhat-viem deploys in tests and scripts)
- `contracts/mocks/MockERC20.sol`
- `contracts/mocks/RevertingHook.sol`
- `contracts/mocks/NoopHook.sol`
- `contracts/mocks/AgenticCommerceV2Mock.sol`
- `contracts/mocks/EvaluatorRouterV2Mock.sol`
- `test/helpers.ts`
- `test/AgenticCommerce.test.ts`
- `test/EvaluatorRouter.test.ts`
- `test/OptimisticPolicy.test.ts`
- `test/Lifecycle.test.ts`
- `test/Upgrades.test.ts`
- `scripts/deploy.ts`
- `scripts/fund-local.ts`
- `scripts/addresses.ts`

### 8.2 · Configuration / meta

- `hardhat.config.ts`, `package.json`, `.solhint.json`, `.prettierrc`,
  `tsconfig.json`, `.nvmrc`, `.env.example`, `README.md`, `CLAUDE.md`.

---

## 9 · Verify (definition of done)

1. `bun run compile` passes under `solc 0.8.28 + viaIR` with no warnings.
2. `bun test` — all cases green.
3. ERC-8183 conformance:
   - Complete 6-state transition matrix.
   - `setBudget` callable by client or provider.
   - `fund(expectedBudget)` front-running protection.
   - `claimRefund` still callable while paused.
   - `claimRefund` never invokes the hook.
   - `hook == address(0)` path skips hook dispatch entirely.
4. OptimisticPolicy path coverage:
   - Happy (no dispute, optimistic approve).
   - Disputed + quorum → Reject.
   - Disputed + quorum not reached → stalemate → Expired.
   - `dispute` past window → revert.
   - `voteReject` without dispute → revert.
   - Repeated `voteReject` by the same voter → revert.
   - `check` / `onSubmitted` called by a non-router → revert.
5. Router:
   - `registerJob` permission / status / whitelist checks.
   - `settle` three-branch dispatch (Pending revert, Approve → complete,
     Reject → reject, unknown verdict → revert).
   - `_authorizeUpgrade` is owner-only.
   - `setCommerce` allowed only while paused.
   - `pause()` blocks both `registerJob` and `settle`; `beforeAction` /
     `afterAction` still callable so unrelated kernel paths continue.
   - `unpause()` restores both.
6. Policy voter bookkeeping:
   - `addVoter` increments `activeVoterCount`; re-adding reverts.
   - `removeVoter` decrements; reverts when it would break
     `voteQuorum ≤ activeVoterCount`.
   - `setQuorum` reverts at `0` or `> activeVoterCount`.
   - `transferAdmin` + `acceptAdmin` two-step flow.
7. Mock UUPS upgrade on Commerce and Router (add a field, ensure old state
   still reads correctly).
8. `scripts/deploy.ts` runs end-to-end on `bscTestnet` and prints the
   address block for manual copy-paste into `scripts/addresses.ts`.
