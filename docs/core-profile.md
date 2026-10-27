# Phase 0/1：临床 Core 原型 Profile

版本：`gil-core-clinical-0.1`。状态：实验性实现契约。
本 profile 细化现有设计草案，不冻结完整 GIL，也不宣称全面符合 Core EBNF。

## 1. 边界与能力

使用 TypeScript 源码及 Node.js >=24 原生类型擦除执行。无第三方运行依赖。Node 运行不等于 TypeScript 编译器类型检查；本项目的 `check` 是 GIL 类型检查，不是 tsc。

支持单文件一个 ontology 或 spec：
- 本体概念、identity、字段、带函数体的纯关系。
- 精确本体版本导入及别名；Text、Bool、Int、Decimal、导入概念类型。
- context、input、state；achieve、require；action 参数、requires、ensures、writes、atomic。
- 字面量、字段引用、纯关系调用、下一状态引用、逻辑比较和算术。
- 逻辑 Strong Kleene 三值求值，类型错误不降为 Unknown。
- `always` 状态不变量的当前观察检查，以及 `eventually` 的有限前缀观察。

暂不支持：lexicon/interpretation、knowledge、output、泛型、精化类型、量词、集合、单位、概率、bounded temporal、偏好、返回值与补偿、外层事件语言。遇到未支持语法明确报错；不静默忽略。

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

`open` 和 `ambiguous` 在完整规范中属于未决状态；本 profile 不解析它们。缺失字段产生 Unknown，不自动推断为显式 open，也不把歧义压成概率或 null。

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

当前观察满足不变量不证明所有将来轨迹满足 `always`。目标尚未实现的开放有限前缀，不构成 `eventually` 的失败证明。监控输出必须区分当前条件和全轨迹结论；本轮不实现时间界限或完整历史模型。

临床 closeFinding 的 Core 模拟成功只意味着动作契约成立。它不检查 CTM 身份、Grant、Approval 或实际 Attestation；也不能改变真实发现状态。合成夹具中的有效性 Bool 是测试输入，不是可信认证接口。真实外层适配器必须按照场景规约建立这些事实，不能让调用者自行勾选后执行。

## 6. 阶段验收

- 两个临床 GIL 独立解析、链接和静态检查。
- 规范化及哈希对空白注释稳定，对 AST 内容变化敏感。
- 名称、类型、写集、prime 作用域与不支持构造有负例。
- 强三值真值表、类型错、未知前置条件、失败不提交有测试。
- 合成 Core 路径从 OPEN 到 CLOSED；版本不匹配和失效路径阻断或回退。
- CLI 可输出 AST、诊断和明确带 Core-only 标记的模拟结果。

A01–A30 是后续外层阶段的验收契约，不以本轮 Core 单测代替。
