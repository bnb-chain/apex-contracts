# Governance Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the governance script suite defined in `docs/superpowers/specs/2026-04-23-governance-scripts-design.md` — per-contract operations, runbooks, Safe SDK integration, and dry-run simulation — with TDD via forked-network fixtures.

**Architecture:** Three-layer TypeScript under `scripts/gov/`: a `lib/` core (config + exec + safe wrapper), per-contract CLIs (`commerce.ts` / `router.ts` / `policy.ts`) that build `CallItem[]` and pass to `exec()`, and runbooks (`runbooks/*.ts`) that compose multi-step flows. `addresses.ts` gains two new fields (`multisig`, `timelockProxy`). Execution mode (EOA / calldata / Safe-propose / dry-run) is selected by `exec()` based on config and CLI flags — the calling scripts never touch signers or Safe SDK directly.

**Tech Stack:** Hardhat 3 + `hardhat-viem` (existing), `viem ^2.38`, Node built-in `util.parseArgs` for CLI parsing, `@safe-global/protocol-kit ^5` + `@safe-global/api-kit ^2` (new), OZ `TimelockController` (via `@openzeppelin/contracts@5.4.0`, already installed).

---

## File Structure

```
scripts/
  addresses.ts                          # MODIFY: add multisig + timelockProxy fields
  gov/
    lib/
      cli.ts                            # CREATE: parseArgs wrapper (subcommand + flags)
      config.ts                         # CREATE: builds GovContext from ADDRESSES
      exec.ts                           # CREATE: execution dispatch (mode selection)
      safe.ts                           # CREATE: Safe SDK wrapper (propose + batch)
      types.ts                          # CREATE: CallItem, GovContext, ExecMode types
    commerce.ts                         # CREATE: Commerce ops CLI
    router.ts                           # CREATE: Router ops CLI
    policy.ts                           # CREATE: Policy ops CLI
    runbooks/
      deploy-timelock.ts                # CREATE: TimelockController deploy
      transfer-ownership.ts             # CREATE: batch ownership transfer to timelock
      rotate-policy.ts                  # CREATE: new policy + whitelist + revoke
      upgrade.ts                        # CREATE: impl deploy + upgradeToAndCall
test/
  unit/
    gov/
      cli.test.ts                       # CREATE: CLI arg parsing tests
      exec.test.ts                      # CREATE: exec mode dispatch tests
      commerce.test.ts                  # CREATE: Commerce ops fork tests
      router.test.ts                    # CREATE: Router ops fork tests
      policy.test.ts                    # CREATE: Policy ops fork tests
      runbooks/
        deploy-timelock.test.ts         # CREATE
        transfer-ownership.test.ts      # CREATE
        rotate-policy.test.ts           # CREATE
        upgrade.test.ts                 # CREATE
package.json                            # MODIFY: add gov:* scripts + Safe deps
```

---

## Task 1: Bootstrap — directory, deps, addresses.ts

**Files:**

- Create: `scripts/gov/lib/types.ts`
- Modify: `scripts/addresses.ts`
- Modify: `package.json`

- [ ] **Step 1: Create directory skeleton**

```bash
mkdir -p scripts/gov/lib scripts/gov/runbooks test/unit/gov/runbooks
```

- [ ] **Step 2: Add Safe SDK devDependencies**

Run:

```bash
bun add -d @safe-global/protocol-kit@^5 @safe-global/api-kit@^2
```

Expected: `package.json` gains the two deps; `bun.lock` updates.

- [ ] **Step 3: Extend `DeployedAddresses` in `scripts/addresses.ts`**

Replace the existing `DeployedAddresses` type with:

```ts
export type DeployedAddresses = {
  readonly paymentToken?: `0x${string}`;
  readonly treasury?: `0x${string}`;
  readonly commerceProxy?: `0x${string}`;
  readonly routerProxy?: `0x${string}`;
  readonly policy?: `0x${string}`;
  readonly timelockProxy?: `0x${string}`;
  readonly multisig?: `0x${string}`;
};
```

Leave `ADDRESSES` table entries unchanged — the two new fields are optional.

- [ ] **Step 4: Create `scripts/gov/lib/types.ts`**

```ts
import type { DeployedAddresses } from "../../addresses.js";

export type ExecMode = "eoa" | "calldata" | "propose" | "dry-run";

export type CallItem = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  description: string;
};

export type GovContext = {
  cfg: DeployedAddresses;
  networkName: string;
  deployer: `0x${string}`;
  mode: ExecMode;
  // viem contract handles — typed as unknown here to avoid coupling lib/types
  // to specific contract names; individual scripts cast to the contract they use.
  viem: unknown;
};
```

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/lib/types.ts scripts/addresses.ts package.json bun.lock
git commit -m "chore(gov): scaffold scripts/gov/ + Safe SDK deps + addresses fields"
```

---

## Task 2: CLI argument parsing (`lib/cli.ts`)

Background: scripts are invoked via `bunx hardhat run scripts/gov/<file>.ts --network bscTestnet -- <op> [--flag value]`. Everything after `--` lands in `process.argv`; we parse operation name + key/value flags.

**Files:**

- Create: `scripts/gov/lib/cli.ts`
- Create: `test/unit/gov/cli.test.ts`

- [ ] **Step 1: Write failing test `test/unit/gov/cli.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGovArgs } from "../../../scripts/gov/lib/cli.js";

describe("parseGovArgs", () => {
  it("extracts operation name and string flags", () => {
    const argv = ["node", "script.ts", "setPlatformFee", "--fee-bp", "100", "--treasury", "0xabc"];
    const result = parseGovArgs(argv);
    assert.equal(result.op, "setPlatformFee");
    assert.equal(result.flags["fee-bp"], "100");
    assert.equal(result.flags["treasury"], "0xabc");
  });

  it("treats --dry-run and --propose as boolean flags", () => {
    const argv = ["node", "script.ts", "pause", "--dry-run"];
    const result = parseGovArgs(argv);
    assert.equal(result.op, "pause");
    assert.equal(result.flags["dry-run"], true);
  });

  it("defaults op to empty string when first positional is a flag", () => {
    const argv = ["node", "script.ts", "--dry-run"];
    const result = parseGovArgs(argv);
    assert.equal(result.op, "");
    assert.equal(result.flags["dry-run"], true);
  });

  it("throws on unknown flag names if a schema is provided", () => {
    assert.throws(
      () =>
        parseGovArgs(["node", "script.ts", "pause", "--bogus", "x"], {
          knownFlags: ["dry-run", "propose"],
        }),
      /unknown flag: bogus/,
    );
  });
});
```

- [ ] **Step 2: Run the test to confirm failure**

```bash
bun test test/unit/gov/cli.test.ts
```

Expected: FAIL — `parseGovArgs` not defined.

- [ ] **Step 3: Implement `scripts/gov/lib/cli.ts`**

```ts
export type ParsedArgs = {
  op: string;
  flags: Record<string, string | boolean>;
};

const BOOLEAN_FLAGS = new Set(["dry-run", "propose"]);

export function parseGovArgs(argv: string[], opts: { knownFlags?: string[] } = {}): ParsedArgs {
  const known = opts.knownFlags ? new Set([...opts.knownFlags, ...BOOLEAN_FLAGS]) : null;
  const tokens = argv.slice(2);
  let op = "";
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      const name = tok.slice(2);
      if (known && !known.has(name)) throw new Error(`unknown flag: ${name}`);
      if (BOOLEAN_FLAGS.has(name)) {
        flags[name] = true;
      } else {
        const value = tokens[i + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`flag --${name} requires a value`);
        }
        flags[name] = value;
        i++;
      }
    } else if (op === "") {
      op = tok;
    } else {
      throw new Error(`unexpected positional argument: ${tok}`);
    }
  }

  return { op, flags };
}

