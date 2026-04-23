# Authoring a custom policy

> Status: DRAFT · Author: BNB Chain · Audience: Solidity developers shipping
> a new `IPolicy` against the existing APEX Router. You have already read
> `docs/design.md`.
>
> **Authoritative sources.** If this document ever disagrees with the
> code, the code wins. Cross-check every rule against:
>
> - `contracts/IPolicy.sol` — the interface itself.
> - `contracts/EvaluatorRouterUpgradeable.sol` — the only caller of your
>   policy.
> - `docs/design.md §5.5` — policy surface.
> - `docs/design.md §6` — threat model.

---

## 1 · Do you actually need a new policy?

Most requests are config, not code. Reach for a custom contract **only if
none of the following knobs on `OptimisticPolicy` solve the problem**:

| Need                                             | Config lever on `OptimisticPolicy`                                        |
| ------------------------------------------------ | ------------------------------------------------------------------------- |
| Shorter / longer dispute grace period            | Deploy a second instance with a different `disputeWindow`.                |
| Different voter set for a different product line | Deploy a second instance; manage `addVoter` / `removeVoter` per instance. |
| Different quorum                                 | `setQuorum` on the existing instance.                                     |

The Router's whitelist is a `mapping(address => bool)`: **many policy
instances coexist by design** (see §8). A second `OptimisticPolicy` with
different parameters is almost always the right answer.

Write a new policy only when the **verdict function itself** needs to
change — e.g. "require N-of-M off-chain signatures", "require an oracle
price range at submission", "route to a third-party attestation service".

---

## 2 · The `IPolicy` surface

```solidity
interface IPolicy {
  function onSubmitted(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external;

  function check(
    uint256 jobId,
    bytes calldata evidence
  ) external view returns (uint8 verdict, bytes32 reason);
}
```

**Caller contract.** The Router is the only caller that matters:

- `onSubmitted` is invoked **exactly once per job**, synchronously from
  `commerce.submit(...) → router.afterAction(SUBMIT) → policy.onSubmitted`.
  Use it to capture time-sensitive state (e.g. `submittedAt`). The
  Router passes two transported fields verbatim from `submit`:
  - `deliverable` — the 32-byte commitment provider supplied.
  - `optParams` — the provider's opaque `bytes` payload (unbounded).
    ERC-8183 forbids the kernel from interpreting `optParams`; the
    Router relays it unchanged so policies can bind extra commitments
    (URI, manifest hash, ZK public inputs, ...) without requiring a
    Router upgrade. Policies that do not use it MUST ignore the
    argument and SHOULD NOT persist it to storage — writing unbounded
    bytes per job amplifies `submit` gas costs.
- `check` is invoked from `router.settle(jobId, evidence)`. The Router
  translates the verdict into `commerce.complete` / `commerce.reject` /
  revert-with-`NotDecided`.

**Verdict codes** (copy these constants; do not invent new ones):

| Value | Meaning | Router effect                                              |
| ----- | ------- | ---------------------------------------------------------- |
| `0`   | Pending | `settle` reverts `NotDecided`.                             |
| `1`   | Approve | `commerce.complete(jobId, reason, "")` — provider is paid. |
| `2`   | Reject  | `commerce.reject(jobId, reason, "")` — client is refunded. |

`reason` is an opaque `bytes32` forwarded verbatim to the kernel event.
Convention: `keccak256("MY_POLICY_APPROVED")` / `keccak256("MY_POLICY_REJECTED")`.

---

## 3 · Mandatory invariants

These are the contract you sign with the Router. Violating any of them is
a consensus bug, not a feature.

1. **`check` MUST be `view`.** The Router reads the verdict inside
   `settle`; any state change in `check` is invisible to the kernel write
   that immediately follows it and breaks settle-time idempotency. Make
   the Solidity compiler enforce this by keeping the `view` mutability.

2. **`onSubmitted` MUST be gated on `msg.sender == router`.** It mutates
   per-job time state; anyone else calling it would let an attacker reset
   the window. Use an `immutable` `router` address captured in the
   constructor.

3. **`onSubmitted` MUST be one-shot.** Reverting on a second call is
   acceptable; silently ignoring it is acceptable. Never accept two
   initialisations — the Router has no re-entry for `SUBMIT`, so the
   second call would be a bug upstream.

