# APEX v1 · Design

> Status: DRAFT · Author: Declan · Last updated: 2026-04-22
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
│  - onSubmitted(jobId, deliverable)                     │
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

| Role               | Permissions                                                    | Typical holder |
| ------------------ | -------------------------------------------------------------- | -------------- |
| **Commerce Owner** | `setPlatformFee`, `pause`, UUPS upgrade                        | Multisig       |
| **Router Owner**   | `setPolicyWhitelist`, `setCommerce` (paused), `pause`, upgrade | Multisig       |
| **Policy Admin**   | `addVoter`, `removeVoter`, `setQuorum`, `transferAdmin`        | Per-policy     |
| **Voter**          | `voteReject(jobId)`                                            | Whitelist addr |
| **Client**         | `createJob`, `setBudget`, `fund`, `registerJob`, `dispute`     | 1 per job      |
| **Provider**       | `submit`, `settle` (permissionless but usually provider)       | 1 per job      |

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
       │   └─ commerce.submit(jobId, deliverableHash, "")
       │        ├─ commerce → router.afterAction(SUBMIT)
       │        └─ router   → policy.onSubmitted(jobId, deliverable)
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

> Rule 1 (`disputed && rejectVotes ≥ voteQuorum → Reject`) does **not**
> require `disputeWindow` to elapse first. Once quorum is reached, `settle`
> can reject immediately.

### 4.4 · Flow C — Disputed stalemate → Expired (fallback)

```
Day 0-1 │ … same as Flow A (expiredAt = Day 30)
Day 2   │ Client disputes
Day 2-30│ Only 1 voter casts voteReject (quorum = 3, never reached)

Day 4   │ Anyone → router.settle(jobId, "")
        │   policy.check() → (Pending, 0)
        │   router reverts with NotDecided       ← Provider cannot pull

Day 4-30│ Deadlock. No one can advance the state machine.

Day 30  │ Anyone (typically Client)
        │   └─ commerce.claimRefund(jobId)                       [Expired]
        │        └─ 100 USDC → Client ✅
        │   (Policy state is orphaned but harmless; jobId never reused)
```

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
```

### 4.7 · Economic outcomes

| Path                | Client balance | Provider balance | Duration                |
| ------------------- | -------------- | ---------------- | ----------------------- |
| A · Happy           | −100           | +95 (5% fee)     | Min 3 days              |
| B · Rejected        | 0              | 0                | ≤3 days (prompt voting) |
| C · Stalemate       | 0              | 0                | Up to `expiredAt`       |
| D · Open cancel     | 0              | 0                | Immediate               |
| E · Never submitted | 0              | 0                | Up to `expiredAt`       |

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
  - `setBudget` callable by client or provider.
  - `fund(jobId, expectedBudget, optParams)` enforces `job.budget ==
