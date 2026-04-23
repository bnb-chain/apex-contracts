# Gov Scripts

Governance scripts for APEX contracts. Each script supports two invocation modes.

## Invocation modes

### Direct (Bun)

```bash
bun scripts/gov/commerce.ts pause --dry-run
bun scripts/gov/commerce.ts setPlatformFee --fee-bp 100 --treasury 0xYourAddr
```

### Via Hardhat (`bunx hardhat run`)

Hardhat 3 consumes all CLI flags itself and does not forward them to scripts.
Use the `GOV_ARGS` environment variable to pass the operation name and flags:

```bash
# Dry-run a pause op on local node:
GOV_ARGS="pause --dry-run" bunx hardhat run scripts/gov/commerce.ts --network localhost

# Set platform fee on testnet:
GOV_ARGS="setPlatformFee --fee-bp 100 --treasury 0xYourAddr" bunx hardhat run scripts/gov/commerce.ts --network bscTestnet

# Router: whitelist a new policy:
GOV_ARGS="setPolicyWhitelist --policy 0xPolicyAddr --status true" bunx hardhat run scripts/gov/router.ts --network bscTestnet

# Policy: add a voter (dry-run):
GOV_ARGS="addVoter --voter 0xVoterAddr --dry-run" bunx hardhat run scripts/gov/policy.ts --network bscTestnet
```

### Via package.json scripts

The `bun run gov:*` aliases use `bunx hardhat run` under the hood.
Set `GOV_ARGS` before calling them:

```bash
GOV_ARGS="pause --dry-run" bun run gov:commerce:local
GOV_ARGS="setPlatformFee --fee-bp 100 --treasury 0xYourAddr" bun run gov:commerce:testnet
```

## Runbooks (no GOV_ARGS needed)

Runbooks are invoked directly — they have no CLI flags (they read everything from `scripts/addresses.ts`):

```bash
bunx hardhat run scripts/gov/runbooks/deploy-timelock.ts --network bscTestnet
bunx hardhat run scripts/gov/runbooks/transfer-ownership.ts --network bscTestnet
GOV_ARGS="--skip-revoke" bunx hardhat run scripts/gov/runbooks/rotate-policy.ts --network bscTestnet
GOV_ARGS="--commerce" bunx hardhat run scripts/gov/runbooks/upgrade.ts --network bscTestnet
```
