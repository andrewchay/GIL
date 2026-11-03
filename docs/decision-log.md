# 决策日志与对齐度量（第一步）

状态：实验性度量基础设施。Profile：`gil-decision-log-0.1`。
不改动任何判定逻辑，不改 v0.1/v0.2 合同，不是审计主记录。

## 1. 为什么需要它

GIL 现有测试全部落在**自洽性**：同一输入是否得到同一结论。没有任何一条证据回答**判对了吗**。

四层对齐要分开测：

| 层次 | 问题 | 本模块 |
|---|---|---|
| L1 自洽 | 同一输入是否总得同一判定 | ✅ 已实现 |
| L2 主体间一致 | 两个人是否读出同样的规则 | ⬜ 需盲测，见 §6 |
| L3 与事实一致 | 判 `True` 的事后来是否成立 | 🟡 已备回填接口，无数据 |
| L4 与意图一致 | 接受的动作是否达成目的 | ⬜ 需下游回访 |

没有日志，L3/L4 无法开始。这是先做它的唯一理由。

## 2. 记录结构

日志是**追加式 JSONL**，每行一条记录，带 `recordHash`（`sha256:` 内容哈希）与单调 `sequence`。任何一行被改写，下次读取即 `LOG_TAMPERED`。

判定记录：

```text
DecisionRecord {
  kind: 'decision', id, sequence, decidedAt
  contractHash, snapshotHash          // 语义身份：同一合同 + 同一输入快照
  claimKind
  truth, observation, issues, reviewRequired
  outcome?                            // Succeeded|Failed|Unknown|NotExecuted
  recordHash
}
```

事实回填记录：

```text
GroundTruthRecord {
  kind: 'ground-truth', id, sequence, decisionId, recordedAt
  value: True|False
  source: audit|expert-consensus|downstream-data
  auditor, note?, supersedes?
  recordHash
}
```

**回填是独立追加事件，绝不改写原判定。** 同一判定要纠错，必须显式 `supersedes` 上一条，否则 `GROUND_TRUTH_CONFLICT`。理由：用可变日志测不可变系统，结论没有意义。

`source` 必填且分开统计。三种来源可信度不同，合成一个数字会掩盖最难的部分。

## 3. 使用

```ts
import { DecisionLog, fileSink, summarize, fieldsFromReport } from './src/decision-log.ts';

const log = new DecisionLog(fileSink('.gil-logs/decision.jsonl'));

// 判定产生后立即记录
log.appendDecision(fieldsFromReport(report, claim.kind, decidedAt, { contractHash, snapshotHash }, outcome));

// 事后审计（可晚于判定数天，独立事件）
log.appendGroundTruth({ decisionId, recordedAt, value: 'False', source: 'audit', auditor: 'A-17' });

const summary = summarize(log.records());
```

`decidedAt` 与 `recordedAt` 必须显式传入，模块不自取时钟——避免"隐藏时间"成为判定的一部分。

演示：

```sh
npm run demo:decision-log                    # 内存，不产生文件
npm run demo:decision-log -- .gil-logs/x.jsonl
```

## 4. 指标定义

**L1 重复率**

```text
rate = 与组内首次判定不一致的条数 / 参与比较的条数
分组键 = contractHash + snapshotHash
判定身份 = truth + observation + issues + reviewRequired
```

确定性实现应恒为 `0`。非 0 意味着存在隐藏状态（时钟、顺序、随机）。

`outcome` **刻意不参与**比较：外部执行的成败会变化，把它算进去会把"重试成功"误报为语义漂移。

**汇总**

`summarize` 返回计数与各自定义明确的比例，不合成"对齐度总分"：

```text
decisions, byTruth, byObservation
unknownShare          // 判 Unknown 的比例
reviewRequired        // 转入人工审阅的条数
groundTruth.covered   // 有回填的判定数
groundTruth.coveredShare
groundTruth.bySource  // 按来源分开
repeat                // L1
```

`unknownShare` 偏高值得单独追查：可能是数据不足，也可能是系统在用 Unknown 逃避判断。

## 5. 已实现与限制

实现：追加写入、内容哈希校验、序列单调、严格字段、拒绝 Proxy/getter、回填冲突拒绝、L1 计算、汇总、文件与内存 sink。

限制：

- **无签名**：哈希证明未被编辑，不证明写入者身份，也不证明写入时正确。
- **无跨进程事务**：两个进程同时追加可能交错。
- **无持久审计**：演示默认用内存 sink；文件 sink 只是本地 JSONL。
- **覆盖率决定结论上限**：`groundTruth.coveredShare` 低时，L3 根本不成立，不要把 `byTruth` 当作准确率。
- **样本量**：100 条只能分辨 10% 量级，分辨不了 1% 与 2% 的差别。报区间，不报点估计。

## 6. L2 盲测（尚未实现，人工执行）

1. 取 20 个 `(合同, 快照, 判定)` 三元组，隐藏判定。
2. 2–3 位独立标注者只读前两项，预测系统会判什么。
3. 算 Cohen's κ 或 Krippendorff's α。

| κ | 含义 |
|---|---|
| > 0.8 | 合同语义几乎无歧义 |
| 0.6–0.8 | 有共享理解，边界有分歧 |
| < 0.4 | 读的不是同一份合同 |

必须盲测。标注者看到系统答案后，测的是服从性不是理解。

κ 低比 L3 判错更严重：它说明形式化本身没有起作用。

## 7. 待接入

- `agent-sdk.ts` 的 `event()` 目前只记 `{type, actor, binding}`。接入日志需要在宿主层调用 `fieldsFromReport`，而不改动 Gate 自身的判定路径。
- 真实部署前需补：签名、可信时间源、并发写入锁、存储配额与轮转。

## 8. 一句话

**先能证明"判得稳定"，才谈得上"判得对"。** 本模块只负责前者，并把后者的接口留好。