export function requireString(flags: Record<string, string | boolean>, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v.length === 0) throw new Error(`missing --${name}`);
  return v;
}

export function requireAddress(
  flags: Record<string, string | boolean>,
  name: string,
): `0x${string}` {
  const v = requireString(flags, name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`--${name} is not a valid address: ${v}`);
  return v as `0x${string}`;
}
```

- [ ] **Step 4: Run the test to confirm pass**

```bash
bun test test/unit/gov/cli.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/lib/cli.ts test/unit/gov/cli.test.ts
git commit -m "feat(gov): cli arg parser (subcommand + flag schema)"
```

---

## Task 3: GovContext builder (`lib/config.ts`)

**Files:**

- Create: `scripts/gov/lib/config.ts`

- [ ] **Step 1: Implement `scripts/gov/lib/config.ts`**

No dedicated test — it's tested transitively by every other fork test. Keep it small and obvious.

```ts
import { getAddress } from "viem";
import { ADDRESSES } from "../../addresses.js";
import type { ExecMode, GovContext } from "./types.js";
import { parseGovArgs, type ParsedArgs } from "./cli.js";

type NetworkConnection = {
  viem: any;
  networkName: string;
};

export function pickMode(flags: Record<string, string | boolean>, hasMultisig: boolean): ExecMode {
  if (flags["dry-run"] === true) return "dry-run";
  if (!hasMultisig) return "eoa";
  if (flags["propose"] === true) return "propose";
  return "calldata";
}

export async function buildContext(
  conn: NetworkConnection,
  flags: Record<string, string | boolean>,
): Promise<GovContext> {
  const cfg = ADDRESSES[conn.networkName] ?? {};
  const [walletClient] = await conn.viem.getWalletClients();
  const deployer = getAddress(walletClient.account.address);
  const mode = pickMode(flags, !!cfg.multisig);
  return {
    cfg,
    networkName: conn.networkName,
    deployer,
    mode,
    viem: conn.viem,
  };
}

