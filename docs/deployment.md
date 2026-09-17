# APEX Deployment Runbook

Operational guide for deploying APEX v1 to BSC Testnet / Mainnet, verifying
the full stack on the block explorer, managing the payment-token allowlist,
and handing ownership to a production multisig. One command (`bun run deploy:<env>`)
handles first deploys, implementation upgrades, and full-stack rotations;
another (`bun run verify:<env>`) verifies every contract with zero manual
arguments.

## 1 · Pre-deploy: fill `scripts/addresses.ts`

Optionally pre-fill inputs in [`scripts/addresses.ts`](../scripts/addresses.ts)
for the target network:

```ts
export const ADDRESSES: Partial<Record<string, DeployedAddresses>> = {
  bscTestnet: {
    paymentToken: "0x...", // e.g. USDC on BSC Testnet
    treasury: "0x...", // EOA or multisig that collects platform fees
    // commerceProxy / routerProxy / policy come back from deploy stdout
  },
};
```

Every field is optional. `deploy.ts` reads the entry top-to-bottom with one
cascading rule: **blank `paymentToken` triggers a full-stack rotation.** The
rest of the fields decide reuse-vs-deploy independently:

| Field           | Filled → reuse                                                                                                                                            | Blank → deploy                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paymentToken`  | use that ERC-20 as the immutable default / pre-upgrade fallback token                                                                                     | deploy fresh `ERC20MinimalMock` **and** force fresh Commerce + Router + Policy (cascade; `commerceProxy` / `routerProxy` are ignored in this branch) |
| `paymentTokens` | the complete desired allowlist for this network's Commerce (see §2.2); MUST be non-empty, unique, all deployed contracts, and MUST contain `paymentToken` | allowlist is initialised with `[paymentToken]` only — omission never implies USDC/USDT support and never re-enables a token governance disabled      |
| `treasury`      | passed into `commerce.initialize` on fresh path; logged only on reuse path                                                                                | fall back to the deployer                                                                                                                            |
| `commerceProxy` | keep proxy; deploy new impl + `upgradeToAndCall` **only if the compiled bytecode differs from the on-chain impl** (immutables masked)                     | deploy fresh impl + `ERC1967Proxy` + `initialize` **and** force fresh Router (so it doesn't dangle)                                                  |
| `routerProxy`   | keep proxy; same bytecode-diff rule (requires Commerce was reused)                                                                                        | deploy fresh impl + `ERC1967Proxy` + `initialize`                                                                                                    |
| `policy`        | reuse if its bytecode matches the artifact **and** it points at this entry's commerce/router; otherwise rotate + whitelist                                | deploy fresh + whitelist                                                                                                                             |

`disputeWindow` / `initialQuorum` live in Policy immutables and are invisible
to the bytecode diff — to rotate params without a code change, blank `policy`
to force a redeploy.

The canonical version of this cascade lives as JSDoc at the top of
[`scripts/addresses.ts`](../scripts/addresses.ts) — if the table above ever
drifts, that file wins.

## 2 · Deploy

```bash
cp .env.example .env
# fill BSC_TESTNET_PRIVATE_KEY (and ETHERSCAN_API_KEY if you plan to verify)
bun run deploy:testnet                # DRY RUN: prints the plan, sends nothing
DEPLOY_YES=1 bun run deploy:testnet   # executes the plan (`--yes` also works
                                      # when the runner forwards CLI args)
