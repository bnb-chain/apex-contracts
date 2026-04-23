# 治理脚本设计文档

**日期：** 2026-04-23  
**状态：** 已批准

## 目标

为 APEX v1 合约栈提供完整的治理脚本套件，覆盖：部署后初始配置、合约升级、参数调整、所有权转移、Timelock 部署、以及 Safe 多签集成——并提供从 EOA 持有（测试网）到多签持有（生产环境）的平滑过渡路径。

---

## 背景

现有的 `scripts/deploy.ts` 处理首次部署和 impl 升级，但仅在部署者 EOA 是合约 owner 时有效。一旦所有权转移给多签，就需要独立的治理层。

**各合约的治理接口：**

| 合约                         | 访问控制                  | Owner 函数                                                                                       |
| ---------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ |
| `AgenticCommerceUpgradeable` | `Ownable2StepUpgradeable` | `setPlatformFee`、`pause`、`unpause`、`upgradeToAndCall`、`transferOwnership`                    |
| `EvaluatorRouterUpgradeable` | `Ownable2StepUpgradeable` | `setPolicyWhitelist`、`setCommerce`、`pause`、`unpause`、`upgradeToAndCall`、`transferOwnership` |
| `OptimisticPolicy`           | 自定义 `admin`            | `addVoter`、`removeVoter`、`setQuorum`、`transferAdmin`、`acceptAdmin`                           |
| `TimelockController`（新增） | OZ 标准                   | `schedule`、`execute`、`cancel`                                                                  |

---

## 架构

### 文件结构

```
scripts/
  addresses.ts              # 扩展：新增 timelockProxy + multisig 字段
  deploy.ts                 # 不变
  fund-local.ts             # 不变
  gov/
    lib/
      config.ts             # 读取 addresses.ts + 网络信息，构建 GovContext
      exec.ts               # 执行层：EOA 直发 / 打印 calldata / Safe 提案 / dry-run
      safe.ts               # Safe SDK 封装：proposeTransaction + printCalldata
    commerce.ts             # Commerce 治理操作
    router.ts               # Router 治理操作
    policy.ts               # Policy 治理操作
    runbooks/
      transfer-ownership.ts # 批量：commerce + router + policy → timelockProxy
      rotate-policy.ts      # 部署新 Policy + 白名单新 + 撤销旧
      upgrade.ts            # 部署 impl + upgradeToAndCall；支持 --commerce/--router/--all
      deploy-timelock.ts    # 部署 TimelockController（delay=0）
```

### 新增 `package.json` 命令

```
bun run gov:commerce   -- <操作> [参数]
bun run gov:router     -- <操作> [参数]
bun run gov:policy     -- <操作> [参数]
bun run gov:transfer-ownership [--dry-run] [--propose]
bun run gov:rotate-policy      [--dry-run] [--propose]
bun run gov:upgrade            [--dry-run] [--propose] [--commerce|--router|--all]
bun run gov:deploy-timelock
```

---

## `addresses.ts` 变更

`DeployedAddresses` 新增两个可选字段：

```ts
readonly timelockProxy?: `0x${string}`;   // TimelockController 地址
readonly multisig?: `0x${string}`;        // Gnosis Safe 地址
```

`multisig` 在 Safe 部署后填入。`timelockProxy` 在 `gov:deploy-timelock` 运行后填入。两者均为公开链上地址，可以安全提交到版本库。

---

## 执行层（`lib/exec.ts`）

所有 gov 脚本和 runbook 只负责构造 `CallItem[]`，传给 `exec()` 执行。执行模式由执行层自动判断：

```
--dry-run flag
  → 连接 bscTestnetFork，eth_call 模拟每条交易
  → 打印 gas 估算 + 结果；revert 时打印原因并以非零退出码退出

无 --dry-run，cfg.multisig 为空（EOA 模式）
  → 用 deployer 逐条签名发链上交易，等待确认，打印 txHash

无 --dry-run，cfg.multisig 有值，无 --propose（calldata 模式）
  → 格式化打印每条交易的 to + calldata（人工粘贴到 Safe UI）

无 --dry-run，cfg.multisig 有值，--propose
  → 调用 Safe API Kit：单条 → 普通提案；多条 → MultiSend 批量提案
```

```ts
type CallItem = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: bigint;
  description: string; // 用于日志和 Safe 提案备注
};
```

脚本层永远不直接接触签名器——所有签名由执行层统一处理。

---

## GovContext（`lib/config.ts`）

```ts
type GovContext = {
  cfg: DeployedAddresses;
  networkName: string;
  deployer: `0x${string}`;
  mode: "eoa" | "calldata" | "propose" | "dry-run";
  contracts: {
    commerce: CommerceContract;
    router: RouterContract;
    policy: PolicyContract | null; // policy 地址填写前为 null
    timelock: TimelockContract | null; // timelockProxy 填写前为 null
  };
};
```

Config 读取 `ADDRESSES[networkName]`，构造类型化的 viem 合约实例，并解析 CLI flag（`--propose`、`--dry-run` 及各操作参数）。

---

## `lib/safe.ts`

对 `@safe-global/protocol-kit` 和 `@safe-global/api-kit` 的薄封装：

- `proposeTransaction(ctx, calls)` — 用 deployer key 初始化 Safe 客户端，若 `calls.length > 1` 则编码为 MultiSend，提交到 Safe Transaction Service
- `printCalldata(calls)` — 将每条 `CallItem` 格式化为人可读的 to+data 块

Safe SDK 仅作为 devDependency，不会被合约或测试引用。

---

## 各合约操作清单

### `commerce.ts`