4. **Verdicts MUST be monotonic.** The only allowed transition is
   `Pending → Approve` or `Pending → Reject`. Once a job has a terminal
   verdict (because the Router already applied it), `check` may return
   anything — the Router will never call you again for that `jobId`, and
   the kernel job is frozen in `Completed` / `Rejected`. But while the
   job is still settleable, you must not flip between Approve and Reject.

5. **No reentrancy into Router / Commerce from `onSubmitted`.** You are
   already on the reentrant path `settle → commerce → router → policy`.
   Keep `onSubmitted` pure-storage-writes. Do not call Commerce back;
   do not call the Router back.

6. **`check` MUST handle "never initialised" gracefully.** If
   `submittedAt[jobId] == 0` (or your equivalent), return
   `(VERDICT_PENDING, bytes32(0))`. Do not revert.

---

## 4 · Recommended patterns

- **Immutable wiring.** `commerce` and `router` in storage should be
  `immutable` and captured in the constructor. A policy that talks to a
  different Router mid-life has no upgrade path anyway, so don't design
  for it.
- **Two-step admin transfer.** If your policy has admin-configurable
  state (voter list, signer set, oracle address), ship it with a
  two-step transfer flow mirroring `OptimisticPolicy.transferAdmin` /
  `acceptAdmin`.
- **Event per state transition.** Index `jobId` on every event; the
  Router and clients rely on indexed scans to rebuild state.
- **Use `uint64` for timestamps, `block.timestamp` as the time source.**
  `block.number` is not a clock — block rate drifts and is chain-specific.
- **Bounded counters.** `uint16` is fine for voter sets; document the
  ceiling if you use it.

---

## 5 · Threat model checklist

Walk through each before deploying:

- **`settle` front-running.** `settle` is permissionless. Assume an
  adversary reads your state, predicts the verdict flip, and calls
  `settle` on the same block. Acceptable — your verdict is whatever
  `check` returns at that block, regardless of the caller.
- **Indefinite `Pending` griefing.** Your policy can keep a job
  `Pending` forever. That is not an attack: the kernel's
  `claimRefund` path is **never pausable, never hookable**, so the
  client always has an escape once `job.expiredAt` is reached. Do not
  design a fallback "force approve" mechanism — it would break refund
  guarantees.
- **Admin compromise.** Scope admin powers so a compromised admin cannot
  retroactively flip a verdict on an in-flight job. In `OptimisticPolicy`,
  admin can only change future-impacting state (quorum, voter set);
  existing votes and `disputed[jobId]` are immutable. Mirror that
  pattern.
- **Replay across deploys.** Job ids come from the kernel, not your
  policy. Two policies talking to the same Commerce instance see the
  same id space; this is fine — `jobPolicy[jobId]` in the Router is
  1-to-1, so your policy only ever sees ids the Router routed to you.
- **Evidence trust.** `check`'s `evidence` parameter is caller-supplied.
  Treat it exactly like `msg.data`: untrusted. If you use it (e.g.
  signed attestations), verify signatures against your admin-managed
  signer set.

---

## 6 · Worked example: `ZkProofPolicy` (template)

A minimal skeleton that delegates the verdict to an off-chain ZK
verifier. The provider submits; `onSubmitted` pins the work
commitments (`deliverable` and a hash of `optParams`) for later
cross-checking; `check` decodes a proof + public inputs from
`evidence`, re-binds the public inputs to the pinned commitments, and
calls an external verifier contract. No on-chain voting, no dispute
window — the client's expiry refund remains the ultimate escape if no
valid proof ever lands.

> **Example only — NOT audited. DO NOT deploy as-is.** This is a
> thinking template: the circuit, its public-input layout, the
> verifier contract, and the proof encoding are all placeholders.
> A real deployment needs an audit, a circuit review, gas review, and
> an operational playbook.

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IPolicy } from "./IPolicy.sol";

interface IZkVerifier {
  // Circuit-specific. Shape of `publicInputs` is defined by the circuit,
  // not by APEX. This template assumes the circuit exposes at least
  // (deliverable, optParamsHash) in a known slot.
  function verify(
    bytes calldata proof,
    uint256[] calldata publicInputs
  ) external view returns (bool);
}

