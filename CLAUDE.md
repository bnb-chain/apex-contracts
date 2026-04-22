# APEX Contracts

## Project Overview

APEX (Agent Payment Exchange) Protocol — trustless on-chain escrow for autonomous agent-to-agent commerce on BNB Smart Chain. Two AI agents (a Client who pays and a Provider who delivers) transact around a job lifecycle: create → fund → submit → evaluate → settle. An Evaluator (human or contract) attests to work quality before funds release. Dispute resolution runs through [UMA Optimistic Oracle V3](https://docs.uma.xyz/protocol-overview/how-does-umas-oracle-work); extensibility is provided via the [ERC-8183](https://eips.ethereum.org/EIPS/eip-8183) hook interface; contracts are upgradeable via UUPS with stable proxy addresses.

## Tech Stack

- **Language:** Solidity `0.8.28` (EVM `cancun`, optimizer `200 runs`, `viaIR: true`)
- **Framework:** Hardhat 3 (`@nomicfoundation/hardhat-toolbox-viem`) with `hardhat-viem`, `hardhat-ethers`, `hardhat-verify`, `hardhat-keystore`
- **Libraries:** OpenZeppelin `@openzeppelin/contracts@5.4.0` + `@openzeppelin/contracts-upgradeable@5.4.0` (pinned — do not bump without a storage-layout audit)
- **Proxy pattern:** UUPS (ERC-1967) with ERC-7201 namespaced storage on `APEXEvaluatorUpgradeable`; flat upgradeable storage on `AgenticCommerceUpgradeable`
- **Deterministic deploy:** `@safe-global/safe-singleton-factory` (CREATE2) — salts live in upgrade scripts
- **Meta-tx / permit:** ERC-2771 (`ERC2771Context`) and ERC-2612 (`fundWithPermit`)
- **Oracle:** UMA Optimistic Oracle V3 (external contract on BSC Testnet: `0xFc5bb3e475cc9264760Cf33b1e9ea7B87942C709`)
- **Test runner:** Node.js built-in test runner via `tsx` (`node --import tsx --test ...`), viem-based assertions
- **TypeScript:** `~5.8.0`; viem `^2.38.0`; ethers `^6.15.0` (used selectively, primarily for utilities)
- **Runtime:** Node.js `>= 22.10.0` (required by Hardhat 3), package manager: npm / bun (lockfiles: `package-lock.json`, `bun.lock`)
- **Linting:** `solhint` (`.solhint.json`), `prettier` (`.prettierrc`)

## Architecture

Single-package Hardhat project; all on-chain logic lives under `contracts/`.

```
contracts/
  AgenticCommerceUpgradeable.sol  # Core escrow — job lifecycle, fees, pause, meta-tx
  APEXEvaluatorUpgradeable.sol    # UMA OOv3 evaluator — implements IACPHook, initiates assertions, settles
  IACPHook.sol                    # ERC-8183 hook interface (beforeAction / afterAction)
  BaseACPHook.sol                 # Convenience base for custom hooks
  IAPEXEvaluator.sol              # Evaluator interface
  ERC1967Proxy.sol                # UUPS proxy entrypoint
  MockERC20.sol                   # Test-only ERC-20 with permit
  MockOptimisticOracleV3.sol      # Test-only OOv3 mock
scripts/
  deploy-all.ts                   # End-to-end deploy orchestrator (commerce + evaluator + wiring)
  deploy-commerce.ts              # Deploy AgenticCommerce (proxy + impl via CREATE2)
  deploy-evaluator.ts             # Deploy APEXEvaluator (proxy + impl), auto-deposits bond
  upgrade-commerce.ts             # Deploy new impl and call upgradeToAndCall on the commerce proxy
  upgrade-evaluator.ts            # Same, for the evaluator proxy
  set-payment-token.ts            # Admin helper to rotate the payment token
test/
  AgenticCommerce.test.ts         # Commerce unit tests
  APEXEvaluator.test.ts           # Evaluator unit tests
  Upgrades.test.ts                # UUPS upgrade & storage-compat tests
  FullJobLifecycle.test.ts        # End-to-end integration tests
  constants.ts                    # Shared test constants
  deploy.ts                       # Shared test deploy helpers
deployments/
  bsc-testnet.json                # Canonical record of proxy + impl addresses and external deps
hardhat.config.ts                 # Networks (bscTestnet, bsc, bscTestnetFork, localhost), profiles, verify
```

**Key architectural constraints (do not violate without an upgrade audit):**

- `AgenticCommerceUpgradeable` uses **flat upgradeable storage** — never reorder or remove state variables; only append.
- `APEXEvaluatorUpgradeable` uses **ERC-7201 namespaced storage** with namespace id `"apexevaluator.storage"` — never change the namespace string; only append fields to the struct.
- Each new implementation deploy **must bump `NEW_IMPL_SALT`** in the upgrade script (CREATE2 requires a unique salt per deployment).
- `claimRefund()` is **exempt from pause** and **not hookable** — this is a deliberate safety property; do not add `whenNotPaused` or hook callbacks to it.
- Fees total (`platformFeeBP + evaluatorFeeBP`) must stay ≤ `10000` (100%); fees only deduct on `complete()`, never on refund/reject.
- OpenZeppelin version is pinned at `5.4.0` — upgrading requires re-running the full `Upgrades.test.ts` suite and auditing storage slots.

## Common Commands

```bash
# Build
npx hardhat compile

# Tests
npm test                          # Full suite (all 4 test files)
npm run test:commerce             # Commerce unit tests only
npm run test:evaluator            # Evaluator unit tests only
npm run test:upgrades             # UUPS upgrade & storage-layout tests
npm run test:integration          # Full job lifecycle integration

# Local node
npm run node                      # Start an in-process Hardhat node

# Deployment (BSC Testnet)
npm run deploy:testnet            # Uses .env.testnet
npm run deploy:qa                 # Uses .env.qa (separate QA deployment)

# Upgrades (remember to bump NEW_IMPL_SALT in the script first)
npm run upgrade:commerce:testnet
npm run upgrade:evaluator:testnet
npm run upgrade:commerce:qa
npm run upgrade:evaluator:qa

# Admin ops
npm run admin:set-token -- --network bscTestnet

# Verification (manual)
npx hardhat verify --network bscTestnet <impl_address>
```

Required env files per environment (loaded via `DOTENV_CONFIG_PATH`):

- `.env.testnet` — public testnet deploy
- `.env.qa` — QA deploy (separate keys/addresses from testnet)
- `.env` — default fallback (used if `DOTENV_CONFIG_PATH` unset)

Never commit any of these. See `.env.example` for the full schema.

---

## LANGUAGE RULE — HIGHEST PRIORITY

**Always match the user's language.** If the user writes in Chinese, every word of your reply must be in Chinese. If in English, reply in English. This rule overrides everything else and applies to every single response, including plans, summaries, and error messages. Never mix languages mid-response.

---

## Spec-Driven Workflow — MANDATORY

Follow these steps in strict order for every code change request. If you are about to call Edit/Write/Bash without completing Step 1 and receiving explicit approval — STOP. Go back to Step 1.

### Step 0: Research *(new features only — skip for bug fixes)*

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
