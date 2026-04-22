# APEX v1 · 实现计划

> 状态:DRAFT · 作者:Declan · 最后更新:2026-04-22
>
> 本计划将替换当前 APEX 实现,采用更清晰的三层架构。kernel 层严格符合
> ERC-8183 规范,通过 Router 引入可插拔 policy 模型,并提供一个参考实现
> `OptimisticPolicy`(基于"沉默即赞成 + 白名单否决")。

---

## 1 · 目标

将协议重写为三个解耦的层:

1. **`AgenticCommerceUpgradeable`** — ERC-8183 kernel。UUPS 可升级。
   轻量化:保留完整规范 surface,剥离所有规范未要求的功能(meta-transactions、
   permit、基于 role 的权限控制、hook whitelist、evaluator fee)。
2. **`EvaluatorRouterUpgradeable`** — routing 层。UUPS 可升级。
   同时作为使用它的每个 job 的 `evaluator` 和 `hook`。维护
   `jobId → policy` 的映射,按需从 policy 拉取 verdict。
3. **`OptimisticPolicy`** — 参考 policy 实现。Immutable。默认通过;
   Client 可 `dispute`;白名单 voter 可 `voteReject`;通过 Router 的
   permissionless `settle()` 路径推进裁决。

---

## 2 · 架构

```
┌────────────────────────────────────────────────────────┐
│ AgenticCommerceUpgradeable        (UUPS)               │
│  - 完整 ERC-8183 kernel                                 │
│  - 6 状态 · 8 核心函数 · hook 支持                       │
│  - Ownable2Step + Pausable                             │
└───────────────┬────────────────────────────────────────┘
                │ job.evaluator == router
                │ job.hook      == router
                │ commerce ──► afterAction(SUBMIT) ──► router
                ▼
┌────────────────────────────────────────────────────────┐
│ EvaluatorRouterUpgradeable        (UUPS)               │
│  - IACPHook(submit 通知通过这里中转)                    │
│  - registerJob(jobId, policy)                          │
│  - settle(jobId, evidence) → 从 policy 拉 verdict       │
│  - Ownable2Step + ERC-7201 storage                     │
└───────────────┬────────────────────────────────────────┘
                │ router ──► policy.onSubmitted()  (submit 时触发一次)
                │ router ──► policy.check()        (每次 settle 时调用)
                ▼
┌────────────────────────────────────────────────────────┐
│ IPolicy                                                │
│  - onSubmitted(jobId, deliverable)                     │
│  - check(jobId, evidence) → (verdict, reason)          │
└───────────────┬────────────────────────────────────────┘
                │ 由以下合约实现
                ▼
┌────────────────────────────────────────────────────────┐
│ OptimisticPolicy                  (immutable)          │
│  - Client → dispute(jobId)                             │
│  - Voter  → voteReject(jobId)                          │
│  - Router → check() → Pending / Approve / Reject       │
│  - Admin  → addVoter / removeVoter / setQuorum         │
└────────────────────────────────────────────────────────┘
```

### 为什么要分三层

- **Commerce** 是 protocol 层。必须保持最小且符合规范,以便链下 agents、钱包、
  indexer 可以将其视为标准的 ERC-8183 节点。
- **Router** 是 orchestration 层。它是 kernel 唯一感知的外部地址;policy
  可以在 Router 背后来去自如。它还承担了 hook 职责,因此每个 policy 不需要
  单独实现 `IACPHook`。
- **Policy** 是 strategy 层。按 job 可替换。每个 policy 有自己独立的规则、
  voter 集合、窗口配置与失败模式。

---

## 3 · 角色

| 角色 | 权限 | 持有者 |
|---|---|---|
| **Commerce Owner** | `setPlatformFee`、`pause`、UUPS upgrade | 建议使用 multisig |
| **Router Owner** | `setPolicyWhitelist`、`setCommerce`、UUPS upgrade | 建议使用 multisig |
| **Policy Admin** | `addVoter`、`removeVoter`、`setQuorum` | 可按 policy 不同 |
| **Voter** | `voteReject(jobId)` | 白名单地址 |
| **Client** | 创建、fund、register、dispute | 每个 job 1 人 |
| **Provider** | 提交 deliverable、触发 `settle` | 每个 job 1 人 |