/// @notice Zero-knowledge attestation policy. APPROVE iff the provided
///         proof verifies against `verifier` AND its public inputs
///         match the commitments pinned at `onSubmitted`.
contract ZkProofPolicy is IPolicy {
  uint8 internal constant VERDICT_PENDING = 0;
  uint8 internal constant VERDICT_APPROVE = 1;

  bytes32 public constant REASON_APPROVED = keccak256("ZK_APPROVED");

  address public immutable router;
  IZkVerifier public immutable verifier;

  struct Commitment {
    bytes32 deliverable;
    bytes32 optParamsHash;
    uint64 submittedAt;
  }
  mapping(uint256 => Commitment) public commitments;

  error NotRouter();
  error AlreadyInitialised();

  event JobBound(uint256 indexed jobId, bytes32 deliverable, bytes32 optParamsHash);

  constructor(address router_, address verifier_) {
    router = router_;
    verifier = IZkVerifier(verifier_);
  }

  function onSubmitted(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external {
    if (msg.sender != router) revert NotRouter();
    if (commitments[jobId].submittedAt != 0) revert AlreadyInitialised();

    // Hash, don't store, the unbounded optParams: commits the bytes
    // without paying per-byte SSTORE.
    bytes32 optHash = keccak256(optParams);
    commitments[jobId] = Commitment({
      deliverable: deliverable,
      optParamsHash: optHash,
      submittedAt: uint64(block.timestamp)
    });
    emit JobBound(jobId, deliverable, optHash);
  }

  /// @dev `evidence` layout: `abi.encode(bytes proof, uint256[] publicInputs)`.
  ///      The circuit MUST expose `deliverable` and `optParamsHash` as
  ///      public inputs at the slots below. TODO: pin slot indices to
  ///      match the concrete circuit once frozen.
  function check(
    uint256 jobId,
    bytes calldata evidence
  ) external view returns (uint8 verdict, bytes32 reason) {
    Commitment memory c = commitments[jobId];
    if (c.submittedAt == 0 || evidence.length == 0) {
      return (VERDICT_PENDING, bytes32(0));
    }

    (bytes memory proof, uint256[] memory pub) = abi.decode(evidence, (bytes, uint256[]));

    // TODO: replace with the real circuit's public-input layout.
    if (pub.length < 2) return (VERDICT_PENDING, bytes32(0));
    if (bytes32(pub[0]) != c.deliverable) return (VERDICT_PENDING, bytes32(0));
    if (bytes32(pub[1]) != c.optParamsHash) return (VERDICT_PENDING, bytes32(0));

    if (!verifier.verify(proof, pub)) return (VERDICT_PENDING, bytes32(0));
    return (VERDICT_APPROVE, REASON_APPROVED);
  }
}
```

**Why each decision:**

- `router` and `verifier` are `immutable`; swapping verifier mid-life
  would invalidate every pinned commitment, so don't design for it.
- `onSubmitted` hashes `optParams` instead of storing it — the kernel
  already paid calldata for the transport, the policy only needs the
  commitment. Storing unbounded bytes per job would amplify `submit`
  gas for every provider.
- `check` returns `PENDING` (not `REJECT`) on any mismatch or bad
  proof. This preserves invariant #4 (monotonic verdicts) and lets the
  provider retry with a corrected proof until `expiredAt`; after
  expiry the client's refund hatch is the escape.
- No REJECT path on-chain: "I can prove it" is asymmetric with "I can
  prove it is wrong". If you need adversarial disputes, compose this
  template with an optimistic-style dispute window in front.

---

## 7 · Testing checklist

Minimum cases before whitelisting on the Router. Names are suggestions —
use them verbatim so reviewers can grep:

- `onSubmittedOnlyRouter` — reverts for any `msg.sender != router`.
- `onSubmittedRevertsOnSecondCall` — second init reverts cleanly.
- `checkIsView` — Solidity compiler + `staticcall` from a test harness.
- `verdictMonotonicPendingToTerminal` — once `check` returns APPROVE,
  it never returns REJECT (and vice versa) for the same job.
- `checkPendingIfNotInitialised` — returns `(0, 0)` for unknown ids.
- `refundHatchStillWorks` — integration test: create a job routed to
  your policy, never reach a verdict, jump past `expiredAt`, assert
  `commerce.claimRefund` succeeds.
- `routerSettleAppliesVerdict` — full Router → policy → kernel round-trip.
- Any policy-specific cases (signature malleability, duplicate votes,
  oracle staleness…).

Run the APEX stack's existing e2e runner against your policy by
temporarily adding it to the local deploy script, then whitelisting it
before the runner exercises jobs.

---

## 8 · Coexistence, selection, and (rarely) retirement

### 8.1 · Many policies, running side by side — the default

The Router's `policyWhitelist` is `mapping(address => bool)`; there is
**no singleton**. `registerJob(jobId, policy)` binds one policy per job
at registration time, and `jobPolicy[jobId]` is immutable thereafter
(`PolicyAlreadySet`).

Typical production topology:

- `OptimisticPolicy(24h, quorum=3)` — default "consumer" tier.
- `OptimisticPolicy(1h,  quorum=5)` — fast-settle, higher-confidence
  tier.
- `ZkProofPolicy(verifier=...)` — zero-knowledge attestation tier.

Adding a new policy is a single transaction
(`router.setPolicyWhitelist(newPolicy, true)`) and **does not touch any
in-flight job**. That is why "add a new policy" is almost always
preferable to "reconfigure an existing one": reconfiguring affects
every future job through that instance; adding only affects jobs that
explicitly opt in via `registerJob`.

### 8.2 · How clients pick

Clients select a policy per job. Recommended flow:

1. Provider advertises the policies it supports (e.g. in its profile /
   negotiation handshake).
2. Client verifies each candidate is still live:
   `router.policyWhitelist(policy) == true`.
3. Client calls `router.registerJob(jobId, policy)` **before**
   `commerce.fund` (the Router's `beforeAction(FUND)` reverts
   `PolicyNotSet` otherwise).

### 8.3 · How providers adapt

Providers do not need per-policy code. Every policy reaches the kernel
through the same `router.settle` path with identical `complete` /
`reject` semantics. Providers watch the kernel events; they do not
watch policies directly.

### 8.4 · Retirement — only when something is wrong

Retirement is a **safety response**, not a lifecycle stage. Trigger it
only if:

- a bug / vulnerability is found in the policy, or
- governance decides the policy's risk profile is no longer acceptable.

Safe retirement procedure:

1. Router owner: `setPolicyWhitelist(badPolicy, false)`. This blocks
   **new** `registerJob` bindings. In-flight jobs already bound to the
   policy keep functioning — `settle` does not consult the whitelist.
2. Announce the deprecation; point clients / providers at replacement
   policies.
3. In-flight jobs drain through one of two paths:
   - Normal settlement via `router.settle` (the existing verdict logic
     still runs).
   - Client calls `commerce.claimRefund` once `job.expiredAt` has
     passed. This escape is **never pausable and never hookable** —
     it is the universal safety net.
4. The policy contract stays on-chain but becomes unreferenced. No
   destruction, no further owner action required.

Note that Router-level `pause()` is **not** part of this flow. `pause()`
is the emergency lever for bugs in the **Router itself**; bugs in a
single policy are handled by whitelist removal plus natural drain.

### 8.5 · Emergency matrix

| Situation                  | Lever                                                                                           |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| Bug in a single policy     | `setPolicyWhitelist(policy, false)`; in-flight jobs drain per §8.4.                             |
| Bug in the Router          | `router.pause()` + investigate + UUPS upgrade. Clients keep `commerce.claimRefund` as fallback. |
| Bug in the Commerce kernel | Out of scope for this document — see `design.md §6`.                                            |

---

## 9 · Deployment + whitelisting: the exact four steps

1. **Deploy.** Constructor MUST wire in `commerce`, `router`, and any
   admin addresses as immutables or initial storage. Record the deployed
   address in your team's registry.
2. **Whitelist.** Router owner submits
   `setPolicyWhitelist(policy, true)`. Emit `PolicyWhitelisted(policy,
true)` is the confirmation signal.
3. **Bootstrap policy state.** If the policy has admin-controlled
   config (signer set, voter list, oracle feed address), populate it
   **before** any client registers a job. A half-configured policy
   that reaches `check` can produce a wrong verdict.
4. **Client registration per job.** Clients call
   `router.registerJob(jobId, policy)` after `commerce.createJob` and
   before `commerce.fund`.

---

## 10 · Relation to ERC-8183

ERC-8183 does not know about policies. The spec only sees
`job.evaluator` and `job.hook`, both of which are the Router in the
APEX deployment. Your policy sits one layer deeper and is an APEX
implementation detail: the spec deviation surface (`SHOULD` on
upgradeable hooks — see `design.md §6 R1`) is entirely the Router's
concern, not yours. Keep your policy immutable; it will never need a
proxy.
