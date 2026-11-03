# 盲预测实验操作手册（L2 主体间一致）

测的是：**三位独立的人读同一份材料，能否得出同一个判断**。
它测材料的可读性与合同的语义确定性，**不测系统是否正确**。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| 标注者 | 2–3 人，**均未读过 GIL 规范** |
| 独立性 | 不得互相讨论、不得查阅规范、不得查看系统判定 |
| 背景材料 | 只给[术语表](术语表.md)，不给规范正文 |
| 时间 | 每人约 45–60 分钟（40 例） |

## 2. 案例来源

案例必须来自真实业务决策，并**先脱敏再导入**。

### 2.1 脱敏检查清单

导入前逐项确认：

- [ ] 案例 `id` 已改为匿名编号（`C-01`、`C-02`…），不含研究编号、中心号、项目代号
- [ ] 删除所有自由文本描述（schema 本身不接受描述字段，防止夹带）
- [ ] `closureBasis`、`lineageRoots` 用中性占位（如 `closure-v1`、`root-a`），不含系统名或表名
- [ ] `causalDesign` 若为真实方法名，替换为等价的中性标签（如 `design-a`）
- [ ] 主张 `fact` 名不暴露具体业务对象（用 `recordAbsent` 或 `metricReady` 这类抽象名）
- [ ] 已确认案例中不含患者、用户、员工或客户的可识别信息
- [ ] 由 `disclosure.checkedBy` 具名确认（工具会强制要求 `sanitized: true`）

### 2.2 案例 JSON 格式

```json
[
  {
    "id": "C-01",
    "domain": "clinical",
    "claim": {
      "kind": "Descriptive",
      "fact": "recordAbsent",
      "causalDesign": null,
      "uncertainty": "None",
      "uncertaintyMethod": "None",
      "requiresIndependentSources": false
    },
    "snapshot": {
      "facts": {},
      "conflicts": [],
      "lineageRoots": ["root-a"],
      "observation": {
        "readability": "Available",
        "completeness": "Partial",
        "searched": true,
        "matches": 0,
        "mappingValid": true,
        "applicable": true,
        "windowMature": true,
        "scopeCovered": true,
        "watermarkCovered": true,
        "closureBasis": "closure-v1"
      }
    },
    "disclosure": { "sanitized": true, "checkedBy": "你的名字" }
  }
]
```

**系统判定不接受手工填写**，由 `evaluateSnapshot` 现场重算，避免答案键与实际实现脱节。

### 2.3 样本量

| 案例数 | κ 区间大致宽度 | 可用结论 |
|---|---|---|
| 17 | ±0.2 以上 | 只看方向 |
| 40 | ±0.12 左右 | 可判断是否过 0.6 |
| 100 | ±0.08 | 可区分 0.6 与 0.8 |

建议 40 例起步。少于 30 例时报告会自动加告警。

## 3. 执行步骤

```sh
# 1) 生成三个文件（需先准备好 cases.json）
node src/cli.ts bench:pack cases.json --out bench/run-1

# 产出：
#   bench/run-1/盲测案例.md      ← 发给标注者
#   bench/run-1/回答表-1.csv     ← 每人一份
#   bench/run-1/回答表-2.csv
#   bench/run-1/回答表-3.csv
#   bench/run-1/答案键.json      ← 绝不外发
```

发给标注者的只有：**盲测案例.md + 术语表.md + 各自的回答表 CSV**。

回收后：

```sh
node src/cli.ts bench:analyze cases.json \
  bench/run-1/回答表-1.csv bench/run-1/回答表-2.csv bench/run-1/回答表-3.csv
```

## 4. 结果解读

κ 按 **truth 与 observation 分开算**，不合并——两者是不同的量表。

| κ | 分档 | 要做的事 |
|---|---|---|
| > 0.8 | substantial | 材料可读，可进入 L3 |
| 0.6–0.8 | moderate | 有共享理解，定位分歧边界 |
| 0.4–0.6 | fair | 合同文本存在歧义，需修订 |
| < 0.4 | poor | 读的不是同一份合同，先修文档 |

**必须看区间，不能只看点估计。** 若区间跨越 0.6，结论应是"尚无法判断"，不是"达标"或"不达标"。报告会自动加这条告警。

`differsFromSystem` 列出多数意见与系统判定不一致的案例。**它不是错误率**——没有 ground truth 时无法判断谁对。它只告诉你分歧在哪里，供后续核查。

两两 κ 用于定位：如果 1×2 高而 1×3 低，问题多半在某个案例的表述，而不是整体语义。

## 5. 常见陷阱

| 陷阱 | 后果 | 防法 |
|---|---|---|
| 标注者看过规范 | κ 虚高，测的是服从 | 换人；不要用自己 |
| 标注者互相讨论 | 测的是协商结果 | 分开做，收齐前不交流 |
| 事后解释低分 | 变成给结论找理由 | 事前约定各分档的动作 |
| 只报点估计 | 把 0.61 说成"达标" | 一律连区间报 |
| 用合成案例当真人结果 | 无意义 | 合成只验证管线，示例见 `demo:bench` |
| 案例数不足就下结论 | 区间宽到无法区分 | < 30 例只报方向 |

## 6. 当前状态

| 环节 | 状态 |
|---|---|
| κ 计算（Fleiss / Cohen / bootstrap 区间） | ✅ 已实现 |
| 盲测包与回答表生成 | ✅ 已实现 |
| 回答解析（缺失/越界拒绝） | ✅ 已实现 |
| 分析报告（分维度、两两、系统差异） | ✅ 已实现 |
| 管线端到端演示 | ✅ `npm run demo:bench` |
| **真人标注数据** | ⬜ 待执行 |

演示中的 κ 数值来自受控噪声，**不能当作人类一致性证据**。
