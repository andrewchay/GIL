import type { Expr, Import, Provenance } from './ast.ts';
export interface SourceArtifact { id: string; version: string; hash: string; text: string }
export type InterpretationItem =
  | { kind: 'ground'; source: { artifactId: string; start: number; end: number }; target: Expr }
  | { kind: 'open'; name: string; type: string }
  | { kind: 'ambiguous'; name: string; candidates: string[][] }
  /** 显式假设：它携带来源标签，但不进入待澄清问题队列。 */
  | { kind: 'assume'; name: string; expr: Expr; provenance?: Provenance };
export interface Interpretation { kind: 'interpretation'; name: string; sourceText: string; imports: Import[]; items: InterpretationItem[] }
export interface GroundingContext {
  sources: SourceArtifact[];
  // Explicit candidate catalog: strings refer to domain objects, not authorization.
  references: string[];
  types: string[];
}
export interface UnresolvedItem { name: string; kind: 'open' | 'ambiguous'; type?: string; candidates?: string[]; affects: string[] }
export interface Question { id: string; target: string; kind: 'open' | 'ambiguous'; type?: string; options: string[]; affects: string[] }
export interface Candidate { id: string; interpretation: Interpretation; plan: Record<string, unknown>; affects: Record<string, string[]> }
export interface ActorContext { actorId: string; kind: 'human' | 'agent'; mayAnswer: boolean; mayAccept: boolean }
export interface ExchangeEvent { id: string; type: 'Propose' | 'Clarify' | 'Answer' | 'Accept'; actorId: string; parents: string[]; payload: Record<string, unknown> }
export interface Session {
  source: SourceArtifact;
  candidate: Candidate;
  interpretationHash: string;
  planHash: string;
  questions: Question[];
  answers: Record<string, string>;
  events: ExchangeEvent[];
  accepted?: { interpretationHash: string; planHash: string; resolvedHash: string; eventId: string };
}
