# APEX Contracts

## Project Overview

APEX (Agent Payment Exchange) Protocol v1 — a lightweight [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) Agentic Commerce Protocol deployment paired with a pluggable, UMA-style optimistic evaluator. Two agents (a Client who pays and a Provider who delivers) transact around the ERC-8183 job lifecycle: create → fund → submit → evaluate → settle. The evaluator is a Router that routes each job to a policy contract; the only v1 policy is `OptimisticPolicy`: default-approve after a dispute window, but a client-raised dispute triggers a whitelisted-voter quorum reject.

See `docs/design.md` for the authoritative design. ERC-8183 compliance status (including the exact spec version reviewed against) is tracked in `docs/erc-8183-compliance.md`.

## Tech Stack

- **Language:** Solidity `0.8.28` (EVM `cancun`, optimizer `200 runs`, `viaIR: true`).
- **Framework:** Hardhat 3 (`@nomicfoundation/hardhat-toolbox-viem`) with `hardhat-viem`, `hardhat-ethers`, `hardhat-verify`.
- **Libraries:** OpenZeppelin `@openzeppelin/contracts@5.4.0` + `@openzeppelin/contracts-upgradeable@5.4.0` (pinned — storage-layout audit required to bump).
- **Proxy pattern:** UUPS (ERC-1967). `AgenticCommerceUpgradeable` uses flat upgradeable storage; `EvaluatorRouterUpgradeable` uses ERC-7201 namespaced storage (`apex.router.storage.v1`).
- **Test runner:** Bun's test runner (`bun test`) — consumes the `node:test` API (`describe`/`it`/`before` + `node:assert/strict`) natively, viem-based assertions.
- **TypeScript:** `~5.8.0`; viem `^2.38.0`; ethers `^6.15.0` (used for keccak/abi utils). TS files are executed directly by Bun (no tsx/ts-node loader).
- **Runtime:** Bun `>= 1.3` for dev/test; Node.js `>= 22.10.0` is still required by Hardhat 3 when `bunx hardhat` shells out to its runtime. Package manager: bun (lockfile: `bun.lock`).
- **Linting / formatting:** `solhint@6.x` (`.solhint.json`) for Solidity static checks; `prettier@3.x` + `prettier-plugin-solidity@2.x` (`.prettierrc`) for `.sol` + `.ts` + `.md` + `.json` formatting. Invoked via `bun run lint:sol` / `bun run format{,:check}`.

## Architecture

Three-layer design:

```
contracts/
  AgenticCommerceUpgradeable.sol   # ERC-8183 kernel (UUPS, Pausable)
  EvaluatorRouterUpgradeable.sol   # UUPS routing layer (acts as job.evaluator + job.hook)
  OptimisticPolicy.sol             # Immutable policy: silence-approve + dispute/quorum
  IACP.sol                         # Implementation-level kernel interface
  IPolicy.sol                      # Router ↔ policy interface
  IACPHook.sol                     # ERC-8183 hook interface
  ERC1967Proxy.sol                 # Test-helper proxy wrapper
  MockERC20.sol                    # Test payment token
scripts/
  deploy.ts                        # One-shot stack deployment (print-only; no file side-effects)
  upgrade-commerce.ts              # Upgrade kernel impl
  upgrade-router.ts                # Upgrade router impl (emergency only)
  addresses.ts                     # Hand-committed registry of deployed proxy/policy addresses
test/
  helpers.ts                       # Shared test fixtures
  AgenticCommerce.test.ts
  EvaluatorRouter.test.ts
  OptimisticPolicy.test.ts
  Lifecycle.test.ts
docs/
  design.md                        # Canonical design document
  erc-8183-compliance.md           # ERC-8183 compliance matrix + change log
hardhat.config.ts                  # Networks (bscTestnet, bsc, bscTestnetFork, localhost)
```

**Key architectural constraints (never violate without an upgrade audit):**

- `AgenticCommerceUpgradeable` uses **flat upgradeable storage** (6 slots + `__gap[44]`). Never reorder or remove fields; only append by shrinking `__gap`.
- `EvaluatorRouterUpgradeable` uses **ERC-7201 namespaced storage** with id `apex.router.storage.v1`. Never change the namespace; only append fields to `RouterStorage`.
- `claimRefund()` on the kernel is **not pausable** and **not hookable** — this is a deliberate safety property and the universal escape hatch at expiry.
- `OptimisticPolicy` maintains the invariant `voteQuorum ≤ activeVoterCount`. `setQuorum` and `removeVoter` both revert when the invariant would break.
- Router's `beforeAction` / `afterAction` are **not** `nonReentrant` — they sit on the reentrant path `settle → commerce.complete → router.afterAction`. Access control relies on `msg.sender == commerce`.
- Router is UUPS; it doubles as the ERC-8183 `job.hook`. This deviates from ERC-8183's `SHOULD NOT` for upgradeable hooks. Mitigation: multisig + TimelockController; operational default is NEVER UPGRADE. Prefer drain-and-redeploy via `router.pause()` + expiry refund.

## Common Commands

```bash
# Install
bun install

# Build
bun run compile                   # == bunx hardhat compile

# Tests (62 tests, ~1.3s)
bun test
bun run test:commerce
bun run test:router
bun run test:policy
bun run test:lifecycle

# Formatting + lint
bun run format                    # Prettier (+ prettier-plugin-solidity) write
bun run format:check              # CI gate: fails if anything drifts
bun run lint:sol                  # solhint — 0 errors required (warnings ok)

# Local node
bun run node                      # == bunx hardhat node

# Local development (in a second terminal after `bun run node`)
bun run deploy:local              # Uses .env; deploys stack to localhost
bun run fund:local                # Sends ETH + MockERC20 to FUND_RECIPIENT

# Deployment (BSC Testnet)
bun run deploy:testnet            # Uses .env.testnet

# Upgrades (ownership MUST be multisig + TimelockController on production)
bun run upgrade:commerce:testnet
bun run upgrade:router:testnet

# Verification (manual)
bunx hardhat verify --network bscTestnet <impl_address>
```

