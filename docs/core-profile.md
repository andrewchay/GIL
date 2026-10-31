# Phase 0/1：临床 Core 原型 Profile

版本：`gil-core-clinical-0.1`。状态：实验性实现契约。
本 profile 细化现有设计草案，不冻结完整 GIL，也不宣称全面符合 Core EBNF。

## 1. 边界与能力

使用 TypeScript 源码及 Node.js >=24 原生类型擦除执行。无第三方运行依赖。Node 运行不等于 TypeScript 编译器类型检查；本项目的 `check` 是 GIL 类型检查，不是 tsc。

**解析能力与求值能力不是同一件事。** 下表左侧的构造现在都能被解析并进入 AST；右侧才是 checker 与模拟器实际能判定的范围。解析通过不等于该构造已被检查或求值。

已可解析的语法：
- 本体概念、identity、字段、带函数体的纯关系。
- 精确本体版本导入及别名；Text、Bool、Int、Decimal、导入概念类型。
- 构造类型 `Option<T>`、`Entity<T>`、`Set<T>`、`A | B`、`T?`、记录类型 `{ n: T | 判定 }`。
- context、input、output、state；knowledge（open/assert/assume/disputed/ambiguous/operationalize）；goals（achieve/prefer）；require；action 参数、`-> T` 返回值、requires、ensures、writes、preserves、outcomes、failure、atomic、retryable、reversibility、compensate；verification（verify/by/under）。
- 字面量、字段引用、纯关系调用、下一状态引用、逻辑比较和算术；一阶量词 `forall`/`exists`；单位字面量 `24.hours`；`eventually within N.<unit>`。
- 来源声明 `source <expr> as asserted|assumed|inferred|disputed`。
- 词法表 `lexicon ... for ...`；多文档 bundle（`parseBundle`）。
- GIL-RL 环境文档与 `delegate` 请求语法；二者各有独立入口与 profile 文档。

checker 与模拟器实际判定的范围：
- 字面量、字段引用、纯关系调用、下一状态引用、逻辑比较和算术。
- 逻辑 Strong Kleene 三值求值，类型错误不降为 Unknown。
- `always` 状态不变量的当前观察检查，以及 `eventually` 的有限前缀观察。
- 确定性后置赋值 `x' == expression` 与帧校验。

已实现求值（2026-10-31 补齐）：
- **一阶量词**。域必须由宿主通过 `domains` 显式提供，Core 从不推断"所有 Order"是什么；缺域报 `UNBOUNDED_DOMAIN`，这是 ill-formed 而非 Unknown。空域按定义：`forall` 为真、`exists` 为假。域内元素逐个校验类型，任一元素为 Unknown 且无反例/正例时结果为 Unknown。
- **knowledge 的语义效力**。`open` 名求值为 Unknown（`Open parameter X has no value`）；`ambiguous` 名被引用时报 `AMBIGUOUS_REFERENCE`，Core 从不选一个候选；`assert`/`assume`/`disputed` 提供定义但仍是断言，`disputed` 只改变归因。知识项不能递归引用自己（`UNSUPPORTED_PROFILE`）。
- **偏好排序**（`src/preference.ts`）。只做单一数值目标 + `priority` 字典序。`priority` 越小越先比较，方向在比较时应用。目标为 Unknown 的候选不可比较：它排在可比较候选之后，且 `complete: false`——不声称它更差。
- **动作返回值**。`-> T` 的 `result` 在 `requires` 通过后必须由调用方显式提供（`MISSING_RESULT`），类型按 `T` 校验。`requires` 阶段禁止读 `result`（`UNSUPPORTED_PROFILE`）。
- **具名失败**。`requires` 不满足时，`declaredFailures` 列出动作声明的全部失败结果，模拟器**不选**其中一个——规约没说是"房间不可用"还是"支付被拒"。

仍未实现求值：
- **单位算术**。`24.hours`、`2.minutes` 进入 AST 后报 `UNSUPPORTED_PROFILE`。理由：没有一元化量纲模型时，把 `24.minutes` 当 `24` 比较会产出错误判定。`eventually within N.<unit>` 只记录界限，不参与任何判定（Core 没有时间推进）。
- **`reversibility` / `compensate` 的执行**。二者只是声明，模拟成功不产生任何补偿能力。
- **`retryable` 的重试语义**。`retryable` 作为声明透出，模拟器不实现重试，结果里没有尝试次数。
- **`verification` 的验证器调用**。`verify X by modelCheck("m")` 仍只是声明。

这些未实现的构造继续报 `UNSUPPORTED_EXPRESSION` / `UNSUPPORTED_PROFILE`，**不会静默当作已满足**。

### 一个语法陷阱

Core 的 `always` / `eventually` 只绑定紧随其后的 unary 表达式（见 EBNF 的 `temporalExpr`）。要包住整个比较必须加括号：

```text
always (phase == CLOSED);          // 正确：always 作用于比较
always phase == CLOSED;            // 实际解析为 (always phase) == CLOSED
```

临床 workflow 的约束全部加了括号。GIL-RL 层则相反，`always` 绑定整个比较级表达式——两层语义不同，不要跨层套用。

一个具体例子：`knowledge { assert open24: hotel.isOpen == true source "feed" as asserted; }` 解析后，`asserted` 只记录谁做了断言。它不使命题为真，也不进入约束求值。

