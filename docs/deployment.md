# APEX Deployment Runbook

Operational guide for deploying APEX v1 to BSC Testnet / Mainnet, verifying
the full stack on the block explorer, rotating `paymentToken`, and handing
ownership to a production multisig. One command (`bun run deploy:<env>`)
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

| Field           | Filled → reuse                                                                          | Blank → deploy                                                                                                                                       |
| --------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paymentToken`  | use that ERC-20                                                                         | deploy fresh `ERC20MinimalMock` **and** force fresh Commerce + Router + Policy (cascade; `commerceProxy` / `routerProxy` are ignored in this branch) |
| `treasury`      | passed into `commerce.initialize` on fresh path; logged only on reuse path              | fall back to the deployer                                                                                                                            |
| `commerceProxy` | keep proxy; deploy new impl + signed `upgradeToAndCall`                                 | deploy fresh impl + `ERC1967Proxy` + `initialize` **and** force fresh Router (so it doesn't dangle)                                                  |
| `routerProxy`   | keep proxy; deploy new impl + signed `upgradeToAndCall` (requires Commerce was reused)  | deploy fresh impl + `ERC1967Proxy` + `initialize`                                                                                                    |
| `policy`        | (always rotated; the stored value is only used to print a "revoke old policy" reminder) | always freshly deployed + whitelisted                                                                                                                |

The canonical version of this cascade lives as JSDoc at the top of
[`scripts/addresses.ts`](../scripts/addresses.ts) — if the table above ever
drifts, that file wins.

## 2 · Deploy

```bash
cp .env.example .env
# fill BSC_TESTNET_PRIVATE_KEY (and ETHERSCAN_API_KEY if you plan to verify)
bun run deploy:testnet
```

`deploy.ts` prints a block of `0x…` values; paste the ones it emits under the
same `ADDRESSES` entry and commit. Subsequent runs will reuse them. The same
command handles first deploys, impl upgrades, and full-stack rotations —
there is no separate `upgrade:*` script.

The reuse paths of `commerceProxy` / `routerProxy` require the signer to
still be the **owner** of both proxies — `upgradeToAndCall` and
`setPolicyWhitelist` are owner-gated, and `deploy.ts` pre-checks `owner()`
on both proxies before touching them. Once ownership has been transferred
to the production multisig, run impl upgrades and policy rotations from the
multisig directly.

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

## 4 · Rotating `paymentToken`

`paymentToken` is set in `commerce.initialize` and has no setter. To rotate
it, **clear `paymentToken` in `scripts/addresses.ts`** and re-run
`bun run deploy:<env>`. The script deploys a brand-new `ERC20MinimalMock`
(or, if you paste a real token address into `paymentToken` first, uses that
instead), plus fresh Commerce + Router + Policy. The old Commerce / Router
stay on-chain; any in-flight jobs against the old Commerce must drain via
`oldCommerce.claimRefund(jobId)` after expiry (`claimRefund` is never
pausable nor hookable).

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
