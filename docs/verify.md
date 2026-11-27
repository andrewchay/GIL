# verify — 统一验证入口

`verify` 是 GIL 静态检查的**单一入口**：一个命令组合所有静态面，输出带版本的结果对象。
在此之前，检查能力分散在 checker、rl-checker、agent-semantics 等处，
消费者自己拼装检查路径会重建多个不可审计的"伪内核"。

## 用法

```sh
# Core 规约：parse → link → check
node src/cli.ts verify core docs/clinical-operations/monitoring-remediation/workflow.gil \
  docs/clinical-operations/monitoring-remediation/ontology.gil

# RL 环境：parseEnvironment → checkEnvironment
node src/cli.ts verify rl examples/机器人导航.gil

# Agent 合同：draft/snapshot 结构 + 判定 dry-run（文件格式 {"draft":…, "snapshot":…}）
node src/cli.ts verify agent contract.json
```

## 输出格式（版本 `gil-verify-0.1`）

```json
{
  "ok": true,
  "profile": "gil-core-clinical-0.1",
  "verifyVersion": "gil-verify-0.1",
  "checks": [{ "name": "parse-spec", "ok": true }, { "name": "core-check", "ok": true }],
  "hashes": { "spec": "sha256:…", "ontology-0": "sha256:…" }
}
```

- `profile` 是**被验对象**的 profile；`verifyVersion` 是**结果对象自身**的格式版本。改输出结构时升后者，不影响前者。
- 逐项报告、不 fail-fast：每个 check 有名字，失败带结构化 `code`。
- 退出码取整体 `ok`；`ok:false` 时为 1。

## 边界：verify 不是授权判定

`verify` 只覆盖**静态面**。以下判定依赖运行时可变状态，**不属于也不应属于**本入口：

| 不在 verify 范围 | 原因 |
|---|---|
| delegation gate（Grant/预算/撤销） | 依赖运行时预算累计与撤销状态 |
| assurance gate（凭证有效性） | 依赖受信时钟与可失效凭证 |
| 执行授权 | 授权 = 合同 + 接受 + 审阅 + Grant + 预算 + 时钟的运行时合取 |

`verify agent` 的 `snapshot-verdict` 是 **dry-run**：它证明"对该快照可以重复做出同一判定"，
不证明判定正确、更不证明允许执行。把 verify 输出当作授权是本项目的第一类误用。