```

Every run is a **dry run by default**: it prints, per contract, whether it is
`FRESH` / `UPGRADE` / `up-to-date` and who can execute each owner-gated call,
then exits without sending a transaction. Re-run with `DEPLOY_YES=1` to
execute. `deploy.ts` then prints a block of `0x…` values; paste the ones it
emits under the same `ADDRESSES` entry and commit. Subsequent runs will reuse
them. The same command handles first deploys, impl upgrades, and full-stack
rotations — there is no separate `upgrade:*` script.

`upgradeToAndCall` and `setPolicyWhitelist` are owner-gated. `deploy.ts`
checks `owner()` on each reused proxy:

- owner == signer → the call is sent directly;
- owner is anyone else (the production multisig, another EOA) → the new impl
  / policy is still deployed (deployment is permissionless), but the
  owner-gated call is **not** sent — the exact transaction (`to` / `value` /
  `data`) is printed at the end, ready to paste into Safe{Wallet}. Until the
  owner executes it, the new impl is deployed but not live behind the proxy.

To rehearse a mainnet upgrade without touching mainnet, run the same command
against the `bscFork` network (an in-process fork of BSC mainnet; uses the
same `ADDRESSES` entry as `bsc`):

```bash
DEPLOY_YES=1 bunx hardhat run scripts/deploy.ts --network bscFork
```

### 2.1 · Upgrade workflow per environment

Every environment follows the same skeleton — **dry-run → execute → paste
addresses back → verify** — and is safe to re-run at any point: a dry run
never sends a transaction, and in execute mode the bytecode diff skips every
contract that is already `up-to-date`. The only difference between the
environments is who executes the owner-gated calls.

**QA (`bscTestnetQa` — proxies owned by the QA deployer key): fully automatic**

```bash
bun run deploy:testnet-qa                # 1. dry run: what needs upgrading?
DEPLOY_YES=1 bun run deploy:testnet-qa   # 2. deploys impls AND sends upgradeToAndCall
# 3. paste the printed fields into ADDRESSES["bscTestnetQa"], commit
bun run verify:testnet-qa                # 4. explorer verification
```

**Testnet (`bscTestnet` — proxies owned by a teammate's EOA): hand off calldata**

```bash
bun run deploy:testnet                # 1. dry run: shows "UPGRADE (owner 0x… — calldata only)"
DEPLOY_YES=1 bun run deploy:testnet   # 2. deploys impls, prints the owner tx instead of sending
```

3. Send the printed transaction (`to` / `value` / `data`) to the owner of the
   proxies; they submit it as a plain EOA transaction.
4. After it lands: paste the printed fields into `ADDRESSES["bscTestnet"]`,
   commit, `bun run verify:testnet`.

If the signer in `.env` ever _is_ the proxy owner, this collapses into the
fully automatic QA flow — no script change needed.

**Mainnet (`bsc` — proxies owned by the production Safe): calldata via Safe{Wallet}**

```bash
# 0. (optional, recommended) rehearse on the fork — same output as the real run
DEPLOY_YES=1 bunx hardhat run scripts/deploy.ts --network bscFork

