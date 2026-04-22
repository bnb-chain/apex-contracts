# E2E Runner

End-to-end runner that drives the 5 ERC-8183 user flows (docs/design.md §4)
against a real chain. Two modes:

- **local** — uses a fresh Hardhat node and its prefunded accounts; fast
  (~15 s) because the runner advances chain time via `evm_increaseTime`.
- **testnet** — reuses the live Commerce + Router proxies recorded in
  `scripts/addresses.ts`, deploys a short-window Policy just for this run,
  and drives the flows in real time (~12 min on BSC Testnet).

Unit tests live in `test/unit/` and are entirely separate — `bun test` does
not touch the E2E files.

## Layout

```
test/e2e/
  runner.ts            Entry point; orchestrates all flows
  config.ts            Env parsing + timing validation
  context.ts           Deploys / reuses the stack, returns E2EContext
  lib/
    wallets.ts         Local: getWalletClients(); testnet: privateKey → wallet
    wait.ts            Tx receipt + chain-timestamp pollers
    time.ts            Unified advance/waitUntil (fast-forward on local)
    preflight.ts       Testnet balance + ownership checks
    logging.ts         Step / tx / pass / fail output (BscScan aware)
    assertions.ts      Job-status + balance-delta assertions
  flows/
    _helpers.ts        prepareJob(): createJob → register → setBudget → [fund] → [submit]
    happy.ts           Flow A · silence-approve
    dispute-reject.ts  Flow B · dispute + quorum → reject
    stalemate-expire.ts Flow C · dispute + no quorum → claimRefund
    open-cancel.ts     Flow D · Open-state client reject (no escrow)
    never-submit.ts    Flow E · funded but no submit → claimRefund
    index.ts           Flow registry
```

## Local

One-time:

```bash
bun install
bun run compile
```

Per-run (two terminals):

```bash
# terminal A
bun run node

# terminal B
bun run e2e:local
```

Expected total wall-clock: **~15 seconds** (chain time is fast-forwarded).

## Testnet (BSC Testnet)

### Preconditions

1. `scripts/addresses.ts[bscTestnet].commerceProxy` and `.routerProxy` are
   filled. If not, run `bun run deploy:testnet` once and paste the printed
   block back into `addresses.ts`.
2. Router ownership is still held by an EOA you control. If `router.owner()`
   has already been transferred to a multisig, the E2E cannot whitelist its
   own short-window policy and will exit with a clear error.

### Wallets & balances

The runner reuses `BSC_TESTNET_PRIVATE_KEY` (already required by hardhat for
the `bscTestnet` network) as the owner, so in the minimal setup **no extra
keys are needed at all**. When `E2E_CLIENT_KEY` / `E2E_PROVIDER_KEY` are
left unset, that same EOA plays every role (owner + client + provider +
voter). The kernel places no "client ≠ provider" constraint and the
happy-path assertion is built around per-address delta aggregation, so
collapsing roles is algebraically correct.

| env var                   | required | defaults to                 |
| ------------------------- | -------- | --------------------------- |
| `BSC_TESTNET_PRIVATE_KEY` | ✓        | — (used as owner)           |
| `E2E_CLIENT_KEY`          |          | `BSC_TESTNET_PRIVATE_KEY`   |
| `E2E_PROVIDER_KEY`        |          | `BSC_TESTNET_PRIVATE_KEY`   |

Minimum balances (BSC Testnet, one E2E cycle). Per-role BNB minima are
summed per distinct EOA, so a single-key run needs the **total**:

| Role     | BNB (gas) | Payment token                             |
| -------- | --------- | ----------------------------------------- |
| owner    | ≥ 0.02    | —                                         |
| client   | ≥ 0.03    | ≥ `4 × E2E_BUDGET_UNITS` (funded by you)  |
| provider | ≥ 0.005   | —                                         |

- **1-key mode** (default): one EOA needs ≥ **0.055 BNB** + `≥ 4 × budget`
  tokens.
- **3-key mode**: each of the three wallets needs only its own row from the
  table above.

The payment-token address is whatever `commerce.paymentToken()` returns;
preflight prints it before any tx is sent. Client is debited `budget` per
funded flow but only net `(1 − platformFeeBP) × budget` ever leaves — all
flows except A refund the client — so `~4 × budget` tokens comfortably
covers several full runs.

> Note on the happy-path assertion: if the same EOA is client + provider,
> the combined delta is `−fee` (the client is exactly `fee` poorer after
> Flow A). When `platformFeeBP == 0` on the deployed Commerce, delta is 0.
> If you prefer to see the full `+net` / `−budget` split, use 3-key mode.

### Steps

1. Copy `.env.example` to `.env.testnet` and fill in, at minimum:

   ```
   BSC_TESTNET_RPC_URL=https://data-seed-prebsc-2-s3.binance.org:8545
   BSC_TESTNET_PRIVATE_KEY=<router owner PK — same key you deployed with>
   # E2E_CLIENT_KEY and E2E_PROVIDER_KEY are optional — leave blank for 1-key mode.
   ```

2. Top up that wallet with BNB + paymentToken per the minima above (or top
   up three wallets if you enabled 3-key mode).

3. Run:

   ```bash
   bun run e2e:testnet
   ```

Expected total wall-clock: **~12-15 minutes** (flows C and E each wait
past `expiredAt`; BSC Testnet block time ~3 s).

## Environment variables

All optional overrides (numbers are seconds unless stated):

| Variable                      | Default | Purpose                                    |
| ----------------------------- | ------- | ------------------------------------------ |
| `E2E_DISPUTE_WINDOW_SECONDS`  | 15      | Short dispute window for the E2E Policy    |
| `E2E_JOB_EXPIRY_SECONDS`      | 360     | Must be `> 300` (kernel enforces)          |
| `E2E_SLACK_SECONDS`           | 3       | Buffer added to time waits                 |
| `E2E_BUDGET_UNITS`            | 1       | Whole-unit budget per funded flow          |
| `E2E_INITIAL_QUORUM`          | 2 local / 1 testnet | Voters needed to reach Reject  |
| `E2E_FAIL_FAST`               | true    | Stop after the first failing flow          |

## What each flow verifies

- **A · happy** — silence past window → settle routes to `commerce.complete`;
  provider receives `net = budget − fee`, treasury receives `fee`.
- **B · dispute-reject** — client dispute + `quorum` reject votes → settle
  routes to `commerce.reject`; client refunded.
- **C · stalemate-expire** — client dispute with zero reject votes; settle
  reverts `NotDecided`; after expiry, kernel `claimRefund` returns escrow.
  Proves the policy stays Pending and the escape hatch works.
- **D · open-cancel** — client rejects an Open (un-funded) job; no escrow
  involved; terminal status `Rejected`.
- **E · never-submit** — fund with no submit; after expiry, `claimRefund`
  returns escrow. Terminal status `Expired`.

## Common errors

- **`Router owner mismatch`** — `BSC_TESTNET_PRIVATE_KEY` does not resolve
  to the current `router.owner()`. Either point the env var at the current
  owner or transfer ownership back to the deployer key.
- **`client token balance < …`** — top up the client wallet with the
  payment token printed by the preflight banner.
- **`settle should have reverted with NotDecided`** — likely caused by
  `E2E_INITIAL_QUORUM` being set below the number of voters you're letting
  Flow B cast; check `E2E_INITIAL_QUORUM` and the `voters` list in
  `test/e2e/lib/wallets.ts`.
