/**
 * GIL-Core v0.1 AST。
 *
 * 设计约束：
 * - 表达式节点只为规范里明确定义过的构造保留位置；未实现的能力在求值时报
 *   `UNSUPPORTED_PROFILE`，而不是猜一个语义。
 * - `Binding.type` 始终是规范文本形式，供 checker 做扁平比较；`typeExpr`
 *   保留构造结构（`Entity<H.Customer>`、`Set<Order>`），缺省时两者一致。
 */

/** 类型表达式：`Booking`、`Entity<H.Customer>`、`Set<T>`、`Option<T>`、`A | B`、`T?`。 */
export type TypeExpr =
  | { kind: 'name'; path: string[] }
  /** 构造类型。`Entity`/`Option` 由 Core 定义；其余视为导入的类型构造器。 */
  | { kind: 'apply'; name: string[]; args: TypeExpr[] }
  | { kind: 'optional'; arg: TypeExpr }
  | { kind: 'union'; options: TypeExpr[] }
  /** 记录与细化的初步形式：`{ name: T | 判定 }`。 */
  | { kind: 'record'; fields: Binding[]; guard?: Expr };

export type ProvenanceLabel = 'asserted' | 'assumed' | 'inferred' | 'disputed';

/** 来源声明。`as` 是知识标签，不是真值判定。 */
export interface Provenance { expr: Expr; label?: ProvenanceLabel }

export type Expr =
  | { kind: 'literal'; value: string | boolean | number }
  | { kind: 'ref'; path: string[]; next?: boolean }
  | { kind: 'call'; path: string[]; args: Expr[] }
  | { kind: 'unary'; op: string; arg: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  /** GIL-RL 时间界限：`within 100.steps`。Core 不产生此节点。 */
  | { kind: 'bounded'; value: number; unit: string; arg: Expr }
  /** 一阶量词：`forall x: T. e`、`exists b: H.Booking. e`。 */
  | { kind: 'quantifier'; quantifier: 'forall' | 'exists'; bindings: Binding[]; body: Expr }
  /** 带单位的量：`24.hours`、`300.USD`。单位是声明量，不是真实时钟读数。 */
  | { kind: 'quantity'; value: number; unit: string };

export interface Binding {
  name: string;
  /** 规范文本形式，例如 `Entity<H.Customer>`。 */
  type: string;
  value?: Expr;
  /** 仅在构造/复合类型时保留结构；简单名字可由 `type` 完全重建。 */
  typeExpr?: TypeExpr;
  provenance?: Provenance;
}
export interface Concept { name: string; fields: Binding[]; identity: string }
export interface Relation { name: string; params: Binding[]; type: string; body: Expr }
export interface Ontology { kind: 'ontology'; name: string; version: string; concepts: Concept[]; relations: Relation[] }

/** 词法表条目：短语到候选含义。候选是引用，不是授权。 */
export interface LexiconEntry { phrase: string; candidates: string[][] }
export interface Lexicon { kind: 'lexicon'; name: string; version: string; ontology: string; entries: LexiconEntry[] }

/** `layer` 缺省即 ontology；只有 lexicon 导入才显式标注，以保持既有 canonical 摘要不变。 */
export interface Import { name: string; alias: string; layer?: 'lexicon' }

export interface Claim { name: string; expr: Expr; provenance?: Provenance }

export type GoalKind = 'achieve' | 'prefer';
/** `kind` 缺省即 achieve；只有 prefer 才显式标注方向与优先级。 */
export interface Goal extends Claim {
  kind?: 'prefer';
  direction?: 'minimize' | 'maximize';
  priority?: number;
}

/** 知识状态：断言、假设、未决、歧义、争议、可操作化。 */
export type KnowledgeItem =
  | { kind: 'open'; name: string; type: string; typeExpr?: TypeExpr }
  | { kind: 'claim'; modality: 'assert' | 'assume' | 'disputed'; name: string; expr: Expr; provenance?: Provenance }
  | { kind: 'ambiguous'; name: string; candidates: string[][] }
  | { kind: 'operationalize'; text: string; expr: Expr };

export type Reversibility = 'reversible' | 'compensable' | 'irreversible';

export interface Action {
  name: string;
  params: Binding[];
  /** `-> T`：动作产出的决策变量类型。 */
  returns?: string;
  requires: Expr[];
  ensures: Expr[];
  writes: string[];
  atomic: boolean;
  preserves?: Expr[];
  /** 有限随机转移。Core 表达式中不产生此字段。 */
  outcomes?: { probability: number; ensures: Expr }[];
  /** 具名失败结果。它们是显式结果，不是异常。 */
  failures?: string[];
  retryable?: boolean;
  reversibility?: Reversibility;
  compensate?: Expr;
}

export interface Verifier { name: string[]; args: Expr[] }
export interface Verification { target: string[][]; verifier: Verifier; under: string[][] }

export interface Spec {
  kind: 'spec';
  name: string;
  version: string;
  imports: Import[];
  context: Binding[];
  input: Binding[];
  output: Binding[];
  state: Binding[];
  knowledge: KnowledgeItem[];
  goals: Goal[];
  constraints: Claim[];
  actions: Action[];
  verification: Verification[];
}

import type { Environment } from './rl-ast.ts';
export type Document = Ontology | Lexicon | Spec | Environment;

export interface Diagnostic { code: string; message: string }
export class GilError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export interface Linked { spec: Spec; ontologies: Record<string, Ontology> }

/** 把一个类型表达式渲染为规范文本。checker 用它做扁平比较。 */
export function renderType(type: TypeExpr): string {
  switch (type.kind) {
    case 'name': return type.path.join('.');
    case 'apply': return `${type.name.join('.')}<${type.args.map(renderType).join(', ')}>`;
    case 'optional': return `${renderType(type.arg)}?`;
    case 'union': return type.options.map(renderType).join(' | ');
    case 'record': return `{ ${type.fields.map(f => `${f.name}: ${f.type}`).join(' | ')} }`;
  }
}
