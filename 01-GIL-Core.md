# GIL-Core：类型、本体、接地、目标、约束、动作与形式语义

**版本：** v0.1 设计草案  
**规范级别：**核心语义草案

## 1. 范围

GIL-Core 定义在给定本体、上下文和已解析参数下，哪些状态、动作与执行轨迹是可接受的。

Core 不负责：

- 谁提出或接受规约；
- 谁被授权执行动作；
- 长期记忆如何保存；
- 哪个实现已经通过验证；
- 法律责任如何分配。

这些分别由 Exchange、Workspace、Delegation 和 Assurance 处理。

## 2. 规约结构

一份 Core 规约可以包含：

```text
spec <qualified-name> version "<version>" {
  use ontology ...;
  use lexicon ...;

  context { ... }
  input { ... }
  output { ... }
  state { ... }
  knowledge { ... }
  goals { ... }
  constraints { ... }
  action { ... }
  verification { ... }
}
```

`verification` 仅声明验证计划。实际通过与否必须由 Assurance 的独立凭证表示。

## 3. 类型系统

### 3.1 基础类型

```text
Unit
Bool
Int
Decimal
Text
Instant
Duration
Date
TimeZone
```

### 3.2 构造类型

```text
Record { field: Type, ... }
Union<T1, T2, ...>
Set<T>
List<T>
Map<K, V>
Option<T>
Entity<T>
Ref<T>
Quantity<Unit>
Distribution<T>
```

`Option<T>` 表示值可以不存在，不表示未知或歧义。`Distribution<T>` 用于显式概率模型，不用于表示解释歧义。

### 3.3 精化类型

```text
type Percentage = {
  value: Decimal | 0 <= value && value <= 100
};

type PositiveInt = {
  n: Int | n > 0
};
```

精化谓词必须无副作用。实现可以拒绝无法有效检查的精化类型，但不得悄悄忽略其谓词。

### 3.4 类型规则

1. 不进行隐式单位换算。
2. 不进行隐式实体类型转换。
3. 不把 `Option`、未知、缺失和歧义合并为一个 `null`。
4. 表达式不得写入状态、调用未声明动作或产生外部效果。
5. 量词和高阶外部函数可能使检查不可判定；Core 不承诺普遍可判定性。
6. 具体实现必须声明自己支持的类型与表达式子集。

## 4. 本体

### 4.1 本体内容

本体定义语言无关的概念、关系、身份和内部约束：

```text
ontology "hotel/core" version "3" {
  concept Booking {
    identity bookingId: BookingId;
    room: Room;
    stay: Interval;
    status: BookingStatus;
  }

  relation overlaps(a: Interval, b: Interval): Bool;

  constraint validStay:
    forall b: Booking. nonempty(b.stay);
}
```

### 4.2 本体规则

- 概念引用必须包含命名空间；跨工件引用必须绑定版本。
- 实体身份不得仅由显示名称决定。
- 两个概念同名不意味着相同。
- `sameAs` 不得默认传递，也不得仅凭文本相似度建立。
- 跨本体映射必须显式记录方向、条件和来源。
- 本体映射可以是精确、较窄、较宽或仅相关；后三者不得当作等价替换。

## 5. 词典、接地与解释

### 5.1 词典

词典把特定语言和领域中的表达映射到候选概念：

```text
lexicon "hotel/english" version "2" for "hotel/core@3" {
  phrase "booking" => candidate Booking;
  phrase "reservation" => candidate Booking;
  phrase "change" => candidates ChangeCheckIn, ChangeCheckOut, ChangeRoom;
}
```

词典是多对多映射，不是全局一词一义表。

### 5.2 接地

接地连接来源位置与形式对象：

```text
ground sourceSpan("U42", 2, 2) -> H.Booking;
ground sourceSpan("U42", 1, 1) -> session.user;
```

每个接地必须保留：

- 来源工件或输入；
- 来源定位；
- 目标概念、实体或表达式；
- 提出者；
- 知识状态；
- 所属解释候选。

Core 使用抽象 `SourceRef`。具体文本、图像、图节点或模拟状态定位由 Workspace 定义。

### 5.3 候选解释

自然语言编译的规范结果是解释集合，而不是强制唯一 AST：

```text
Interpretation {
  source: SourceRef
  candidateAST: CanonicalAST
  groundings: Set<Grounding>
  assumptions: Set<Assumption>
  unresolved: Set<UnresolvedItem>
}
```

类型检查可以排除不合法候选，但模型概率不得被当作用户接受。

## 6. 知识与未决状态

| 构造 | 规范含义 |
|---|---|
| `assert` | 某主体明确断言一个命题 |
| `assume` | 在显式假设下求值 |
| `open` | 已知缺少一个参数或值 |
| `ambiguous` | 多个候选解释仍然存在 |
| `disputed` | 某断言受到明确争议 |
| `operationalize` | 为模糊表达指定显式可操作定义 |

知识状态与真值必须分开。`asserted` 不意味着真实，`inferred` 不意味着已接受，`verified` 不属于 Core 的知识标签。

示例：

```text
knowledge {
  open cancellationPolicy: CancellationPolicy;

  ambiguous changeMeaning {
    candidates ChangeCheckIn, ChangeCheckOut;
  }

  assume hotelIsOpen:
    hotel.status == OPEN
    source "availability-feed" as inferred;
}
```

未解决的开放项产生由参数索引的语义族，不授权执行者任意选择一个值。

## 7. 表达式与求值

### 7.1 表达式能力

Core 表达式支持：

- 布尔逻辑与一阶量化；
- 算术、记录、集合和实体引用；
- 时间、区间与单位；
- `always`、`eventually`、`within`、`after`；
- 动作后置条件中的下一状态变量 `x'`；
- `entered`、`changed` 等事件谓词。