| 操作                | 合约函数                          | CLI 参数                                 |
| ------------------- | --------------------------------- | ---------------------------------------- |
| `setPlatformFee`    | `setPlatformFee(feeBP, treasury)` | `--fee-bp <uint>` `--treasury <addr>`    |
| `pause`             | `pause()`                         | —                                        |
| `unpause`           | `unpause()`                       | —                                        |
| `transferOwnership` | `transferOwnership(newOwner)`     | `--to <addr>`（默认：cfg.timelockProxy） |

### `router.ts`

| 操作                 | 合约函数                             | CLI 参数                                   |
| -------------------- | ------------------------------------ | ------------------------------------------ |
| `setPolicyWhitelist` | `setPolicyWhitelist(policy, status)` | `--policy <addr>` `--status <true\|false>` |
| `setCommerce`        | `setCommerce(newCommerce)`           | `--commerce <addr>`                        |
| `pause`              | `pause()`                            | —                                          |
| `unpause`            | `unpause()`                          | —                                          |
| `transferOwnership`  | `transferOwnership(newOwner)`        | `--to <addr>`（默认：cfg.timelockProxy）   |

### `policy.ts`

| 操作            | 合约函数                  | CLI 参数                                 |
| --------------- | ------------------------- | ---------------------------------------- |
| `addVoter`      | `addVoter(voter)`         | `--voter <addr>`                         |
| `removeVoter`   | `removeVoter(voter)`      | `--voter <addr>`                         |
| `setQuorum`     | `setQuorum(quorum)`       | `--quorum <uint>`                        |
| `transferAdmin` | `transferAdmin(newAdmin)` | `--to <addr>`（默认：cfg.timelockProxy） |

---

## Runbooks

### `deploy-timelock.ts`

部署 `TimelockController`，参数：`minDelay=0`、`proposers=[multisig]`、`executors=[multisig]`。EOA 直接发送（此时 Safe 还不是 owner）。部署完成后打印地址，填入 `addresses.ts`。

`minDelay=0` 是测试网的有意设计。上主网后，multisig 调用 `timelock.updateDelay(86400)` 即可激活 24 小时延迟，无需重新部署任何合约。

### `transfer-ownership.ts`

一个 Safe Batch 完成所有所有权转移（3 条子交易）：

1. `commerce.transferOwnership(timelockProxy)`
2. `router.transferOwnership(timelockProxy)`
3. `policy.transferAdmin(timelockProxy)`

执行完毕后，还需调用 `timelockProxy.acceptOwnership()`（Commerce + Router）和 `timelockProxy.acceptAdmin()`（Policy）。这些后续操作由 multisig 通过 `timelock.schedule(...)` + `timelock.execute(...)` 完成。Runbook 末尾会打印这些后续调用的完整 calldata。

### `rotate-policy.ts`

Policy impl 地址需要在构建 Safe Batch 之前确定：

1. 部署新 `OptimisticPolicy` — **EOA 直发**（地址作为 batch 的输入）
2. Safe Batch（2 条子交易）：
   - `router.setPolicyWhitelist(newPolicy, true)`
   - `router.setPolicyWhitelist(oldPolicy, false)`

若 `cfg.policy` 为空且未传入 `--old-policy <addr>`，脚本打印错误并以退出码 1 退出，不触碰链上任何状态。仅当显式传入 `--skip-revoke` 时才跳过撤销旧 Policy 的步骤。

### `upgrade.ts`

支持 `--commerce`、`--router`、`--all`（默认）三种模式。

对每个选中的合约：

1. 部署新 impl — **EOA 直发**（地址作为 upgradeToAndCall 的参数）
2. Safe Batch（1-2 条子交易）：
   - `commerce.upgradeToAndCall(newCommerceImpl, "0x")`（`--commerce` 或 `--all` 时）
   - `router.upgradeToAndCall(newRouterImpl, "0x")`（`--router` 或 `--all` 时）

impl 部署与升级提案是两个独立步骤，控制台输出中始终明确区分。

---

## dry-run 模式

连接 `bscTestnetFork`（`hardhat.config.ts` 中已配置）。对每条 `CallItem` 以 `from=deployer` 调用 `eth_call`。输出示例：

```
[dry-run] setPlatformFee(100, 0x1234...)
  网络  : bscTestnetFork
  gas   : 28,450
  结果  : success ✓

[dry-run] pause()
  网络  : bscTestnetFork
  gas   : 21,200
  结果  : success ✓
```

revert 时打印解码后的 revert reason，以退出码 1 退出，阻止后续 `--propose` 提交。

---

## 新增依赖

```
@safe-global/protocol-kit   ^5.x   （devDependency）
@safe-global/api-kit        ^2.x   （devDependency）
```

不影响 Solidity 合约编译和现有测试基础设施。

---

## 成功标准

| 场景                        | 验证方式                                                   |
| --------------------------- | ---------------------------------------------------------- |
| EOA 模式正常执行            | `gov:commerce -- setPlatformFee` 链上确认                  |
| dry-run 模拟成功            | `--dry-run` 打印 gas 估算，无 revert                       |
| dry-run 拦截非法输入        | 越界 feeBP 打印 revert reason，退出码 1                    |
| calldata 打印               | multisig 已填，无 `--propose`：格式化 to+data 打印到终端   |
| Safe 提案创建               | `--propose` 后 Safe UI 出现待签交易                        |
| transfer-ownership runbook  | commerce/router/policy 的 owner/admin 均变为 timelockProxy |
| upgrade runbook `--dry-run` | 两个 upgradeToAndCall 均模拟成功                           |
| Timelock delay=0 生效       | commerce/router 调用通过 timelock 立即执行                 |
