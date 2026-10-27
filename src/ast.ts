export type Expr =
  | { kind: 'literal'; value: string | boolean | number }
  | { kind: 'ref'; path: string[]; next?: boolean }
  | { kind: 'call'; path: string[]; args: Expr[] }
  | { kind: 'unary'; op: string; arg: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  /** GIL-RL 时间界限：`within 100.steps`。Core 不产生此节点。 */
  | { kind: 'bounded'; value: number; unit: string; arg: Expr };
export interface Binding { name: string; type: string; value?: Expr }
export interface Concept { name: string; fields: Binding[]; identity: string }
export interface Relation { name: string; params: Binding[]; type: string; body: Expr }
export interface Ontology { kind: 'ontology'; name: string; version: string; concepts: Concept[]; relations: Relation[] }
export interface Import { name: string; alias: string }
export interface Claim { name: string; expr: Expr }
export interface Action { name: string; params: Binding[]; requires: Expr[]; ensures: Expr[]; writes: string[]; atomic: boolean }
export interface Spec { kind: 'spec'; name: string; version: string; imports: Import[]; context: Binding[]; input: Binding[]; state: Binding[]; goals: Claim[]; constraints: Claim[]; actions: Action[] }
import type { Environment } from './rl-ast.ts';
export type Document = Ontology | Spec | Environment;
export interface Diagnostic { code: string; message: string }
export class GilError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
export interface Linked { spec: Spec; ontologies: Record<string, Ontology> }