expectedBudget` as front-running protection.
  - `claimRefund` is **not** `whenNotPaused` and **not** hookable — this is
    the universal escape hatch.
  - Hook dispatch goes through `HOOK_GAS_LIMIT = 1_000_000` and verifies
    `IACPHook` via ERC-165 at `createJob` time.
- **Events:** aligned with the ERC-8183 standard set. Our `JobFunded`
  carries an extra `provider` field (non-breaking extension of the spec's
  "SHOULD emit at least" events).
- **Admin:** `setPlatformFee(feeBP, treasury)`, `pause`, `unpause`.
- **Not implemented (intentional):** `fundWithPermit`, ERC-2771
  meta-transactions, `AccessControl` multi-role (we use `Ownable2Step`),
  hook whitelist, `evaluatorFeeBP`.

### 5.2 · `EvaluatorRouterUpgradeable.sol`

- **Inheritance:** `Initializable` + `Ownable2StepUpgradeable` +
  `PausableUpgradeable` + `UUPSUpgradeable` + `ReentrancyGuardTransient`
  - `IACPHook`.
- **Storage:** ERC-7201 namespace `apex.router.storage.v1`. Fields:
  `commerce`, `mapping(uint256 => address) jobPolicy`,
  `mapping(address => bool) policyWhitelist`. **Never change the
  namespace**; only append to `RouterStorage`.
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
  - `registerJob(uint256 jobId, address policy)` — `whenNotPaused`.
    Caller MUST be `commerce.jobs(jobId).client`. Job MUST be Open.
    `job.evaluator == address(this)` and `job.hook == address(this)`.
    `policyWhitelist[policy] == true`. One-shot:
    `jobPolicy[jobId] == address(0)`.
  - `settle(uint256 jobId, bytes calldata evidence)` — permissionless,
    `nonReentrant` + `whenNotPaused`. Reads `policy = jobPolicy[jobId]`,
    calls `policy.check(jobId, evidence)`, then:
    - `verdict == 1 (Approve)` → `commerce.complete(jobId, reason, "")`
    - `verdict == 2 (Reject)` → `commerce.reject(jobId, reason, "")`
    - `verdict == 0 (Pending)` → revert `NotDecided`
    - any other value → revert `UnknownVerdict(verdict)`
  - `beforeAction(jobId, selector, data)` — `IACPHook`. Requires
    `msg.sender == commerce`. On `fund` selector, enforces
    `jobPolicy[jobId] != 0` (prevents funding an unregistered job).
    Other selectors: noop. Marked `view`. **Not** `nonReentrant` —
    access control is `msg.sender == commerce` and the function sits on
    the reentrant path `settle → commerce.complete → router.afterAction`.
  - `afterAction(jobId, selector, data)` — `IACPHook`. Requires
    `msg.sender == commerce`. On `submit` selector, decodes
    `(bytes32 deliverable, bytes)` and forwards to
    `policy.onSubmitted(jobId, deliverable)`. Other selectors: noop.
    Same `nonReentrant` rationale.
  - `supportsInterface` — declares `IACPHook` and `IERC165`.
- **Admin:**
  - `setPolicyWhitelist(address policy, bool status)`.
  - `setCommerce(address newCommerce)` — allowed only while paused.
    Migration hatch (see R5).
  - `pause()` / `unpause()` — `onlyOwner`.
  - `_authorizeUpgrade` — `onlyOwner`.

### 5.3 · `OptimisticPolicy.sol`

- **Inheritance:** plain contract, non-upgradeable. No `Pausable`, no
  `ReentrancyGuard` — every state-mutating function writes one mapping slot
  and emits one event, no external calls.
- **Constructor:**
  `(commerce_, router_, admin_, disputeWindow_, initialQuorum_)`. Stores
  `commerce`, `router`, `disputeWindow` as immutable; seeds `admin` and
  `voteQuorum`. `initialQuorum_ == 0` reverts (`QuorumZero`).
- **Mutable config:** `voteQuorum` (admin-updatable).
- **Per-job state:**
  - `mapping(uint256 => uint64) submittedAt`
  - `mapping(uint256 => bool)   disputed`
  - `mapping(uint256 => uint16) rejectVotes`
  - `mapping(uint256 => mapping(address => bool)) hasVoted`
- **Voter whitelist:** `mapping(address => bool) isVoter` with
  `uint16 activeVoterCount`.
- **Functions:**
  - `onSubmitted(jobId, deliverable)` — router-only. `submittedAt[jobId]`
    is recorded on first call; a second call reverts
    (`AlreadyInitialised`).
  - `dispute(jobId)` — reads `commerce.getJob(jobId)` and requires the
    caller to be `job.client`. Reverts if `submittedAt == 0`
    (`NotSubmitted`), if already disputed (`AlreadyDisputed`), or if the
    dispute window has elapsed (`OutsideDisputeWindow`). Flips `disputed`
    to `true`.
  - `voteReject(jobId)` — voter-only (`NotVoter`). Requires `disputed ==