---

## 4 · User Flow

### 4.1 · 一次性部署

```
CommerceOwner
  1. 部署 Commerce proxy
     commerce.initialize(paymentToken, treasury, commerceOwner)
  2. commerce.setPlatformFee(500, treasury)            // 可选 5% 平台费

RouterOwner
  3. 部署 Router proxy
     router.initialize(commerce, routerOwner)

PolicyAdmin
  4. 部署 OptimisticPolicy(commerce, router, 3 days, quorum = 3, policyAdmin)
  5. policy.addVoter(voter1)
  6. policy.addVoter(voter2)
  7. policy.addVoter(voter3)                            // ≥ quorum,建议更多以防掉线

RouterOwner
  8. router.setPolicyWhitelist(policy, true)
```

### 4.2 · Flow A — Happy Path(沉默即赞成)

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
Day 1-4│ Client 检查交付物,满意,不做任何动作
       │
Day 4  │ 任何人(通常是 Provider,为了拿钱)
       │   └─ router.settle(jobId, "")
       │        ├─ policy.check() → (Approve, "OPTIMISTIC_APPROVE")
       │        └─ commerce.complete(jobId, reason, "")          [Completed]
       │             ├─  5 USDC → treasury  (平台费)
       │             └─ 95 USDC → Provider ✅
```

### 4.3 · Flow B — Disputed 且 Rejected(达到 quorum)

```
Day 0-1 │ … 同 Flow A(createJob → fund → submit)
        │   submittedAt[jobId] = Day 1
        │
Day 2   │ Client(对交付物不满意)
        │   └─ policy.dispute(jobId)                 [disputed = true]
        │
Day 2-4 │ Voter A → policy.voteReject(jobId)         rejectVotes = 1
        │ Voter B → policy.voteReject(jobId)         rejectVotes = 2
        │ Voter C → policy.voteReject(jobId)         rejectVotes = 3 (= quorum)
        │
Day 4   │ 任何人(通常是 Client)
        │   └─ router.settle(jobId, "")
        │        ├─ policy.check() → (Reject, "QUORUM_REJECT")
        │        └─ commerce.reject(jobId, reason, "")           [Rejected]
        │             └─ 100 USDC → Client ✅
```

> 注:规则 1(`disputed && rejectVotes ≥ quorum → Reject`)**不需要等
> `disputeWindow` 结束**。票一达标,settle 就能立刻 reject。

### 4.4 · Flow C — Disputed 后僵持 → Expired(兜底)

```
Day 0-1 │ … 同 Flow A(expiredAt = Day 30)
Day 2   │ Client disputes
Day 2-30│ 只有 1 个 voter 投了 voteReject(quorum = 3,未达到)

Day 4   │ 任何人 → router.settle(jobId, "")
        │   policy.check() → (Pending, 0)
        │   router 以 NotDecided revert          ← Provider 无法拉款
        │
Day 4-30│ 死锁。无人能推进状态机。
        │
Day 30  │ 任何人(通常是 Client)
        │   └─ commerce.claimRefund(jobId)                       [Expired]
        │        └─ 100 USDC → Client ✅
        │   (policy 状态残留但无害;该 jobId 不会再被引用)
```

### 4.5 · Flow D — Open 状态取消

```
Day 0 │ Client createJob → setBudget →(尚未 fund)
Day 0 │ Client
      │   └─ commerce.reject(jobId, reason, "")                  [Rejected]
      │      (Open 状态 client 直接 reject;无 escrow、无退款)
```

### 4.6 · Flow E — Funded 后 provider 永不 submit

```
Day 0  │ Client fund                                              [Funded]
Day 0-30│ Provider 从不 submit
Day 30 │ 任何人 → commerce.claimRefund(jobId)                    [Expired]
       │    100 USDC → Client ✅