状态模拟不是通用规划器或约束求解器。仅执行可写状态的 `x' == expression` 确定性后置赋值，右侧读取同一个前状态；其他后置形状明确拒绝。赋值后检查后置条件及状态不变量。执行前和候选状态均检查当前不变量；不能用后状态修复掩盖前状态违规。失败或未知不提交候选状态，不原地修改输入对象。initialize 只建立部分初始值，不认证不变量；实际检查需要动作输入。

Int 限定 JavaScript safe integer 范围；输入和运算越界报错。Decimal 采用 IEEE-754 Number，可能舍入，**不实现精确十进制**；本临床切片不做数值计算。数值 -0 与 0 在相等及规范化中视为同值。不得将本原型用于精确金额或临床数值计算。

`atomic` 仅表示模拟器将候选状态一次返回，不保证外部数据库事务或分布式原子性。

## 2. 版本、工件与哈希

以下版本不可混同：语言/profile、规约、本体、实现、验证器、领域政策与工件版本。

规范化 AST 包装包含 profile ID；对象键按确定性规则排序，数组顺序保留。源位置、空白、注释不参与摘要。使用 UTF-8 JSON 和 SHA-256，摘要格式为 `sha256:<64 位小写 hex>`。

语义相同但结构不同的表达式可能具有不同摘要。这是 AST 内容寻址，不是语义等价证明。列表不排序，名称不重写，字符串不做隐式 Unicode 归一化。本体导入名称绑定 `name@version`；运行工件仍须另外固定导入 AST 的内容哈希，不可把版本字符串当作密码学身份。

CLI 输出规约摘要和导入本体摘要；其组合可供未来工件模型使用，但本轮不实现签名、访问控制或安全存储。

## 3. 结果分类

- ParseError：语法或词法不合法。
- UnsupportedFeature：本 profile 不支持的构造。
- ReferenceError / LinkError：未绑定名称、本体版本或字段错误。
- TypeError：已知输入或表达式类型不符合声明。
- Unknown：当前信息不足，带原因；不是 false。
- PreconditionFailed / ConstraintViolation：已知条件为 false。
- UnsupportedPostcondition / FrameViolation：模拟器无法安全执行后置条件或越写集。

实现诊断代码由源码定义，CLI 保留 code 和 message。返回非零退出码表示解析、检查或模拟未成功；不会伪装成业务批准。

`open`、`ambiguous`、`disputed` 现在可以被解析进 `knowledge` 章节，但它们**不改变求值**：未决项不会让相关表达式变 Unknown，也不会被自动选一个候选。缺失字段仍按原规则产生 Unknown，歧义不会被压成概率或 null。把 `open` 真正接入三值求值是后续工作，届时必须显式声明它影响哪些判定。

## 4. 三值逻辑

T=true，F=false，U=Unknown。

| a | b | a AND b | a OR b | a => b |
|---|---|---|---|---|
| T | T | T | T | T |
| T | F | F | T | F |
| T | U | U | T | U |
| F | T | F | T | T |
| F | F | F | F | T |
| F | U | F | U | T |
| U | T | U | T | T |
| U | F | F | U | U |
| U | U | U | U | U |

NOT T=F，NOT F=T，NOT U=U。与未知值比较得到 Unknown，不进行宿主语言的真假强制转换。false AND Unknown 可确定为 false，但不能因此绕过静态类型检查。

## 5. 时间和安全解释

当前观察满足不变量不证明所有将来轨迹满足 `always`。目标尚未实现的开放有限前缀，不构成 `eventually` 的失败证明。监控输出必须区分当前条件和全轨迹结论。

`eventually within 2.minutes` 现在可以被解析，界限会进入 AST；但**它只是声明的时间量，不携带真实时钟**。Core 没有时间推进语义，因此该界限不参与任何判定。

临床 closeFinding 的 Core 模拟成功只意味着动作契约成立。它不检查 CTM 身份、Grant、Approval 或实际 Attestation；也不能改变真实发现状态。合成夹具中的有效性 Bool 是测试输入，不是可信认证接口。真实外层适配器必须按照场景规约建立这些事实，不能让调用者自行勾选后执行。

## 6. 阶段验收

- 两个临床 GIL 独立解析、链接和静态检查。
- 构造类型、knowledge、output、verification、量词、单位、prefer、返回值与补偿均能解析并进入 AST；未实现求值的构造必须报 `UNSUPPORTED_EXPRESSION` 或 `UNSUPPORTED_PROFILE`。
- 量词、knowledge 效力、偏好排序与动作返回值有正反测试：空域定义、缺域报错、open 为 Unknown、ambiguous 拒绝、Unknown 候选不可比较、requires 失败不选失败原因。
- `examples/酒店预订.gil` 整体可解析为 spec + interpretation + delegate 三项；`examples/机器人导航.gil` 可解析为 environment。
- 单文档入口 `parse` 仍拒绝多文档文件，只有 `parseBundle` 接受。
- 规范化及哈希对空白注释稳定，对 AST 内容变化敏感。
- 名称、类型、写集、prime 作用域与不支持构造有负例。
- 强三值真值表、类型错、未知前置条件、失败不提交有测试。
- 合成 Core 路径从 OPEN 到 CLOSED；版本不匹配和失效路径阻断或回退。
- CLI 可输出 AST、诊断和明确带 Core-only 标记的模拟结果。

A01–A30 是后续外层阶段的验收契约，不以本轮 Core 单测代替。