export function parseAndBuild(
  argv: string[],
  conn: NetworkConnection,
  knownFlags: string[],
): Promise<{ parsed: ParsedArgs; ctx: GovContext }> {
  const parsed = parseGovArgs(argv, { knownFlags });
  return buildContext(conn, parsed.flags).then((ctx) => ({ parsed, ctx }));
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/gov/lib/config.ts
git commit -m "feat(gov): config + mode selection (eoa/calldata/propose/dry-run)"
```

---

## Task 4: Execution layer (`lib/exec.ts`)

**Files:**

- Create: `scripts/gov/lib/exec.ts`
- Create: `test/unit/gov/exec.test.ts`

- [ ] **Step 1: Write failing test `test/unit/gov/exec.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { encodeFunctionData, getAddress, parseUnits } from "viem";
import { execDryRun, formatCalldata } from "../../../scripts/gov/lib/exec.js";
import type { CallItem } from "../../../scripts/gov/lib/types.js";

describe("formatCalldata", () => {
  it("renders each CallItem as a human-readable block", () => {
    const calls: CallItem[] = [
      {
        to: "0x1111111111111111111111111111111111111111",
        data: "0xabcdef",
        description: "pause()",
      },
    ];
    const out = formatCalldata(calls);
    assert.match(out, /pause\(\)/);
    assert.match(out, /0x1111111111111111111111111111111111111111/);
    assert.match(out, /0xabcdef/);
  });
});

describe("execDryRun", () => {
  it("returns success + gas estimate for a valid call", async () => {
    const { viem } = await network.connect();
    const [deployerW] = await viem.getWalletClients();
    const token = await viem.deployContract("ERC20MinimalMock", ["Test", "T", 18]);
    await token.write.mint([getAddress(deployerW.account.address), parseUnits("1", 18)]);
    const call: CallItem = {
      to: token.address,
      data: encodeFunctionData({
        abi: token.abi,
        functionName: "mint",
        args: [getAddress(deployerW.account.address), 1n],
      }),
      description: "mint(1)",
    };
    const [result] = await execDryRun(viem, getAddress(deployerW.account.address), [call]);
    assert.equal(result.ok, true);
    assert.ok(result.gas! > 0n);
  });

  it("reports revert reason when call would fail", async () => {
    const { viem } = await network.connect();
    const [deployerW] = await viem.getWalletClients();
    const token = await viem.deployContract("ERC20MinimalMock", ["Test", "T", 18]);
    // Not minted → transfer will revert.
    const call: CallItem = {
      to: token.address,
      data: encodeFunctionData({
        abi: token.abi,
        functionName: "transfer",
        args: ["0x0000000000000000000000000000000000000001", 1n],
      }),
      description: "transfer(1)",
    };
    const [result] = await execDryRun(viem, getAddress(deployerW.account.address), [call]);
    assert.equal(result.ok, false);
    assert.ok(result.error !== undefined);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/exec.test.ts
```

Expected: FAIL — `execDryRun` / `formatCalldata` not defined.

- [ ] **Step 3: Implement `scripts/gov/lib/exec.ts`**

```ts
import type { CallItem, GovContext } from "./types.js";

export type DryRunResult = {
  ok: boolean;
  gas?: bigint;
  error?: string;
};

export function formatCalldata(calls: CallItem[]): string {
  const lines: string[] = [];
  calls.forEach((c, i) => {
    lines.push(`[${i + 1}/${calls.length}] ${c.description}`);
    lines.push(`  to    : ${c.to}`);
    lines.push(`  data  : ${c.data}`);
    if (c.value !== undefined && c.value !== 0n) lines.push(`  value : ${c.value}`);
    lines.push("");
  });
  return lines.join("\n");
}

export async function execDryRun(
  viem: any,
  from: `0x${string}`,
  calls: CallItem[],
): Promise<DryRunResult[]> {
  const publicClient = await viem.getPublicClient();
  const results: DryRunResult[] = [];
  for (const c of calls) {
    try {
      const gas = await publicClient.estimateGas({
        account: from,
        to: c.to,
        data: c.data,
        value: c.value ?? 0n,
      });
      results.push({ ok: true, gas });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ ok: false, error: msg });
    }
  }
  return results;
}

export async function execEoa(viem: any, calls: CallItem[]): Promise<`0x${string}`[]> {
  const [walletClient] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const hashes: `0x${string}`[] = [];
  for (const c of calls) {
    const hash = await walletClient.sendTransaction({
      to: c.to,
      data: c.data,
      value: c.value ?? 0n,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    hashes.push(hash);
  }
  return hashes;
}

export async function exec(ctx: GovContext, calls: CallItem[]): Promise<void> {
  if (calls.length === 0) {
    console.log("(no calls to execute)");
    return;
  }
  switch (ctx.mode) {
    case "dry-run": {
      const results = await execDryRun(ctx.viem as any, ctx.deployer, calls);
      results.forEach((r, i) => {
        const c = calls[i]!;
        console.log(`[dry-run] ${c.description}`);
        console.log(`  network : ${ctx.networkName}`);
        if (r.ok) {
          console.log(`  gas     : ${r.gas}`);
          console.log(`  result  : success ✓`);
        } else {
          console.log(`  result  : revert`);
          console.log(`  error   : ${r.error}`);
        }
        console.log("");
      });
      if (results.some((r) => !r.ok)) process.exit(1);
      return;
    }
    case "eoa": {
      const hashes = await execEoa(ctx.viem as any, calls);
      hashes.forEach((h, i) => {
        console.log(`[eoa] ${calls[i]!.description} → ${h}`);
      });
      return;
    }
    case "calldata": {
      console.log(`Paste the following into Safe (${ctx.cfg.multisig}):\n`);
      console.log(formatCalldata(calls));
      return;
    }
    case "propose": {
      const { proposeToSafe } = await import("./safe.js");
      await proposeToSafe(ctx, calls);
      return;
    }
  }
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
bun test test/unit/gov/exec.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/lib/exec.ts test/unit/gov/exec.test.ts
git commit -m "feat(gov): exec layer (dry-run/eoa/calldata/propose dispatch)"
```

---

## Task 5: Safe SDK wrapper (`lib/safe.ts`)

No fork test — the Safe Transaction Service is out-of-process. We smoke-test the module's surface by importing it; full propose-path validation happens on real testnet by the operator.

**Files:**

- Create: `scripts/gov/lib/safe.ts`

- [ ] **Step 1: Implement `scripts/gov/lib/safe.ts`**

```ts
import Safe from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import type { CallItem, GovContext } from "./types.js";

/**
 * Build a Safe MultiSend transaction data array from CallItems.
 * Protocol-kit accepts `{ to, value, data }`; description is dropped.
 */
function toSafeTxData(calls: CallItem[]) {
  return calls.map((c) => ({
    to: c.to,
    value: (c.value ?? 0n).toString(),
    data: c.data,
  }));
}

export async function proposeToSafe(ctx: GovContext, calls: CallItem[]): Promise<void> {
  const multisig = ctx.cfg.multisig;
  if (!multisig) throw new Error("cfg.multisig is required for --propose");

  const rpcUrl = process.env.BSC_TESTNET_RPC_URL ?? process.env.BSC_RPC_URL;
  if (!rpcUrl) throw new Error("BSC_TESTNET_RPC_URL or BSC_RPC_URL must be set");

  const privateKey = process.env.BSC_TESTNET_PRIVATE_KEY ?? process.env.BSC_PRIVATE_KEY;
  if (!privateKey) throw new Error("signer private key env var must be set for --propose");

  const publicClient = await (ctx.viem as any).getPublicClient();
  const chainId = BigInt(await publicClient.getChainId());

  const safe = await Safe.init({
    provider: rpcUrl,
    signer: privateKey,
    safeAddress: multisig,
  });

  const apiKit = new SafeApiKit({ chainId });

  const txs = toSafeTxData(calls);
  const safeTx = await safe.createTransaction({ transactions: txs });
  const safeTxHash = await safe.getTransactionHash(safeTx);
  const signature = await safe.signHash(safeTxHash);

  await apiKit.proposeTransaction({
    safeAddress: multisig,
    safeTransactionData: safeTx.data,
    safeTxHash,
    senderAddress: ctx.deployer,
    senderSignature: signature.data,
  });

  console.log(`[propose] Safe batch proposed (${calls.length} item${calls.length > 1 ? "s" : ""})`);
  console.log(`  safe    : ${multisig}`);
  console.log(`  txHash  : ${safeTxHash}`);
  console.log(`  sign at : https://app.safe.global/transactions/queue?safe=bnb:${multisig}`);
}
```

- [ ] **Step 2: Type-check it compiles**

```bash
bunx tsc --noEmit -p tsconfig.json
```

Expected: 0 errors. If the Safe SDK API shape differs (version drift), fix the call sites inline and re-run.

- [ ] **Step 3: Commit**

```bash
git add scripts/gov/lib/safe.ts
git commit -m "feat(gov): Safe SDK wrapper — propose + MultiSend batch"
```

---

## Task 6: Commerce governance CLI (`commerce.ts`)

**Files:**

- Create: `scripts/gov/commerce.ts`
- Create: `test/unit/gov/commerce.test.ts`

- [ ] **Step 1: Write failing test `test/unit/gov/commerce.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import {
  buildSetPlatformFee,
  buildPause,
  buildUnpause,
  buildTransferOwnership,
} from "../../../scripts/gov/commerce.js";
import { deployCommerce, deployMockToken } from "../helpers.js";

describe("gov/commerce builders", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("buildSetPlatformFee emits correct calldata and lands on-chain", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });

    const call = buildSetPlatformFee(commerce.address, 250n, treasury);
    assert.equal(call.to, commerce.address);
    assert.match(call.description, /setPlatformFee/);

    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await commerce.read.platformFeeBP(), 250n);
    assert.equal(getAddress(await commerce.read.platformTreasury()), treasury);
  });

  it("buildPause / buildUnpause produce calls that toggle paused()", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });

    const pauseCall = buildPause(commerce.address);
    await ownerW.sendTransaction({ to: pauseCall.to, data: pauseCall.data });
    assert.equal(await commerce.read.paused(), true);

    const unpauseCall = buildUnpause(commerce.address);
    await ownerW.sendTransaction({ to: unpauseCall.to, data: unpauseCall.data });
    assert.equal(await commerce.read.paused(), false);
  });

  it("buildTransferOwnership starts a two-step handoff", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });
    const newOwner = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const call = buildTransferOwnership(commerce.address, newOwner);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await commerce.read.pendingOwner()), getAddress(newOwner));
    assert.equal(getAddress(await commerce.read.owner()), owner);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/commerce.test.ts
```

Expected: FAIL — builders not defined.

- [ ] **Step 3: Implement `scripts/gov/commerce.ts`**

```ts
import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "./lib/config.js";
import { exec } from "./lib/exec.js";
import type { CallItem } from "./lib/types.js";

// Minimal ABI fragments we need to encode calldata. Using fragments instead of
// the full artifact keeps this file a pure builder (no viem.getContractAt).
const COMMERCE_ABI = [
  {
    type: "function",
    name: "setPlatformFee",
    inputs: [
      { name: "feeBP_", type: "uint256" },
      { name: "treasury_", type: "address" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "pause", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "unpause", inputs: [], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export function buildSetPlatformFee(
  commerce: `0x${string}`,
  feeBP: bigint,
  treasury: `0x${string}`,
): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({
      abi: COMMERCE_ABI,
      functionName: "setPlatformFee",
      args: [feeBP, treasury],
    }),
    description: `commerce.setPlatformFee(${feeBP}, ${treasury})`,
  };
}

export function buildPause(commerce: `0x${string}`): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "pause" }),
    description: "commerce.pause()",
  };
}

export function buildUnpause(commerce: `0x${string}`): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({ abi: COMMERCE_ABI, functionName: "unpause" }),
    description: "commerce.unpause()",
  };
}