bunx hardhat run scripts/deploy.ts --network bsc                # 1. dry run
DEPLOY_YES=1 bunx hardhat run scripts/deploy.ts --network bsc   # 2. deploy impls + print Safe tx
```

3. In Safe{Wallet}: New transaction → paste `to`, `value = 0`, `data` →
   collect signatures → execute.
4. After the Safe executes: paste the printed fields into `ADDRESSES["bsc"]`,
   commit, `bun run verify:mainnet`, and refresh `abis/` (`bun run abis`) if
   contract source changed.
5. Re-run the dry run — every contract reporting `up-to-date` confirms the
   upgrade is live on-chain **and** the registry is in sync.

One caveat applies to the calldata flows (testnet / mainnet): between step 2
and the owner executing the transaction, do **not** re-run `DEPLOY_YES=1` —
it would deploy another impl and print fresh calldata, orphaning the first
one. Run steps 2→4 as one sitting per upgrade.

### 2.2 · Multi-token initialisation — not skippable

Since the multi-token upgrade the kernel settles each job in the token bound
to it at creation, and both `createJob` and any non-zero-budget `fund` check
that token against an owner-curated allowlist. **The allowlist starts empty.**
A Commerce that has been upgraded but never had `initializeMultiToken` run
reverts `UnsupportedPaymentToken` on every `createJob` and on every `fund`
with a budget — the contract is live but unusable.

`deploy.ts` will not let that happen silently. It reads the `Initializable`
version off the proxy and prints the state as `multi-token init:` in the
plan. What it does depends on where the proxy is:

| Situation                                      | What the script does                                                              | Who executes                  |
| ---------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------- |
| Fresh Commerce                                 | `initialize` via the proxy constructor, then a separate `initializeMultiToken` tx | deployer, directly            |
| Existing proxy, impl bytecode differs          | `initializeMultiToken` calldata rides inside `upgradeToAndCall` — one atomic tx   | proxy owner (Safe on mainnet) |
| Existing proxy, impl already current, not init | a standalone `initializeMultiToken` tx                                            | proxy owner (Safe on mainnet) |
| Already initialised                            | nothing; falls through to allowlist reconciliation below                          | —                             |

On the mainnet path this means the Safe may have **two** transactions to
execute for one upgrade, not one. Check the printed list at the end of the
run and execute all of it — a half-executed upgrade leaves the kernel in the
unusable state above. Re-run the dry run afterwards; `multi-token init:` must
report as complete.

Once initialised, the allowlist is reconciled against `paymentTokens` on
every run: tokens in the list that are not yet supported produce a
`setPaymentTokenSupported(token, true)` call. Reconciliation is **additive
only** — the script never disables a token that is absent from the list, so
removing an entry from `paymentTokens` does not un-support it on-chain. To
disable a token, send `setPaymentTokenSupported(token, false)` deliberately
(see §4).

## 3 · Writing a V2 implementation safely

`AgenticCommerceUpgradeable` and `EvaluatorRouterUpgradeable` are
UUPS-upgradeable. Once a proxy is live, **the storage layout of every
subsequent implementation must remain byte-compatible with the deployed
one** — UUPS only swaps the implementation pointer; it never migrates
storage. A fresh implementation that declares, say, `address public
owner` as its first state variable will alias onto Commerce's live
`paymentToken` slot, permanently locking every `onlyOwner`-gated path.

The three rules below are defense in depth — follow all three.

### 3.1 · Build on the existing V1 source, don't reimplement

The new implementation must either inherit `AgenticCommerceUpgradeable`
(or `EvaluatorRouterUpgradeable`) directly, or be produced by editing
that source in place. Never write a from-scratch contract that targets
the same ABI — even when the external ABI matches, the storage layout
almost certainly will not, and the proxy will brick on the first
`onlyOwner` call.

For method-only changes, use
[`contracts/mocks/AgenticCommerceV2Mock.sol`](../contracts/mocks/AgenticCommerceV2Mock.sol)
and [`contracts/mocks/EvaluatorRouterV2Mock.sol`](../contracts/mocks/EvaluatorRouterV2Mock.sol)
as templates — both inherit V1, add no new state, and stay storage-safe
by construction.

### 3.2 · Add new state by appending — never insert, reorder, or remove

When new state variables are required, edit the V1 source directly:
append the field at the end of the existing declarations and shrink the
reserved `__gap` by the number of slots consumed.

For `AgenticCommerceUpgradeable` (flat layout, slots 0–5 plus
`__gap[44]`):

```solidity
// In AgenticCommerceUpgradeable.sol, AFTER `jobHasBudget`,
// BEFORE the existing __gap:
address public newField;          // slot 6
uint256[43] private __gap;        // was [44]
```

For `EvaluatorRouterUpgradeable` (ERC-7201 layout, namespace
`apex.router.storage.v1`): append the new field to the `RouterStorage`
struct. **Never change the namespace id.**

**Never** reorder, remove, retype, or insert before existing fields in
either contract.

### 3.3 · Validate the storage layout before upgrading

Before issuing the `upgradeToAndCall` transaction, run the OpenZeppelin
storage-layout diff:

```ts
// scripts/validate-upgrade.ts (sketch)
import hre from "hardhat";
await hre.upgrades.validateUpgrade(
  proxyAddress,
  await hre.ethers.getContractFactory("AgenticCommerceV2"),
  { kind: "uups" },
);
```

`@openzeppelin/hardhat-upgrades` (backed by
`@openzeppelin/upgrades-core`) compares the deployed implementation's
layout against the new one and refuses upgrades that shift, remove, or
retype any existing slot. It's the single most effective guardrail —
even when §3.1 and §3.2 have been followed correctly, run the validator
anyway.

## 4 · Managing the payment-token allowlist

Adding or removing a settlement token no longer requires a redeploy. The
allowlist is owner-gated state on the live Commerce:

```solidity
commerce.setPaymentTokenSupported(token, true);   // admit
commerce.setPaymentTokenSupported(token, false);  // withdraw
```

The routine way to admit a token is to add it to `paymentTokens` in
`scripts/addresses.ts` and re-run `bun run deploy:<env>`, which emits the
call (or the Safe calldata) as part of the normal reconciliation described
in §2.2. Withdrawal is never generated by the script and must be sent
deliberately.

`paymentToken` itself is still set once in `commerce.initialize` and has no
setter, but it is now only the **default** token — what `createJob` picks
when the caller does not name one via `createJobWithToken`, and what
`jobPaymentToken` returns for jobs created before the multi-token upgrade.
Rotating the default therefore still means a fresh Commerce + Router +
Policy (clear `paymentToken` in `scripts/addresses.ts` and re-run the
deploy; in-flight jobs on the old Commerce drain via
`oldCommerce.claimRefund(jobId)` after expiry). For everything else —
supporting a new stablecoin, dropping one — use the allowlist and leave the
deployment alone.

### 4.1 · Admission criteria

The on-chain check in `setPaymentTokenSupported` only verifies that the
address holds code. It cannot see token behaviour, so the class
requirements documented on the `paymentToken` storage variable are entirely
a deployer responsibility. Before admitting a token, confirm against its
**verified source**, not its documentation, that it is a plain ERC-20:

- `transfer` / `transferFrom` deliver exactly the requested amount — no
  fee-on-transfer, reflection or deflationary mechanics;
- no rebasing or elastic supply;
- no blocklist or fee toggle that can change transfer semantics mid-job;
- `balanceOf(address)` cannot decrease without an outgoing transfer from
  that address;
- if the token is upgradeable, its upgrade key is at least as trustworthy
  as the Commerce owner, since it can retroactively introduce any of the
  above.

The kernel takes `job.budget` at face value and does not reconcile
pre/post `balanceOf` in `fund`. A token that violates these assumptions
causes silent escrow drift that surfaces as a revert at settlement:
clients still recover escrow via `claimRefund` after `expiredAt`, but
providers and the treasury cannot collect.

### 4.2 · Withdrawing a token

Withdrawal takes effect immediately and is not retroactive, which cuts both
ways:

- Jobs already `Funded` in that token settle and refund normally —
  `complete`, `reject` and `claimRefund` do not re-check the allowlist, so
  escrow already held is never stranded.
- Jobs created in that token but **not yet funded** are stuck: `fund`
  re-checks support and will revert `UnsupportedPaymentToken`. The client's
  escape is `reject(jobId, …)`, which is client-callable while the job is
  Open and costs nothing since no escrow was taken. A client who does
  neither leaves the job to expire, and on the Router that job's
  `jobInflightCount` slot is only reclaimed once someone calls
  `router.markExpired(jobId)` after `expiredAt`.

So when withdrawing a token under time pressure, announce it, and expect to
run `router.markExpired` over the abandoned jobs afterwards if a Router
migration is on the roadmap.

## 5 · Verify on the block explorer

`scripts/verify.ts` reads [`scripts/addresses.ts`](../scripts/addresses.ts)
plus the deploy params from `.env` and Etherscan-verifies the full stack
(both UUPS implementations, both `ERC1967Proxy` wrappers, `OptimisticPolicy`,
and the `ERC20MinimalMock` if `deploy.ts` minted one) with zero manual
arguments. It is idempotent — re-running it on an already-verified contract
is a no-op.

```bash
# requires ETHERSCAN_API_KEY in .env
bun run verify:testnet
```

Canonical source of truth for deployed addresses: [`scripts/addresses.ts`](../scripts/addresses.ts).
Both proxies AND their current UUPS implementations (`commerceImpl`,
`routerImpl`) are tracked there — `deploy.ts` prints every address on every
run, you paste them back into the same entry and commit, and `verify.ts`
picks them up from that file.

## 6 · Post-deploy ownership transfer

Deployer holds full control of Commerce / Router / Policy immediately after
deploy. Transfer to the production multisig ASAP via the two-step flow (the
multisig must accept on the second step for the change to take effect):

```solidity
// Commerce + Router use OpenZeppelin Ownable2Step
commerce.transferOwnership(multisig);
router.transferOwnership(multisig);
// ... then, signed by the multisig:
commerce.acceptOwnership();
router.acceptOwnership();