```

### 4.7 · 经济结果摘要

| 路径 | Client 余额 | Provider 余额 | 持续时间 |
|---|---|---|---|
| A · Happy | −100 | +95(扣 5% 费用) | 最少 3 天 |
| B · Rejected | 0 | 0 | 3 天内可完成(投票及时) |
| C · Stalemate | 0 | 0 | 锁到 `expiredAt`(如 30 天) |
| D · Open 取消 | 0 | 0 | 立即 |
| E · 未 submit | 0 | 0 | 锁到 `expiredAt` |

---

## 5 · 合约细节

### 5.1 · `AgenticCommerceUpgradeable.sol`(重写,轻量化)

- **Inheritance**:`Initializable` + `Ownable2StepUpgradeable` +
  `PausableUpgradeable` + `UUPSUpgradeable` + `ReentrancyGuardTransient`。
- **Storage**:扁平 upgradeable 布局(与当前合约 slot 模式一致,保持统一的
  心智模型)。字段:`paymentToken`、`platformFeeBP`、`platformTreasury`、
  `jobCounter`、`mapping(uint256 => Job) jobs`、
  `mapping(uint256 => bool) jobHasBudget`。
- **ERC-8183 surface**(所有 `MUST` + `SHOULD`):
  - `createJob`、`setProvider`、`setBudget`、`fund`、`submit`、`complete`、
    `reject`、`claimRefund`。
  - `setBudget` 可由 client 或 provider 调用(按规范)。
  - `fund(jobId, expectedBudget)` front-running 保护。
  - `claimRefund` **不**带 `whenNotPaused`、**不**可 hook。
  - Hook 调用走 ERC-165 校验,`HOOK_GAS_LIMIT = 1_000_000`。
- **Events**:严格对齐规范集合。无 `ReputationSignal`(已移除)。
- **Admin**:`setPlatformFee(feeBP, treasury)`、`pause`、`unpause`。
- **不实现**(相对现有实现):`fundWithPermit`、ERC-2771 meta-transactions、
  `AccessControl` 多 role(改用 `Ownable2Step`)、hook whitelist、
  `evaluatorFeeBP`。

### 5.2 · `EvaluatorRouterUpgradeable.sol`(新增)

- **Inheritance**:`Initializable` + `Ownable2StepUpgradeable` +
  `PausableUpgradeable` + `UUPSUpgradeable` + `IACPHook`。
- **Storage**:ERC-7201 命名空间 `"apex.router.storage.v1"`。字段:
  `commerce`、`mapping(uint256 => address) jobPolicy`、
  `mapping(address => bool) policyWhitelist`。
- **Pause 语义**:`pause()` 只阻断 `registerJob`(即停止接受**新** job);
  `settle`、`beforeAction`、`afterAction` 不受 pause 影响,保证 in-flight
  jobs 可以继续走完流程。这是故意设计 —— 支撑 R6 的迁移 SOP。
- **Public functions**:
  - `registerJob(uint256 jobId, address policy)` — `whenNotPaused`
    - 调用者必须是 `commerce.jobs(jobId).client`。
    - Job 状态必须是 Open。
    - `commerce.jobs(jobId).evaluator == address(this)`。
    - `commerce.jobs(jobId).hook == address(this)`。
    - `policyWhitelist[policy] == true`。
    - 一次性:`jobPolicy[jobId] == address(0)`。
  - `settle(uint256 jobId, bytes calldata evidence)`(permissionless)
    - `nonReentrant`。
    - 读取 `policy = jobPolicy[jobId]`。
    - 调用 `policy.check(jobId, evidence)`。
    - `verdict == 1 → commerce.complete(jobId, reason, "")`。
    - `verdict == 2 → commerce.reject(jobId, reason, "")`。
    - `verdict == 0 → revert NotDecided`。
  - `beforeAction(jobId, selector, data)`(IACPHook)
    - `require(msg.sender == commerce)`。
    - `selector == FUND_SELECTOR → require(jobPolicy[jobId] != 0)`。
    - 其他 selector:noop。
    - **不加** `nonReentrant`:为避免
      `settle → commerce.complete → router.afterAction` 链路 self-lock;
      访问控制靠 `msg.sender == commerce` 保证。
  - `afterAction(jobId, selector, data)`(IACPHook)
    - `require(msg.sender == commerce)`。
    - `selector == SUBMIT_SELECTOR → policy.onSubmitted(jobId, deliverable)`。
    - 其他 selector:noop。
    - **不加** `nonReentrant`(同上)。
  - `supportsInterface` — `IACPHook` + `IERC165`。
- **Admin**:
  - `setPolicyWhitelist(address policy, bool status)`。
  - `setCommerce(address newCommerce)` — 仅当无 active jobs 时允许
    (未来迁移 hatch;见 §6 R5)。
  - `pause()` / `unpause()` — `onlyOwner`;仅阻断 `registerJob`(见 R6)。
  - `_authorizeUpgrade` — `onlyOwner`。

### 5.3 · `OptimisticPolicy.sol`(新增,immutable)

- **Inheritance**:纯合约(不可升级)。无 `Pausable`、无 `ReentrancyGuard`
  (不需要——所有状态修改函数只写一个字段 + emit 一个事件,无任何外部调用)。
- **Immutable config**:
  `commerce`、`router`、`disputeWindow`(例如 3 days)。
- **Mutable config**(admin 控制):
  `voteQuorum`。
- **Per-job state**:
  - `mapping(uint256 => uint64) submittedAt`
  - `mapping(uint256 => bool) disputed`
  - `mapping(uint256 => uint16) rejectVotes`
  - `mapping(uint256 => mapping(address => bool)) voted`
- **白名单**:`mapping(address => bool) isVoter`、`uint16 activeVoterCount`、
  `address admin`。
- **Functions**:
  - `onSubmitted(jobId, deliverable)` — router-only。对 `submittedAt[jobId]`
    仅首次写入有效。
  - `dispute(jobId)` — client-only;检查 status == Submitted;检查
    `submittedAt[jobId] != 0`;检查仍在 `disputeWindow` 内;置 `disputed`。
  - `voteReject(jobId)` — voter-only;要求 `disputed == true`;每个 voter
    只能投一次;计数 +1。
  - `check(jobId, evidence)` — router-only,`view`:
    - 规则 1:`disputed && rejectVotes ≥ voteQuorum` →
      `(Reject, "QUORUM_REJECT")`。
    - 规则 2:`!disputed && submittedAt != 0 && now ≥ submittedAt + disputeWindow`
      → `(Approve, "OPTIMISTIC_APPROVE")`。
    - 规则 3:其他 → `(Pending, 0)`。
  - Admin:
    - `addVoter(addr)` — 要求 `!isVoter[addr]`;置位并 `activeVoterCount++`。
    - `removeVoter(addr)` — 要求 `isVoter[addr]`;清位并 `activeVoterCount--`;
      **revert 条件**:`activeVoterCount - 1 < voteQuorum`(会把
      in-flight dispute 的 quorum 搞到不可能达到)。
    - `setQuorum(uint16 newQuorum)` — 要求
      `newQuorum > 0 && newQuorum <= activeVoterCount`。对 in-flight
      jobs 立即生效。
    - `transferAdmin(addr)`。

### 5.4 · `IACP.sol`(新增 — 实现级接口)

> **不是 ERC-8183 的子集**。这是 Router / Policy 与 Commerce kernel 之间
> 的内部契约。集成第三方 ERC-8183 kernel 需要写一个 adapter。

声明:
- `enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }`
- `struct Job { ... }`(与 Commerce storage 布局一致)
- `getJob(uint256) → Job memory`
- `complete(uint256, bytes32, bytes)`
- `reject(uint256, bytes32, bytes)`
- `paymentToken() → address`

### 5.5 · `IPolicy.sol`(新增)

```solidity
interface IPolicy {
    function onSubmitted(uint256 jobId, bytes32 deliverable) external;
    function check(uint256 jobId, bytes calldata evidence)
        external view returns (uint8 verdict, bytes32 reason);
}
```

Verdict 取值:
- `0` = Pending(无动作;Router revert)
- `1` = Approve(Router 调 Commerce.complete)
- `2` = Reject(Router 调 Commerce.reject)

### 5.6 · `IACPHook.sol`(保留现有代码,不改动)

ERC-8183 normative 接口。

---

## 6 · Risks

### R1 · Router hook 可升级违反 ERC-8183 SHOULD

> 规范原文:"Hooks SHOULD NOT be upgradeable after a job is created."

Router 是 UUPS,每个注册到 Router 的 job 都以 Router 作为 hook,因此对
所有 active jobs 来说 Router 都是一个可升级的 hook。

**这是 SHOULD 级别的偏离,不是 MUST 违反**。Commerce / kernel 层所有
ERC-8183 MUST 要求都依然满足;对严格合规的集成方,通过 NatSpec 和
README 明确告知,让他们自主决定是否接入。

**缓解措施**(纵深防御):

1. **治理 — 所有 owner 使用 multisig**。Commerce Owner、Router Owner、
   Policy Admin **必须**使用多签钱包(Gnosis Safe 或同类);Owner 级别
   建议 ≥ 3-of-5 阈值。
2. **Safe 与 proxy 之间挂 Timelock**。建议延迟:Router 24 小时,
   Commerce 48 小时;Policy admin ops(`addVoter` / `setQuorum`)可保持
   0 小时,因其非安全关键。
3. **默认策略:绝不升级**。日常运行时把 Router 视为 immutable,只有
   关键 bug 才触发升级;每次升级都当作安全事件。
4. **Router 合约 NatSpec header 显式披露** —
   "Deviates from ERC-8183 SHOULD: hook is upgradeable via UUPS under
   multisig + timelock governance."
5. **README 披露** — 协议文档同步标注,让集成方可以审计或跳过 Router。
6. **升级评审 SOP** — 每次 Router 升级提案必须包含:
   (a) 新 impl 的 git sha;(b) 在 testnet 上已验证的 etherscan 链接;
   (c) `beforeAction` / `afterAction` 的 diff(预期:无功能变更);
   (d) 多签签署人明确确认对 in-flight jobs 的 hook 语义保持不变。

### R2 · Router 是所有 routed job 的唯一 hook 入口

Router hook 一旦出 bug(无论是否由升级引入),所有 in-flight routed
job 都会受影响:`afterAction` 的 bug 会破坏 `submit`;`beforeAction`
的 bug 会阻塞 `fund`。

**缓解措施**:(a) 最小化 Router 的 hook surface —— 只有 `SUBMIT` 和
`FUND` 有实际逻辑,其他 selector 全部 noop;(b) 测试穷举所有 selector
路径;(c) Router owner 使用 multisig;(d) 用户始终有 `claimRefund`
作为逃生通道(不受 Router hook 故障影响,因为 `claimRefund` 不可 hook)。

### R3 · 默认通过 + voter 缺席

如果整个 voter 集合全部离线或不关心,所有存在正当 dispute 的 job 都会
在 `disputeWindow` 结束后被 Approved。"沉默"本意是赞成,但实际上可能是
voter 缺席。

**缓解措施**:(a) 这是 `OptimisticPolicy` 刻意接受的设计 trade-off ——
乐观 = 追求低开销,v1 不为此做链上设计变更;(b) 运行时保持至少
3 × `voteQuorum` 数量的 voter 配合 24/7 监控以降低缺席概率;(c) v2 可让
policy 支持 per-job `disputeWindow`,client 可选 0 以强制主动审批。

### R4 · Voter 共谋

Client dispute 后,`voteQuorum` 个恶意 voter 共谋可以 reject 任意 job,
使 client 无限次拿到退款。这是 `OptimisticPolicy` 的根本信任假设。

**缓解措施**:(a) 谨慎挑选 voter;(b) 每个 voter 使用独立 multisig;
(c) 一旦信任度下降,部署新 policy 配新 voter 集合并取消旧 policy
的 whitelist。

### R5 · IACP 是实现级而非标准级

IACP 定义了 Router / Policy 与 Commerce 之间的内部契约,不是 ERC-8183
的严格子集。因此无法直接把 Router 接到第三方 ERC-8183 kernel 上,必须
写 adapter。

**缓解措施**:`Router.setCommerce(IACP)` 带守卫(仅在无 active jobs 时
可调)作为未来迁移 hatch。未来可写 `ACPAdapter` 合约适配任意合规 kernel。

### R6 · in-flight jobs 无法强制迁移

`job.evaluator` 和 `job.hook` 在 `createJob` 时钉死,没有重写路径。
如果 Commerce 或 Router 出现状态 bug,in-flight jobs 无法被强制迁往
新合约。

**缓解措施**:利用两个合约各自暴露的 pause 开关,走"截新单 / 排旧单"
(stop new / drain old)流程,不做 in-flight 重写。

**Router 排空 SOP**

1. RouterOwner → `router.pause()`(阻断**新** `registerJob`;已存在的
   jobs 不受影响 —— `settle`、`beforeAction`、`afterAction` 不进 pause
   区间,in-flight jobs 可以正常走完)。
2. 按需部署 `Router2`(新 proxy)。
3. 更新 SDK / 前端,让新 job 指向 `Router2`。
4. 旧 Router 上的 in-flight jobs 通过 `settle` 完成,或通过
   `claimRefund` 过期退款。
5. 可选:旧 Router 完全排空后可永久 pause 或在文档中正式声明废弃。

**Commerce 排空 SOP**

1. CommerceOwner → `commerce.pause()`(阻断 `createJob`、`fund`、
   `submit`、`complete`、`reject`)。`claimRefund` **不**走
   `whenNotPaused`,用户始终有退款通道。
2. 过了 `expiredAt` 的 in-flight jobs 可立刻通过 `claimRefund(jobId)`
   退款;仍在窗口内的 jobs 等到 `expiredAt` 时变得可退。
3. 按需部署 `Commerce2`,所有新 job 走新合约。
4. 旧 Commerce 永久 pause;唯一活跃路径是 `claimRefund`,把 escrow
   退给 clients。

**刻意不支持的能力**(设计决定)

- 修改已有 job 的 `job.evaluator` 或 `job.hook`。
- 把 in-flight job 从 Commerce1 迁到 Commerce2(只能 `claimRefund`
  后在 Commerce2 上重建)。
- "强制 settle" 一个卡在坏 policy 里的 in-flight job(等 `expiredAt`
  退款)。

以上兜底依据:`claimRefund` 是**通用逃生通道** —— 不可 pause、不可 hook、
`expiredAt` 之后永远可调。所有卡死场景最终都能让 client 拿回自己的钱。

### R7 · ERC-8183 规范漂移

本文撰写时 ERC-8183 处于 Draft 状态,规范变更可能破坏我们的实现。

**缓解措施**:(a) 小漂移 → UUPS 升级;(b) 中漂移 → UUPS 升级 + Router
接口修改;(c) 大漂移 → 新部署,手工迁移。

---

## 7 · Open Items

目前没有阻塞 execution 的事项。以下条目在 v2 重访:

- [ ] Per-job policy 配置(例如 client 自选 `disputeWindow`)。
- [ ] Voter staking / slashing。
- [ ] Voter 激励(从 platform fee 或 evaluator fee 中拨付)。
- [ ] 集成 ERC-8004 reputation registry。
- [ ] 为第三方 ERC-8183 kernel 写 adapter。
- [ ] 紧急迁移用的 "freeze + drain" 管理员路径。
- [ ] 如果 agent relayer 需要,支持 meta-transactions (ERC-2771)。

---

## 8 · Scope

### 8.1 · 新增文件

- `contracts/AgenticCommerceUpgradeable.sol`(重写)
- `contracts/EvaluatorRouterUpgradeable.sol`
- `contracts/OptimisticPolicy.sol`
- `contracts/IACP.sol`
- `contracts/IPolicy.sol`
- `test/AgenticCommerce.test.ts`
- `test/EvaluatorRouter.test.ts`
- `test/OptimisticPolicy.test.ts`
- `test/Lifecycle.test.ts`
- `test/helpers.ts`
- `scripts/deploy.ts`
- `scripts/upgrade-commerce.ts`
- `scripts/upgrade-router.ts`

### 8.2 · 保留文件

- `contracts/IACPHook.sol`
- `contracts/MockERC20.sol`
- `hardhat.config.ts`(精简)
- `CLAUDE.md`、`LICENSE`、`.gitignore`、`.prettierrc`、`.solhint.json`、
  `.nvmrc`、`tsconfig.json`

### 8.3 · 删除文件

- `contracts/APEXEvaluatorUpgradeable.sol`
- `contracts/IAPEXEvaluator.sol`
- `contracts/BaseACPHook.sol`
- `contracts/ERC1967Proxy.sol`
- `contracts/MockOptimisticOracleV3.sol`
- 现有所有 `scripts/*`
- 现有所有 `test/*`
- `deployments/bsc-testnet.json`

### 8.4 · 修改文件

- `package.json` — scripts 瘦身;移除 `hardhat-keystore`、
  `safe-singleton-factory`。
- `README.md` — 按 v1 重写。
- `.env.example` — 精简至 RPC / PK / ETHERSCAN_API_KEY + proxy 地址。
- `CLAUDE.md` — Architecture 章节同步到 v1。

---

## 9 · Verify(完成定义)

1. `npx hardhat compile` 在 `solc 0.8.28 + viaIR` 下无警告通过。
2. `npm test` — 所有用例通过,预期 45–55 个。
3. ERC-8183 conformance 测试:
   - 6 状态完整转换矩阵。
   - `setBudget` 可由 client 或 provider 调用。
   - `fund(expectedBudget)` front-running 保护。
   - `claimRefund` 在 pause 期间依然可调。
   - `claimRefund` 永不触发 hook。
   - `hook == address(0)` 路径完全跳过 hook 调用。
4. OptimisticPolicy 路径覆盖:
   - Happy(无 dispute,乐观 approve)。
   - Disputed + quorum → Reject。
   - Disputed + quorum 未达 → Stalemate → Expired。
   - `dispute` 超窗口 → revert。
   - `voteReject` 未 dispute → revert。
   - `voteReject` 重复投票 → revert。
   - `check` 非 router 调用 → revert。
5. Router:
   - `registerJob` 权限 / 状态 / whitelist 校验。
   - `settle` 三分支分发(Pending revert、Approve 调 complete、Reject 调 reject)。
   - `_authorizeUpgrade` 仅 owner。
   - `setCommerce` 仅在无 active job 时可调。
   - `pause()` 只阻断 `registerJob`,**不**阻断 `settle` /
     `beforeAction` / `afterAction`(in-flight jobs 在 pause 期间必须继续
     正常工作)。
   - `unpause()` 恢复 `registerJob`。
6. Policy voter 账本:
   - `addVoter` 使 `activeVoterCount` +1;重复添加 revert。
   - `removeVoter` -1;若会导致低于 `voteQuorum` 则 revert。
   - `setQuorum` 在 `== 0` 或 `> activeVoterCount` 时 revert。
7. Commerce 和 Router 各做一次 UUPS mock 升级(新增字段 → 读旧 state)。
8. `scripts/deploy.ts` 在 `bscTestnet` 端到端跑通;三个地址落盘到
   `deployments/<network>.json`。
