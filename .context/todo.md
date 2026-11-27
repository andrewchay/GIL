# Lean 收紧落地（计划已批准 2026-11-27）

- [ ] Commit 1：判定工件化——Entry.events 内嵌 verdict + decisionId，profile 升 0.3，decisionLog 可选配置
- [ ] Commit 2：统一验证入口——src/verify.ts + `verify core|rl|agent` CLI
- [ ] Commit 3：verify-trace——RecordedPolicy + `verify-trace` CLI
- [ ] Commit 4：ontology Import.version 精确匹配 + canonical 零漂移
- [ ] 收尾：README 双语、CLAUDE.md、note.md 回填、推送

验收：npm test 全绿、check:clinical/parse:examples/demo:* 无回归、旧哈希零漂移、verify 三 profile 有演示、verify-trace 跑通重放与篡改两条路。