export function buildTransferOwnership(commerce: `0x${string}`, newOwner: `0x${string}`): CallItem {
  return {
    to: commerce,
    data: encodeFunctionData({
      abi: COMMERCE_ABI,
      functionName: "transferOwnership",
      args: [newOwner],
    }),
    description: `commerce.transferOwnership(${newOwner})`,
  };
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const { parsed, ctx } = await parseAndBuild(process.argv, conn, ["fee-bp", "treasury", "to"]);
  const commerce = ctx.cfg.commerceProxy;
  if (!commerce) throw new Error(`commerceProxy missing in ADDRESSES[${conn.networkName}]`);

  let calls: CallItem[];
  switch (parsed.op) {
    case "setPlatformFee": {
      const feeBP = BigInt(parsed.flags["fee-bp"] as string);
      const treasury = parsed.flags["treasury"] as string as `0x${string}`;
      calls = [buildSetPlatformFee(commerce, feeBP, treasury)];
      break;
    }
    case "pause":
      calls = [buildPause(commerce)];
      break;
    case "unpause":
      calls = [buildUnpause(commerce)];
      break;
    case "transferOwnership": {
      const to =
        (parsed.flags["to"] as string as `0x${string}` | undefined) ?? ctx.cfg.timelockProxy;
      if (!to) throw new Error("pass --to <addr> or fill cfg.timelockProxy");
      calls = [buildTransferOwnership(commerce, to)];
      break;
    }
    default:
      throw new Error(
        `unknown op: ${parsed.op}. Expected: setPlatformFee | pause | unpause | transferOwnership`,
      );
  }

  await exec(ctx, calls);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
bun test test/unit/gov/commerce.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/commerce.ts test/unit/gov/commerce.test.ts
git commit -m "feat(gov): commerce ops (setPlatformFee, pause, unpause, transferOwnership)"
```

---

## Task 7: Router governance CLI (`router.ts`)

**Files:**

- Create: `scripts/gov/router.ts`
- Create: `test/unit/gov/router.test.ts`

- [ ] **Step 1: Write failing test `test/unit/gov/router.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import {
  buildSetPolicyWhitelist,
  buildSetCommerce,
  buildPause,
  buildUnpause,
  buildTransferOwnership,
} from "../../../scripts/gov/router.js";
import { deployCommerce, deployMockToken, deployRouter } from "../helpers.js";

describe("gov/router builders", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  async function fixture() {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });
    const { proxy: router } = await deployRouter(viem, {
      commerce: commerce.address,
      owner,
    });
    return { commerce, router };
  }

  it("buildSetPolicyWhitelist flips whitelist status", async () => {
    const { router } = await fixture();
    const fakePolicy = "0x000000000000000000000000000000000000bEEf" as `0x${string}`;

    const call = buildSetPolicyWhitelist(router.address, fakePolicy, true);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await router.read.isPolicyWhitelisted([fakePolicy]), true);
  });

  it("buildSetCommerce updates router's stored commerce (requires pause)", async () => {
    const { router } = await fixture();
    const newCommerce = "0x000000000000000000000000000000000000cAfe" as `0x${string}`;

    const pauseCall = buildPause(router.address);
    await ownerW.sendTransaction({ to: pauseCall.to, data: pauseCall.data });

    const call = buildSetCommerce(router.address, newCommerce);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await router.read.commerce()), getAddress(newCommerce));
  });

  it("buildTransferOwnership produces valid pendingOwner call", async () => {
    const { router } = await fixture();
    const newOwner = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const call = buildTransferOwnership(router.address, newOwner);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await router.read.pendingOwner()), getAddress(newOwner));
  });

  it("buildUnpause clears the paused flag", async () => {
    const { router } = await fixture();
    const pauseCall = buildPause(router.address);
    await ownerW.sendTransaction({ to: pauseCall.to, data: pauseCall.data });
    assert.equal(await router.read.paused(), true);

    const unpauseCall = buildUnpause(router.address);
    await ownerW.sendTransaction({ to: unpauseCall.to, data: unpauseCall.data });
    assert.equal(await router.read.paused(), false);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/router.test.ts
```

Expected: FAIL — builders not defined.

- [ ] **Step 3: Implement `scripts/gov/router.ts`**

```ts
import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "./lib/config.js";
import { exec } from "./lib/exec.js";
import type { CallItem } from "./lib/types.js";

const ROUTER_ABI = [
  {
    type: "function",
    name: "setPolicyWhitelist",
    inputs: [
      { name: "policy", type: "address" },
      { name: "status", type: "bool" },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setCommerce",
    inputs: [{ name: "newCommerce", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  { type: "function", name: "pause", inputs: [], outputs: [], stateMutability: "nonpayable" },
  { type: "function", name: "unpause", inputs: [], outputs: [], stateMutability: "nonpayable" },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [{ name: "newOwner", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export function buildSetPolicyWhitelist(
  router: `0x${string}`,
  policy: `0x${string}`,
  status: boolean,
): CallItem {
  return {
    to: router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "setPolicyWhitelist",
      args: [policy, status],
    }),
    description: `router.setPolicyWhitelist(${policy}, ${status})`,
  };
}

export function buildSetCommerce(router: `0x${string}`, newCommerce: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "setCommerce",
      args: [newCommerce],
    }),
    description: `router.setCommerce(${newCommerce})`,
  };
}

export function buildPause(router: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "pause" }),
    description: "router.pause()",
  };
}

export function buildUnpause(router: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "unpause" }),
    description: "router.unpause()",
  };
}