### 7.2 三值求值

部分上下文中的逻辑结果为：

```text
True | False | Unknown
```

规则：

1. 类型错误、无效引用和不可解析语法属于 ill-formed，不是 `Unknown`。
2. 硬约束为 `False` 表示违规。
3. 硬约束为 `Unknown` 表示尚未建立，不能当作满足。
4. `not Unknown == Unknown`；其他连接词采用明确记录的三值真值表。
5. 歧义不是第四种真值，而是存在多个候选 AST。

## 8. 状态与动作

### 8.1 状态

```text
output {
  chosen: Booking;
}

state {
  bookings: Set<Booking>;
}
```

`input` 声明外部输入，`output` 声明由实现选择或产生的决策变量，`state` 声明可持续观察或受控的环境状态。目标与偏好应引用决策变量，而不是直接对可空状态作字段访问。

状态声明只描述规约范围内的可观察或受控状态，不声称完整表示真实世界。

### 8.2 动作契约

```text
action confirm(request: BookingRequest) -> Booking
  requires available(request.room, request.stay)
  ensures result.room == request.room
  ensures result.status == CONFIRMED
  writes bookings, chosen
  preserves everythingExcept(bookings, chosen)
  outcomes {
    0.95 -> result.status' == CONFIRMED;
    0.05 -> result.status' == PENDING;
  }
  failure RoomUnavailable, PaymentRejected
  retryable false
  reversibility compensable
  compensate cancel(result);
```

动作契约包括：

- 参数与返回类型；
- 前置条件；
- 后置条件；
- 可写状态与帧条件；
- 可选随机结果；
- 失败与重试语义；
- 可逆、可补偿或不可逆属性。

`requires` 是动作本身的环境与语义条件，不是授权。授权必须由 Delegation 另行计算。

### 8.3 帧规则

- 默认只有 `writes` 中列出的规约内状态可以变化。
- `preserves everythingExcept(...)` 是显式帧条件的语法糖。
- 规约范围之外的效果必须通过外部效果接口声明，不能利用帧条件隐藏。
- 可补偿不等于可逆；补偿不得被表述为完整恢复。

## 9. 目标、约束与偏好

```text
goals {
  achieve booked:
    eventually within 2.minutes chosen.status == CONFIRMED;

  prefer cost:
    minimize chosen.totalPrice priority 1;
}

constraints {
  require noDoubleBooking:
    always forall b1 b2: Booking.
      b1.room == b2.room &&
      overlaps(b1.stay, b2.stay) &&
      active(b1) && active(b2)
      => b1 == b2;
}
```

- `achieve` 定义可接受轨迹必须实现的结果。
- `require` 定义可接受轨迹不得违反的条件。
- `prefer` 只在可接受轨迹之间排序。

偏好不得扩大可接受轨迹集合。优先级采用字典序，数字越小优先级越高。跨模块偏好不得在没有显式规则时自动排序。

## 10. 形式语义

设：

- `C`：本体、上下文和接地环境；
- `θ`：已解析的开放参数；
- `S`：一份 GIL 规约；
- `π`：由状态、事件和动作组成的执行轨迹。

则：

```text
⟦S⟧(C, θ) = {
  π ∈ Traces(S) |
  π 满足所有必需目标，
  π 满足所有硬约束，
  π 满足所有动作契约
}
```

形式化写法：

\[
\llbracket S \rrbracket_{C,\theta}
=
\left\{
\pi\in\operatorname{Traces}(S)
\;\middle|\;
\pi\models G_{\mathrm{required}},
\pi\models C_{\mathrm{hard}},
\pi\models A_{\mathrm{contracts}}
\right\}.
\]

实现 `I` 精化规约 `S`，当且仅当其每一条可观察轨迹都被规约允许：

\[
I \sqsubseteq S
\iff
\operatorname{Traces}(I)
\subseteq
\llbracket S \rrbracket_{C,\theta}.
\]

这里的可观察轨迹必须明确观察投影；隐藏内部状态不影响精化判断，但声明为可观察的效果不得隐藏。

## 11. 组合规则

1. 导入模块的硬约束按合取组合。
2. 导入不得静默削弱已有约束。
3. 名称必须命名空间化，状态冲突必须显式处理。
4. 假设保持作用域和来源，不得自动升级为全局事实。
5. 冲突目标必须产生未决项或 ill-formed 报告。
6. 偏好合并必须具有显式优先级。
7. 组合后无法判定的语义关系返回 `Unknown`。

## 12. 验证与静态检查

Core 实现至少应检查：

- 语法与类型；
- 本体、版本和实体引用；
- 单位与维度；
- 量词变量作用域；
- 动作写入与帧条件；
- 开放项和歧义依赖；
- 目标、约束和偏好之间的显式冲突；
- 规范化 AST 的内容哈希。

静态检查通过不意味着规约完整、符合真实人类意图或实现正确。

## 13. 与外层的关系

- Exchange 可以引用和修订 Core AST，但不能改变 Core 的求值规则。
- Workspace 可以提供上下文、工件和来源定位，但不能把工件存在当作命题为真。
- Delegation 可以进一步限制可执行动作，但不能放宽 Core 动作契约。
- Assurance 可以提供关于 Core 声明的证据，但证据不反向改变命题真值。

强化学习所需的观察、信念、初始分布、环境动力学、终止和奖励由 GIL-RL 扩展定义。


## v0.2 候选修订关联

Core 可选profile补充测量合同、主张类别与带原因的求值报告；不改变三值真值表或引入业务决策枚举。

参见[候选语义合同](docs/gil-v0.2-semantic-contract.md)与[双场景验收](docs/gil-v0.2-dual-scenario-acceptance.md)。这些扩展尚未冻结或实现，不改变本文v0.1原型的符合性声明。
