# Lean 收紧落地（计划已批准 2026-11-27，已完成）

- [x] Commit 1：判定工件化——e3e57fc，profile 0.3，verdictIdentity 单点口径
- [x] Commit 2：统一验证入口——1f90a8a，gil-verify-0.1 + docs/verify.md
- [x] Commit 3：verify-trace——e72a341，recordDecisions 补齐失败调用语义
- [x] Commit 4：ontology 版本绑定显式化——4f9b9bb，计划修正（检查已存在），零漂移锁定
- [x] 收尾：README 双语 325 基线 + verify 用法、CLAUDE.md、note.md 回填、推送

验收全过：npm test 325 全绿、check:clinical/parse:examples/demo:* 无回归、临床 digest 固定锁定、verify 三 profile 有 happy/失败测试、verify-trace 跑通重放一致与篡改检测。
第二切片（金融合规审批）概要在 plan/lean-tightening.md，未启动，待下轮。