export function buildTransferOwnership(router: `0x${string}`, newOwner: `0x${string}`): CallItem {
  return {
    to: router,
    data: encodeFunctionData({
      abi: ROUTER_ABI,
      functionName: "transferOwnership",
      args: [newOwner],
    }),
    description: `router.transferOwnership(${newOwner})`,
  };
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const { parsed, ctx } = await parseAndBuild(process.argv, conn, [
    "policy",
    "status",
    "commerce",
    "to",
  ]);
  const router = ctx.cfg.routerProxy;
  if (!router) throw new Error(`routerProxy missing in ADDRESSES[${conn.networkName}]`);

  let calls: CallItem[];
  switch (parsed.op) {
    case "setPolicyWhitelist": {
      const policy = parsed.flags["policy"] as string as `0x${string}`;
      const status = (parsed.flags["status"] as string) === "true";
      calls = [buildSetPolicyWhitelist(router, policy, status)];
      break;
    }
    case "setCommerce": {
      const commerce = parsed.flags["commerce"] as string as `0x${string}`;
      calls = [buildSetCommerce(router, commerce)];
      break;
    }
    case "pause":
      calls = [buildPause(router)];
      break;
    case "unpause":
      calls = [buildUnpause(router)];
      break;
    case "transferOwnership": {
      const to =
        (parsed.flags["to"] as string as `0x${string}` | undefined) ?? ctx.cfg.timelockProxy;
      if (!to) throw new Error("pass --to <addr> or fill cfg.timelockProxy");
      calls = [buildTransferOwnership(router, to)];
      break;
    }
    default:
      throw new Error(
        `unknown op: ${parsed.op}. Expected: setPolicyWhitelist | setCommerce | pause | unpause | transferOwnership`,
      );
  }

  await exec(ctx, calls);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
bun test test/unit/gov/router.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/router.ts test/unit/gov/router.test.ts
git commit -m "feat(gov): router ops (whitelist, setCommerce, pause, unpause, transferOwnership)"
```

---

## Task 8: Policy governance CLI (`policy.ts`)

**Files:**

- Create: `scripts/gov/policy.ts`
- Create: `test/unit/gov/policy.test.ts`

- [ ] **Step 1: Write failing test `test/unit/gov/policy.test.ts`**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import {
  buildAddVoter,
  buildRemoveVoter,
  buildSetQuorum,
  buildTransferAdmin,
} from "../../../scripts/gov/policy.js";
import { deployStack } from "../helpers.js";

describe("gov/policy builders", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW, voterAW, voterBW, voterCW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);
  const voterA = getAddress(voterAW.account.address);
  const voterB = getAddress(voterBW.account.address);
  const voterC = getAddress(voterCW.account.address);

  it("buildAddVoter registers voter on-chain", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB],
      initialQuorum: 2,
    });

    const call = buildAddVoter(policy.address, voterC);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await policy.read.isVoter([voterC]), true);
    assert.equal(await policy.read.activeVoterCount(), 3);
  });

  it("buildRemoveVoter clears voter on-chain", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB, voterC],
      initialQuorum: 2,
    });

    const call = buildRemoveVoter(policy.address, voterC);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await policy.read.isVoter([voterC]), false);
    assert.equal(await policy.read.activeVoterCount(), 2);
  });

  it("buildSetQuorum updates voteQuorum", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB, voterC],
      initialQuorum: 2,
    });

    const call = buildSetQuorum(policy.address, 3);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(await policy.read.voteQuorum(), 3);
  });

  it("buildTransferAdmin sets pendingAdmin", async () => {
    const { policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [voterA, voterB],
      initialQuorum: 2,
    });
    const newAdmin = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const call = buildTransferAdmin(policy.address, newAdmin);
    await ownerW.sendTransaction({ to: call.to, data: call.data });
    assert.equal(getAddress(await policy.read.pendingAdmin()), getAddress(newAdmin));
    assert.equal(getAddress(await policy.read.admin()), owner);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/policy.test.ts
```

Expected: FAIL — builders not defined.

- [ ] **Step 3: Implement `scripts/gov/policy.ts`**

```ts
import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "./lib/config.js";
import { exec } from "./lib/exec.js";
import type { CallItem } from "./lib/types.js";

const POLICY_ABI = [
  {
    type: "function",
    name: "addVoter",
    inputs: [{ name: "voter", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "removeVoter",
    inputs: [{ name: "voter", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setQuorum",
    inputs: [{ name: "newQuorum", type: "uint16" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferAdmin",
    inputs: [{ name: "newAdmin", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

export function buildAddVoter(policy: `0x${string}`, voter: `0x${string}`): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({ abi: POLICY_ABI, functionName: "addVoter", args: [voter] }),
    description: `policy.addVoter(${voter})`,
  };
}

export function buildRemoveVoter(policy: `0x${string}`, voter: `0x${string}`): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({ abi: POLICY_ABI, functionName: "removeVoter", args: [voter] }),
    description: `policy.removeVoter(${voter})`,
  };
}

export function buildSetQuorum(policy: `0x${string}`, quorum: number): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({ abi: POLICY_ABI, functionName: "setQuorum", args: [quorum] }),
    description: `policy.setQuorum(${quorum})`,
  };
}

export function buildTransferAdmin(policy: `0x${string}`, newAdmin: `0x${string}`): CallItem {
  return {
    to: policy,
    data: encodeFunctionData({
      abi: POLICY_ABI,
      functionName: "transferAdmin",
      args: [newAdmin],
    }),
    description: `policy.transferAdmin(${newAdmin})`,
  };
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const { parsed, ctx } = await parseAndBuild(process.argv, conn, ["voter", "quorum", "to"]);
  const policy = ctx.cfg.policy;
  if (!policy) throw new Error(`policy missing in ADDRESSES[${conn.networkName}]`);

  let calls: CallItem[];
  switch (parsed.op) {
    case "addVoter":
      calls = [buildAddVoter(policy, parsed.flags["voter"] as string as `0x${string}`)];
      break;
    case "removeVoter":
      calls = [buildRemoveVoter(policy, parsed.flags["voter"] as string as `0x${string}`)];
      break;
    case "setQuorum":
      calls = [buildSetQuorum(policy, Number(parsed.flags["quorum"] as string))];
      break;
    case "transferAdmin": {
      const to =
        (parsed.flags["to"] as string as `0x${string}` | undefined) ?? ctx.cfg.timelockProxy;
      if (!to) throw new Error("pass --to <addr> or fill cfg.timelockProxy");
      calls = [buildTransferAdmin(policy, to)];
      break;
    }
    default:
      throw new Error(
        `unknown op: ${parsed.op}. Expected: addVoter | removeVoter | setQuorum | transferAdmin`,
      );
  }

  await exec(ctx, calls);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
bun test test/unit/gov/policy.test.ts
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/policy.ts test/unit/gov/policy.test.ts
git commit -m "feat(gov): policy ops (addVoter, removeVoter, setQuorum, transferAdmin)"
```

---

## Task 9: Runbook — `deploy-timelock.ts`

**Files:**

- Create: `scripts/gov/runbooks/deploy-timelock.ts`
- Create: `test/unit/gov/runbooks/deploy-timelock.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { deployTimelock } from "../../../../scripts/gov/runbooks/deploy-timelock.js";

describe("runbook/deploy-timelock", async () => {
  const { viem } = await network.connect();
  const [deployerW, multisigW] = await viem.getWalletClients();
  const deployer = getAddress(deployerW.account.address);
  const multisig = getAddress(multisigW.account.address);

  it("deploys TimelockController with delay=0 and multisig as proposer+executor", async () => {
    const address = await deployTimelock(viem, { multisig, admin: deployer, minDelay: 0n });

    const tl = await viem.getContractAt("TimelockController", address);
    assert.equal(await tl.read.getMinDelay(), 0n);

    const proposerRole = await tl.read.PROPOSER_ROLE();
    const executorRole = await tl.read.EXECUTOR_ROLE();
    assert.equal(await tl.read.hasRole([proposerRole, multisig]), true);
    assert.equal(await tl.read.hasRole([executorRole, multisig]), true);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/runbooks/deploy-timelock.test.ts
```

Expected: FAIL — `deployTimelock` not defined; may also fail because `TimelockController` artifact is not yet exposed.

- [ ] **Step 3: Surface the OZ TimelockController artifact**

Create `contracts/TimelockExport.sol` so Hardhat compiles the artifact:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Re-export so Hardhat generates the TimelockController artifact we use from scripts.
import { TimelockController } from "@openzeppelin/contracts/governance/TimelockController.sol";

// Keep the file non-empty to avoid solc warnings.
abstract contract TimelockExport is TimelockController {
  constructor() TimelockController(0, new address[](0), new address[](0), address(0)) {}
}
```

Run:

```bash
bun run compile
```

Expected: compiles clean; `TimelockController` artifact now available.

- [ ] **Step 4: Implement `scripts/gov/runbooks/deploy-timelock.ts`**

```ts
import { network } from "hardhat";

export type DeployTimelockOpts = {
  multisig: `0x${string}`;
  admin: `0x${string}`;
  minDelay: bigint;
};

/**
 * Deploys an OpenZeppelin TimelockController with:
 *   - minDelay = opts.minDelay (0 for testnet; raise via updateDelay later)
 *   - proposers = [multisig]
 *   - executors = [multisig]
 *   - admin     = opts.admin (usually deployer; should be renounced later)
 *
 * Returns the Timelock address. Intentionally EOA-only — no Safe path: at
 * deploy-time the Safe has no way to control anything on-chain yet.
 */
export async function deployTimelock(viem: any, opts: DeployTimelockOpts): Promise<`0x${string}`> {
  const tl = await viem.deployContract("TimelockController", [
    opts.minDelay,
    [opts.multisig],
    [opts.multisig],
    opts.admin,
  ]);
  return tl.address as `0x${string}`;
}

async function main(): Promise<void> {
  const { viem, networkName } = await network.connect();
  const { ADDRESSES } = await import("../../addresses.js");
  const cfg = ADDRESSES[networkName] ?? {};
  if (!cfg.multisig) throw new Error(`multisig missing in ADDRESSES[${networkName}]`);

  const [walletClient] = await viem.getWalletClients();
  const admin = walletClient.account.address as `0x${string}`;

  console.log(`\n=== Deploying TimelockController ===`);
  console.log(`Network : ${networkName}`);
  console.log(`Multisig: ${cfg.multisig}`);
  console.log(`Admin   : ${admin} (deployer; renounce once governance is set)`);
  console.log(`Delay   : 0 (testnet; call updateDelay later for mainnet)`);

  const address = await deployTimelock(viem, {
    multisig: cfg.multisig,
    admin,
    minDelay: 0n,
  });

  console.log(`\nTimelock deployed: ${address}`);
  console.log(`\nPaste into ADDRESSES["${networkName}"] in scripts/addresses.ts:`);
  console.log(`    timelockProxy: "${address}",`);
  console.log(`\nFollow-up (from deployer) when governance is fully wired:`);
  console.log(`    timelock.renounceRole(TIMELOCK_ADMIN_ROLE, deployer)`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 5: Run test to confirm pass**

```bash
bun test test/unit/gov/runbooks/deploy-timelock.test.ts
```

Expected: PASS (1/1).

- [ ] **Step 6: Commit**

```bash
git add contracts/TimelockExport.sol scripts/gov/runbooks/deploy-timelock.ts test/unit/gov/runbooks/deploy-timelock.test.ts
git commit -m "feat(gov): runbook deploy-timelock (OZ TimelockController, delay=0)"
```

---

## Task 10: Runbook — `transfer-ownership.ts`

**Files:**

- Create: `scripts/gov/runbooks/transfer-ownership.ts`
- Create: `test/unit/gov/runbooks/transfer-ownership.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { buildTransferAllOwnership } from "../../../../scripts/gov/runbooks/transfer-ownership.js";
import { deployStack } from "../../helpers.js";

describe("runbook/transfer-ownership", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW, voterAW, voterBW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("produces 3 CallItems that hand ownership to timelock when executed", async () => {
    const { commerce, router, policy } = await deployStack(viem, {
      owner,
      treasury,
      voters: [getAddress(voterAW.account.address), getAddress(voterBW.account.address)],
      initialQuorum: 2,
    });
    const timelock = "0x000000000000000000000000000000000000dEaD" as `0x${string}`;

    const calls = buildTransferAllOwnership({
      commerce: commerce.address,
      router: router.address,
      policy: policy.address,
      timelock,
    });
    assert.equal(calls.length, 3);

    for (const c of calls) {
      await ownerW.sendTransaction({ to: c.to, data: c.data });
    }

    assert.equal(getAddress(await commerce.read.pendingOwner()), getAddress(timelock));
    assert.equal(getAddress(await router.read.pendingOwner()), getAddress(timelock));
    assert.equal(getAddress(await policy.read.pendingAdmin()), getAddress(timelock));
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/runbooks/transfer-ownership.test.ts
```

Expected: FAIL — `buildTransferAllOwnership` not defined.

- [ ] **Step 3: Implement `scripts/gov/runbooks/transfer-ownership.ts`**

```ts
import { network } from "hardhat";
import { parseAndBuild } from "../lib/config.js";
import { exec } from "../lib/exec.js";
import type { CallItem } from "../lib/types.js";
import { buildTransferOwnership as buildCommerceTransfer } from "../commerce.js";
import { buildTransferOwnership as buildRouterTransfer } from "../router.js";
import { buildTransferAdmin } from "../policy.js";

export function buildTransferAllOwnership(opts: {
  commerce: `0x${string}`;
  router: `0x${string}`;
  policy: `0x${string}`;
  timelock: `0x${string}`;
}): CallItem[] {
  return [
    buildCommerceTransfer(opts.commerce, opts.timelock),
    buildRouterTransfer(opts.router, opts.timelock),
    buildTransferAdmin(opts.policy, opts.timelock),
  ];
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const { ctx } = await parseAndBuild(process.argv, conn, []);
  const { commerceProxy, routerProxy, policy, timelockProxy } = ctx.cfg;
  if (!commerceProxy || !routerProxy || !policy || !timelockProxy) {
    throw new Error(
      `transfer-ownership requires commerceProxy, routerProxy, policy, and timelockProxy in ADDRESSES[${conn.networkName}]`,
    );
  }

  const calls = buildTransferAllOwnership({
    commerce: commerceProxy,
    router: routerProxy,
    policy,
    timelock: timelockProxy,
  });

  await exec(ctx, calls);

  console.log(`\nAfter execution, the Timelock must accept ownership. Schedule from multisig:`);
  console.log(`  timelock.schedule(commerce, 0, commerce.acceptOwnership.selector, 0, salt, 0)`);
  console.log(`  timelock.schedule(router, 0, router.acceptOwnership.selector, 0, salt, 0)`);
  console.log(`  timelock.schedule(policy, 0, policy.acceptAdmin.selector, 0, salt, 0)`);
  console.log(`Then after minDelay: timelock.execute(...) for each.`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
bun test test/unit/gov/runbooks/transfer-ownership.test.ts
```

Expected: PASS (1/1).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/runbooks/transfer-ownership.ts test/unit/gov/runbooks/transfer-ownership.test.ts
git commit -m "feat(gov): runbook transfer-ownership (batch handoff to timelock)"
```

---

## Task 11: Runbook — `rotate-policy.ts`

**Files:**

- Create: `scripts/gov/runbooks/rotate-policy.ts`
- Create: `test/unit/gov/runbooks/rotate-policy.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { buildRotatePolicyWhitelist } from "../../../../scripts/gov/runbooks/rotate-policy.js";
import { deployStack } from "../../helpers.js";
import { DEFAULT_DISPUTE_WINDOW } from "../../helpers.js";

describe("runbook/rotate-policy", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW, voterAW, voterBW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("deploys a new policy + produces 2 whitelist toggles that execute correctly", async () => {
    const {
      commerce,
      router,
      policy: oldPolicy,
    } = await deployStack(viem, {
      owner,
      treasury,
      voters: [getAddress(voterAW.account.address), getAddress(voterBW.account.address)],
      initialQuorum: 2,
    });

    // Deploy a fresh OptimisticPolicy (simulating the EOA-direct part).
    const newPolicy = await viem.deployContract("OptimisticPolicy", [
      commerce.address,
      router.address,
      owner,
      DEFAULT_DISPUTE_WINDOW,
      1,
    ]);

    const calls = buildRotatePolicyWhitelist({
      router: router.address,
      newPolicy: newPolicy.address,
      oldPolicy: oldPolicy.address,
    });
    assert.equal(calls.length, 2);

    for (const c of calls) {
      await ownerW.sendTransaction({ to: c.to, data: c.data });
    }

    assert.equal(await router.read.isPolicyWhitelisted([newPolicy.address]), true);
    assert.equal(await router.read.isPolicyWhitelisted([oldPolicy.address]), false);
  });

  it("skip-revoke mode produces only the whitelist-new call", async () => {
    const newPolicy = "0x000000000000000000000000000000000000aaaa" as `0x${string}`;
    const router = "0x000000000000000000000000000000000000bbbb" as `0x${string}`;
    const calls = buildRotatePolicyWhitelist({
      router,
      newPolicy,
      oldPolicy: null,
    });
    assert.equal(calls.length, 1);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/runbooks/rotate-policy.test.ts
```

Expected: FAIL — `buildRotatePolicyWhitelist` not defined.

- [ ] **Step 3: Implement `scripts/gov/runbooks/rotate-policy.ts`**

```ts
import { network } from "hardhat";
import { parseAndBuild } from "../lib/config.js";
import { exec } from "../lib/exec.js";
import type { CallItem } from "../lib/types.js";
import { buildSetPolicyWhitelist } from "../router.js";

export function buildRotatePolicyWhitelist(opts: {
  router: `0x${string}`;
  newPolicy: `0x${string}`;
  oldPolicy: `0x${string}` | null;
}): CallItem[] {
  const calls: CallItem[] = [buildSetPolicyWhitelist(opts.router, opts.newPolicy, true)];
  if (opts.oldPolicy) {
    calls.push(buildSetPolicyWhitelist(opts.router, opts.oldPolicy, false));
  }
  return calls;
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const { parsed, ctx } = await parseAndBuild(process.argv, conn, [
    "old-policy",
    "dispute-window",
    "initial-quorum",
    "skip-revoke",
  ]);
  const { commerceProxy, routerProxy, policy: cfgPolicy } = ctx.cfg;
  if (!commerceProxy || !routerProxy) {
    throw new Error(`commerceProxy + routerProxy required in ADDRESSES[${conn.networkName}]`);
  }

  const oldPolicyFlag = parsed.flags["old-policy"] as string | undefined;
  const skipRevoke = parsed.flags["skip-revoke"] === true;
  const oldPolicy = skipRevoke ? null : ((oldPolicyFlag ?? cfgPolicy) as `0x${string}` | undefined);
  if (!oldPolicy && !skipRevoke) {
    console.error(
      `no old policy found: pass --old-policy <addr>, fill ADDRESSES[${conn.networkName}].policy, or pass --skip-revoke`,
    );
    process.exit(1);
  }

  // Step 1 — deploy the new Policy. Always EOA-direct: address feeds step 2.
  const disputeWindow = BigInt((parsed.flags["dispute-window"] as string) ?? "86400");
  const initialQuorum = Number((parsed.flags["initial-quorum"] as string) ?? "2");
  console.log(`[1/2] deploying new OptimisticPolicy ...`);
  const [walletClient] = await (ctx.viem as any).getWalletClients();
  const newPolicy = await (ctx.viem as any).deployContract("OptimisticPolicy", [
    commerceProxy,
    routerProxy,
    walletClient.account.address,
    disputeWindow,
    initialQuorum,
  ]);
  console.log(`      new policy: ${newPolicy.address}`);

  // Step 2 — whitelist new, revoke old. This is the batch for Safe.
  console.log(`\n[2/2] whitelist/revoke via ${ctx.mode} ...`);
  const calls = buildRotatePolicyWhitelist({
    router: routerProxy,
    newPolicy: newPolicy.address,
    oldPolicy: oldPolicy ?? null,
  });
  await exec(ctx, calls);

  console.log(`\nPaste into ADDRESSES["${conn.networkName}"]:`);
  console.log(`    policy: "${newPolicy.address}",`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
bun test test/unit/gov/runbooks/rotate-policy.test.ts
```

Expected: PASS (2/2).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/runbooks/rotate-policy.ts test/unit/gov/runbooks/rotate-policy.test.ts
git commit -m "feat(gov): runbook rotate-policy (deploy new + whitelist + revoke)"
```

---

## Task 12: Runbook — `upgrade.ts`

**Files:**

- Create: `scripts/gov/runbooks/upgrade.ts`
- Create: `test/unit/gov/runbooks/upgrade.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { getAddress } from "viem";
import { buildUpgradeCalls } from "../../../../scripts/gov/runbooks/upgrade.js";
import { deployCommerce, deployMockToken, deployRouter } from "../../helpers.js";

describe("runbook/upgrade", async () => {
  const { viem } = await network.connect();
  const [ownerW, treasuryW] = await viem.getWalletClients();
  const owner = getAddress(ownerW.account.address);
  const treasury = getAddress(treasuryW.account.address);

  it("mode=all produces 2 upgradeToAndCall calls; both succeed on-chain", async () => {
    const token = await deployMockToken(viem);
    const { proxy: commerce } = await deployCommerce(viem, {
      paymentToken: token.address,
      treasury,
      owner,
    });
    const { proxy: router } = await deployRouter(viem, {
      commerce: commerce.address,
      owner,
    });
    const newCommerceImpl = await viem.deployContract("AgenticCommerceV2Mock", []);
    const newRouterImpl = await viem.deployContract("EvaluatorRouterV2Mock", []);

    const calls = buildUpgradeCalls({
      mode: "all",
      commerce: commerce.address,
      router: router.address,
      newCommerceImpl: newCommerceImpl.address,
      newRouterImpl: newRouterImpl.address,
    });
    assert.equal(calls.length, 2);

    for (const c of calls) {
      await ownerW.sendTransaction({ to: c.to, data: c.data });
    }

    const upgradedCommerce = await viem.getContractAt("AgenticCommerceV2Mock", commerce.address);
    const upgradedRouter = await viem.getContractAt("EvaluatorRouterV2Mock", router.address);
    assert.equal(await upgradedCommerce.read.version(), 2);
    assert.equal(await upgradedRouter.read.version(), 2);
  });

  it("mode=commerce produces 1 call (commerce only)", () => {
    const calls = buildUpgradeCalls({
      mode: "commerce",
      commerce: "0x0000000000000000000000000000000000000001",
      router: "0x0000000000000000000000000000000000000002",
      newCommerceImpl: "0x0000000000000000000000000000000000000003",
      newRouterImpl: null,
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.description, /commerce\.upgradeToAndCall/);
  });

  it("mode=router produces 1 call (router only)", () => {
    const calls = buildUpgradeCalls({
      mode: "router",
      commerce: "0x0000000000000000000000000000000000000001",
      router: "0x0000000000000000000000000000000000000002",
      newCommerceImpl: null,
      newRouterImpl: "0x0000000000000000000000000000000000000004",
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.description, /router\.upgradeToAndCall/);
  });
});
```

- [ ] **Step 2: Run test to confirm failure**

```bash
bun test test/unit/gov/runbooks/upgrade.test.ts
```

Expected: FAIL — `buildUpgradeCalls` not defined.

- [ ] **Step 3: Implement `scripts/gov/runbooks/upgrade.ts`**

```ts
import { network } from "hardhat";
import { encodeFunctionData } from "viem";
import { parseAndBuild } from "../lib/config.js";
import { exec } from "../lib/exec.js";
import type { CallItem } from "../lib/types.js";

const UUPS_ABI = [
  {
    type: "function",
    name: "upgradeToAndCall",
    inputs: [
      { name: "newImplementation", type: "address" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
] as const;

export type UpgradeMode = "all" | "commerce" | "router";

export function buildUpgradeCalls(opts: {
  mode: UpgradeMode;
  commerce: `0x${string}`;
  router: `0x${string}`;
  newCommerceImpl: `0x${string}` | null;
  newRouterImpl: `0x${string}` | null;
}): CallItem[] {
  const calls: CallItem[] = [];
  if ((opts.mode === "all" || opts.mode === "commerce") && opts.newCommerceImpl) {
    calls.push({
      to: opts.commerce,
      data: encodeFunctionData({
        abi: UUPS_ABI,
        functionName: "upgradeToAndCall",
        args: [opts.newCommerceImpl, "0x"],
      }),
      description: `commerce.upgradeToAndCall(${opts.newCommerceImpl}, 0x)`,
    });
  }
  if ((opts.mode === "all" || opts.mode === "router") && opts.newRouterImpl) {
    calls.push({
      to: opts.router,
      data: encodeFunctionData({
        abi: UUPS_ABI,
        functionName: "upgradeToAndCall",
        args: [opts.newRouterImpl, "0x"],
      }),
      description: `router.upgradeToAndCall(${opts.newRouterImpl}, 0x)`,
    });
  }
  return calls;
}

async function main(): Promise<void> {
  const conn = await network.connect();
  const { parsed, ctx } = await parseAndBuild(process.argv, conn, ["commerce", "router", "all"]);

  const modeFlags = ["commerce", "router", "all"].filter((f) => parsed.flags[f] === true);
  let mode: UpgradeMode = "all";
  if (modeFlags.length > 1) throw new Error(`pass only one of --commerce / --router / --all`);
  if (modeFlags.length === 1) mode = modeFlags[0] as UpgradeMode;

  const { commerceProxy, routerProxy } = ctx.cfg;
  if (!commerceProxy || !routerProxy) {
    throw new Error(`commerceProxy + routerProxy required in ADDRESSES[${conn.networkName}]`);
  }

  // Step 1 — deploy impl(s). Always EOA-direct; addresses feed step 2.
  let newCommerceImpl: `0x${string}` | null = null;
  let newRouterImpl: `0x${string}` | null = null;
  if (mode === "all" || mode === "commerce") {
    console.log(`[impl] deploying new AgenticCommerceUpgradeable ...`);
    const impl = await (ctx.viem as any).deployContract("AgenticCommerceUpgradeable", []);
    newCommerceImpl = impl.address;
    console.log(`       commerce impl: ${newCommerceImpl}`);
  }
  if (mode === "all" || mode === "router") {
    console.log(`[impl] deploying new EvaluatorRouterUpgradeable ...`);
    const impl = await (ctx.viem as any).deployContract("EvaluatorRouterUpgradeable", []);
    newRouterImpl = impl.address;
    console.log(`       router impl  : ${newRouterImpl}`);
  }

  const calls = buildUpgradeCalls({
    mode,
    commerce: commerceProxy,
    router: routerProxy,
    newCommerceImpl,
    newRouterImpl,
  });
  console.log(`\n[upgrade] submitting ${calls.length} upgradeToAndCall via ${ctx.mode} ...`);
  await exec(ctx, calls);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run test to confirm pass**

```bash
bun test test/unit/gov/runbooks/upgrade.test.ts
```

Expected: PASS (3/3).

- [ ] **Step 5: Commit**

```bash
git add scripts/gov/runbooks/upgrade.ts test/unit/gov/runbooks/upgrade.test.ts
git commit -m "feat(gov): runbook upgrade (--commerce / --router / --all)"
```

---

## Task 13: `package.json` wiring

All scripts are driven by `bunx hardhat run` with a trailing `--` to forward args to `process.argv`. Testnet scripts preload `.env.testnet`.

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add gov scripts to `package.json`**

Under the `"scripts"` block, insert:

```json
"gov:commerce:local":      "bunx hardhat run scripts/gov/commerce.ts --network localhost --",
"gov:commerce:testnet":    "DOTENV_CONFIG_PATH=.env.testnet bunx hardhat run scripts/gov/commerce.ts --network bscTestnet --",
"gov:router:local":        "bunx hardhat run scripts/gov/router.ts --network localhost --",
"gov:router:testnet":      "DOTENV_CONFIG_PATH=.env.testnet bunx hardhat run scripts/gov/router.ts --network bscTestnet --",
"gov:policy:local":        "bunx hardhat run scripts/gov/policy.ts --network localhost --",
"gov:policy:testnet":      "DOTENV_CONFIG_PATH=.env.testnet bunx hardhat run scripts/gov/policy.ts --network bscTestnet --",
"gov:deploy-timelock:testnet":     "DOTENV_CONFIG_PATH=.env.testnet bunx hardhat run scripts/gov/runbooks/deploy-timelock.ts --network bscTestnet",
"gov:transfer-ownership:testnet":  "DOTENV_CONFIG_PATH=.env.testnet bunx hardhat run scripts/gov/runbooks/transfer-ownership.ts --network bscTestnet --",
"gov:rotate-policy:testnet":       "DOTENV_CONFIG_PATH=.env.testnet bunx hardhat run scripts/gov/runbooks/rotate-policy.ts --network bscTestnet --",
"gov:upgrade:testnet":             "DOTENV_CONFIG_PATH=.env.testnet bunx hardhat run scripts/gov/runbooks/upgrade.ts --network bscTestnet --",
"gov:upgrade:fork":                "bunx hardhat run scripts/gov/runbooks/upgrade.ts --network bscTestnetFork --"
```

Note the trailing `--` — `bunx hardhat run` forwards everything after it to the script's `process.argv`. If the Hardhat 3 runner swallows args, fall back to env-var-based flag passing inside each script as the next task.

- [ ] **Step 2: Smoke-test the full suite runs**

```bash
bun test test/unit/gov/
```

Expected: all gov tests pass (totals across Tasks 2, 4, 6–12).

- [ ] **Step 3: Lint + format check**

```bash
bun run lint:sol
bun run format:check
```

Expected: both clean. Run `bun run format` if format check fails.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(gov): wire gov:* scripts in package.json"
```

---

## Task 14: CLI forwarding smoke test (fail-safe)

Purpose: verify that `bunx hardhat run script -- op --flag value` actually forwards the trailing args. If it does not, we must switch each script to read env vars instead.

**Files:**

- (investigation only — possibly modify CLI scripts)

- [ ] **Step 1: Start local node + deploy stack**

```bash
# terminal 1
bun run node
# terminal 2
bun run deploy:local
```

Copy the printed addresses into `scripts/addresses.ts` under `localhost` (same format as `bscTestnet`).

- [ ] **Step 2: Run a no-op gov command with dry-run**

```bash
bun run gov:commerce:local -- pause --dry-run
```

Expected output contains `[dry-run]`, `commerce.pause()`, and gas. If instead you see an error like "unknown op: " or the op arg is lost — CLI forwarding is broken.

- [ ] **Step 3: If CLI forwarding fails, switch to env-var passthrough**

In each script's `main()`, replace `parseGovArgs(process.argv, ...)` with:

```ts
const argv = process.env.GOV_ARGS ? ["node", "script", ...process.env.GOV_ARGS.split(" ")] : process.argv;
const { parsed, ctx } = await parseAndBuild(argv, conn, [...]);
```

Update `package.json`:

```json
"gov:commerce:local": "GOV_ARGS=\"$npm_config_op $npm_config_args\" bunx hardhat run scripts/gov/commerce.ts --network localhost"
```

…and document usage as `GOV_ARGS='pause --dry-run' bun run gov:commerce:local`. Keep it simple — only implement this fallback if Step 2 actually fails.

- [ ] **Step 4: Commit (only if fallback was needed)**

```bash
git add scripts/gov/*.ts scripts/gov/runbooks/*.ts package.json
git commit -m "chore(gov): GOV_ARGS fallback for CLI passthrough"
```

---

## Final Verification

- [ ] **Step 1: Full test suite**

```bash
bun test
```

Expected: all tests pass (existing 62 + the new gov tests).

- [ ] **Step 2: Lint + format**

```bash
bun run lint:sol
bun run format:check
```

Expected: both clean.

- [ ] **Step 3: Manual smoke on testnet (operator task, not part of this plan)**

- Deploy Safe (out of scope; Safe UI)
- Fill `multisig` in `scripts/addresses.ts`
- `bun run gov:deploy-timelock:testnet` → fill `timelockProxy`
- `bun run gov:upgrade:testnet -- --dry-run --all` → verify dry-run works
- `bun run gov:transfer-ownership:testnet -- --propose` → verify Safe UI shows batch