Required env files per environment (loaded via `DOTENV_CONFIG_PATH`):

- `.env.testnet` — public testnet deploy
- `.env` — default fallback (used if `DOTENV_CONFIG_PATH` unset; local dev)

Never commit any of these. See `.env.example` for the full schema.

---

## LANGUAGE RULE — HIGHEST PRIORITY

**Always match the user's language.** If the user writes in Chinese, every word of your reply must be in Chinese. If in English, reply in English. This rule overrides everything else and applies to every single response, including plans, summaries, and error messages. Never mix languages mid-response.

---

## Spec-Driven Workflow — MANDATORY

Follow these steps in strict order for every code change request. If you are about to call Edit/Write/Bash without completing Step 1 and receiving explicit approval — STOP. Go back to Step 1.

### Step 0: Research _(new features only — skip for bug fixes)_

Before planning, surface your understanding:

- **State assumptions explicitly.** If the request has multiple valid interpretations, list them — don't pick one silently. Ask for clarification before proceeding.
- Search for mature libraries that solve the problem. Evaluate trade-offs: proven library vs. custom (maintenance, fit, size).
- **Only build custom if no suitable library exists or the fit is poor.**

Summarize findings, then move to Step 1.

### Step 1: Plan — OUTPUT PLAN, THEN STOP COMPLETELY

Output a plan using this exact format:

```
## Plan
**Goal:** <one sentence>
**Assumptions:** <explicit assumptions; flag any ambiguity>
**Files:** <list of files to create/modify/delete>
**Approach:** <how, key decisions, trade-offs, libraries chosen>
**Verify:** <what success looks like — which test passes, which behavior works>
**Risk:** <what could break, security implications>
```

**HARD RULES:**

- After printing the Plan, your message ENDS. No code. No "I'll start by...".
- Do NOT call Edit, Write, Bash, or any file-modifying tool in this turn.
- Wait for the user to explicitly reply. Explicit approval = "ok", "go", "yes", "继续", "好", or equivalent.
- A clarifying question is NOT approval — answer it and wait again.
- If the user approves but asks for changes, revise the plan and STOP again.

### Step 2: Execute

Implement the approved plan exactly. Rules while executing:

- **Surgical changes only.** Every changed line must trace directly to the task. Don't "improve" adjacent code, comments, or formatting.
- **Minimum code.** No speculative features, no unrequested abstractions, no configurability that wasn't asked for.
- **Dead code:**
  - Orphans YOUR changes created → remove immediately.
  - Pre-existing dead code you notice → mention in Summary, don't delete it.
- If scope needs to change mid-implementation → STOP, go back to Step 1.

### Step 3: Verify

- Run the project's test suite (see Common Commands above).
- Run lint and format checks.
- Run type checking.
- Fix all failures before proceeding.
- Confirm the **Verify** criteria from Step 1 are met.

### Step 4: Summary

```
## Summary
**Changed:** <file list with one-line descriptions>
**Tests:** <tests added/updated/passed>
**Notes:** <dead code noticed, trade-offs made, anything the user should know>
```

Then print a ready-to-run git command — do NOT execute it.

---

## ERC-8183 Spec-Update Protocol

When the user reports that ERC-8183 has published a new version (e.g. "the
spec has been updated", "there's a new 8183 draft", or any equivalent),
treat it as a Step-1 Plan trigger. Do not modify any code yet. Run this
protocol:

1. **Fetch & diff.** Compare the new spec against the version recorded in
   the `Spec version reviewed` header of `docs/erc-8183-compliance.md`.
2. **Plan.** Output a Plan per the Spec-Driven Workflow above, listing
   every normative delta, the affected contracts/tests, and the
   migration-risk classification (small = UUPS upgrade, medium = Router
   interface change, large = fresh deployment).
3. **Wait for approval.** Do not edit until the user explicitly approves.
4. **Update the compliance doc.** After approval — even if no code change
   is needed — refresh `docs/erc-8183-compliance.md`: rewrite the
   `Summary`, update each row of `Detail Items`, adjust the
   `Non-blocking Deltas` section, and append a new `Change Log` entry
   dated today. Bump `Spec version reviewed` and `Last reviewed` in the
   header.
5. **Sync design docs.** If behaviour actually changes, update
   `docs/design.md` so it stays consistent with the code.

---

## Code Quality

- **No redundant code.** Extract repeated logic; never copy-paste.
- **Single responsibility.** One file = one clear purpose. Split large files proactively.
- **No abstractions for single-use code.** Three similar lines > a premature abstraction.
- **No dead code**, no unused imports, no commented-out code (that you wrote).
- Functions: small, single-purpose, early returns.
- Naming: self-explanatory — if it needs a comment, rename it.
- No error handling for impossible scenarios. Trust internal guarantees; validate only at system boundaries.
- Folder structure: clean and intentional.

---

## Security Baseline

- Validate all external input at the system boundary.
- Never log secrets, private keys, or credentials.
- Never hardcode secrets — use environment variables.
- Never commit `.env` or credential files.

---

## Self-Check Before Every Response

Before responding to a code change request:

1. Have I output a Plan yet? If no → go to Step 1.
2. Has the user explicitly approved the Plan? If no → do not write any code.
3. Am I about to call Edit/Write/Bash? If yes and Step 2 hasn't started → STOP.
