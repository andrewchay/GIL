# 一致性修复计划（2026-10-31 已完成；时序规则选 B1）

## 目标

修复体检中发现的 2 个语义问题和 4 处文档或状态漂移。不新增能力。

## 步骤

1. **knowledge 名与全局名冲突**：checker 对 knowledge 名和 context/input/output/state 同名报 `DUPLICATE_NAME`。
   - 反例：`input { limit: Int; } knowledge { open limit: Int; }` 现在没有诊断，monitor 返回 true，open 被静默遮蔽。
2. **Core 时序绑定不一致**：`eventually within 2.minutes a == b` 绑定整个比较；`always a == b` 只绑定 `a`。
   - 二选一：让 `within` 也只绑定 unary（与 EBNF 一致），或为 `always`/`eventually` 加诊断，例如 `TEMPORAL_BINDS_UNARY`。
   - 同步修正 `examples/酒店预订.gil:47`，加括号。
3. **文档漂移**：
   - 修正 `docs/interpretation-profile.md:9`。它仍写“暂不支持 lexicon、assume”。
   - 把 `.context/plan/phase4.md` 状态改为已完成。
   - 把 `.context/plan/evaluation.md` 状态改为已完成。
4. **parser 小清理**：`expect()` 的 unsupported 探测列表仍含已支持的 `{`、`?`、`|`、`source`、`within`。只影响错误码分类。

## 验收

- 新增反例测试：同名遮蔽有诊断，时序绑定规则有测试固定。
- 215 项现有测试不回退。
- `npm run parse:examples` 与 8 个 demo 全绿。