// OptimisticPolicy uses a matching custom pattern
policy.transferAdmin(multisig);
// ... signed by the multisig:
policy.acceptAdmin();
```

After the multisig has accepted ownership, it MUST:

1. Add ≥ `INITIAL_QUORUM` voters via `policy.addVoter(addr)`.
2. Whitelist any additional policies via
   `router.setPolicyWhitelist(addr, true)` (the deployer-run policy is
   whitelisted automatically before ownership handoff).
3. Confirm the payment-token allowlist matches intent —
   `commerce.isPaymentTokenSupported(token)` for each entry in
   `paymentTokens`, including `paymentToken` itself (§2.2). From here on,
   admitting a token requires the multisig and the §4.1 criteria apply.

## 7 · QA environment (`bscTestnetQa`)

`bscTestnetQa` is a long-lived QA deployment that lives on the **same chain**
as `bscTestnet` (BSC Testnet, chainId 97, same RPC). The network **name** is
the primary key everywhere — hardhat `networks`, npm scripts, and the
`ADDRESSES` table — and chainId is just a field, so both environments coexist
on one chain without colliding (same approach as hardhat-deploy's
`deployments/<name>/` or Ignition's `--deployment-id`).

Differences from `bscTestnet`:

- **Deployer key:** `BSC_TESTNET_QA_PRIVATE_KEY` in `.env` — a dedicated
  wallet, never the `bscTestnet` deployer, so the two environments don't
  share nonces or funds. Fund it with tBNB before the first deploy.
- **Addresses:** tracked under `ADDRESSES["bscTestnetQa"]` in
  [`scripts/addresses.ts`](../scripts/addresses.ts). This repo entry is the
  **source of truth** for QA addresses — `bnbagent-sdk` does not hardcode
  them; consumers (SDK / studio) receive them via runtime injection.

The workflow is the standard one from §1–§5, with the `-qa` scripts:

```bash
# first deploy: paymentToken is blank in ADDRESSES["bscTestnetQa"], so this
# does a full-stack rotation (fresh mock token + Commerce + Router + Policy).
# To reuse an existing token instead, pre-fill paymentToken / treasury first.
bun run deploy:testnet-qa

# paste the printed address block back into ADDRESSES["bscTestnetQa"] and commit

bun run verify:testnet-qa

# optional: E2E against the QA stack (owner key = BSC_TESTNET_QA_PRIVATE_KEY)
bun run e2e:testnet-qa
```

Subsequent runs of `bun run deploy:testnet-qa` follow the same cascade as any
other network: filled proxies get impl upgrades, blank fields get fresh
deploys, and the policy is always rotated.