true` (`NotSubmitted`) and first-time voter (`AlreadyVoted`). Records
    the vote and increments `rejectVotes[jobId]`.
  - `check(jobId, evidence)` — router-only (enforced by caller context);
    `view`:
    - `submittedAt == 0` → `(Pending, 0)`
    - `disputed` branch: `rejectVotes ≥ voteQuorum` →
      `(Reject, REASON_REJECTED)`, otherwise `(Pending, 0)`.
    - Non-disputed branch: `now ≥ submittedAt + disputeWindow` →
      `(Approve, REASON_APPROVED)`, otherwise `(Pending, 0)`.
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
  function onSubmitted(uint256 jobId, bytes32 deliverable) external;
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

**Defence-in-depth mitigations:**

1. **Governance — multisig everywhere.** Commerce Owner, Router Owner, and
   Policy Admin MUST be multisigs (Gnosis Safe or equivalent); owner-level
   thresholds SHOULD be `≥ 3-of-5`.
2. **Timelock between Safe and proxies.** Recommended delays: 24h for
   Router, 48h for Commerce. Policy admin ops (`addVoter` / `setQuorum`)
   may stay at 0h since they are not safety-critical.
3. **Operational default: never upgrade.** Treat the Router as effectively
   immutable; only ship upgrades for critical bugs, and treat each upgrade
   as a security incident.
4. **Explicit NatSpec disclosure** on the Router contract header:
   "Deviates from ERC-8183 SHOULD: hook is upgradeable via UUPS under
   multisig + timelock governance."
5. **README disclosure** — mirror the NatSpec in top-level docs.
6. **Upgrade review SOP.** Every Router upgrade proposal must include:
   (a) the new impl's git SHA; (b) a testnet-verified etherscan link;
   (c) a diff of `beforeAction` / `afterAction` (expected: no behaviour
   change); (d) explicit multisig sign-off that hook semantics for
   in-flight jobs are unchanged.

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
designed to mean approval but can instead mean absence.

**Mitigations:** (a) this is an accepted trade-off for the optimistic
design — no on-chain change in v1; (b) run `≥ 3 × voteQuorum` voters with
24/7 monitoring to lower absence probability; (c) v2 may introduce
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
`whenPaused`, giving admin a migration hatch once in-flight jobs are
drained. A future `ACPAdapter` contract can bridge any spec-compliant
kernel.

### R6 · In-flight jobs cannot be force-migrated

`job.evaluator` and `job.hook` are pinned at `createJob` time with no
override path. If Commerce or Router develops a state bug, in-flight jobs
cannot be moved to a fresh contract.

**Mitigation:** use the pause switches on both contracts to run a
"stop new / drain old" SOP — never attempt in-flight rewrites.

**Router drain SOP**

1. `RouterOwner → router.pause()` blocks **new** `registerJob` and
   `settle`. `beforeAction` / `afterAction` remain unaffected, so other
   kernel paths are not cascade-reverted.
2. Investigate + fix. To swap routers, deploy `Router2` (new proxy), point
   SDK / front-ends at it, and let new jobs flow through `Router2`. For
   an internal fix, `router.upgradeToAndCall(...)` through UUPS.
3. Unpause to let old-Router in-flight jobs finish. Jobs that cannot
   settle wait for `expiredAt` and refund via `claimRefund`.
4. Optional: permanently pause the old Router or mark it deprecated.

**Commerce drain SOP**

1. `CommerceOwner → commerce.pause()` blocks `createJob`, `fund`,
   `submit`, `complete`, `reject`. `claimRefund` is **not** gated by
   pause, so refund remains available.
2. In-flight jobs past `expiredAt` can refund immediately via
   `claimRefund(jobId)`; jobs still within the window wait for
   `expiredAt`.
3. Deploy `Commerce2`; new jobs flow through it.
4. Permanently pause the old Commerce; the only live path is
   `claimRefund`, returning escrow to clients.

**Intentionally unsupported capabilities**

- Rewriting `job.evaluator` or `job.hook` on an existing job.
- Migrating in-flight jobs between Commerce instances (only path is
  `claimRefund` on the old instance and re-create on the new one).
- Force-settling an in-flight job stuck in a broken policy (wait for
  `expiredAt` and `claimRefund`).

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
- `scripts/upgrade-commerce.ts`
- `scripts/upgrade-router.ts`
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
