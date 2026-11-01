import { GilError } from './ast.ts';
import { hashValue } from './interpretation.ts';

export type Truth = 'True' | 'False' | 'Unknown';
export type ObservationState = 'Observed' | 'ConfirmedAbsent' | 'NotObserved' | 'UnableToDetermine';
export type ClaimKind = 'Descriptive' | 'Associational' | 'Causal' | 'Predictive' | 'Normative';
export type UncertaintyKind = 'None' | 'ScenarioEnvelope' | 'ConfidenceInterval';
export type UncertaintyMethod = 'None' | 'Envelope' | 'Statistical';
export interface SnapshotObservation {
  readonly readability: 'Available' | 'Unavailable' | 'Partial';
  readonly completeness: 'Complete' | 'Partial' | 'Unknown';
  readonly searched: boolean;
  readonly matches: number;
  readonly mappingValid: boolean;
  readonly applicable: boolean;
  readonly windowMature: boolean;
  readonly scopeCovered: boolean;
  readonly watermarkCovered: boolean;
  readonly closureBasis: string | null;
}
export interface Snapshot {
  readonly facts: Readonly<Record<string, boolean | number | string>>;
  readonly conflicts: readonly string[];
  readonly observation: SnapshotObservation;
  readonly lineageRoots: readonly string[];
}
export interface Claim {
  readonly kind: ClaimKind;
  readonly fact: string;
  readonly causalDesign: string | null;
  readonly uncertainty: UncertaintyKind;
  readonly uncertaintyMethod: UncertaintyMethod;
  readonly requiresIndependentSources: boolean;
}
export interface EvaluationReport {
  readonly truth: Truth;
  readonly observation: ObservationState;
  readonly issues: readonly string[];
  readonly reviewRequired: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const shape = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(item => typeof item === 'string');
const nullableString = (value: unknown): boolean => value === null || typeof value === 'string';
const member = (value: unknown, choices: readonly string[]): boolean =>
  typeof value === 'string' && choices.includes(value);
const fail = (code: string, message: string): never => { throw new GilError(code, message); };

/** Reject proxies/getters before property reads or cloning. Never freeze caller-owned input. */
function copy(value: unknown): unknown {
  hashValue(value);
  return structuredClone(value);
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Return a detached, deeply frozen snapshot, or throw GilError for invalid input. */
export function validateSnapshot(value: unknown): Snapshot {
  const clean = copy(value);
  if (!record(clean) || !shape(clean, ['facts', 'conflicts', 'observation', 'lineageRoots']) ||
      !record(clean.facts) || !Object.values(clean.facts).every(item =>
        typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number') ||
      !strings(clean.conflicts) || !strings(clean.lineageRoots) || !record(clean.observation)) {
    return fail('INVALID_SNAPSHOT', 'Expected exact snapshot structure and primitive facts');
  }
  const observation = clean.observation;
  if (!shape(observation, ['readability', 'completeness', 'searched', 'matches', 'mappingValid',
    'applicable', 'windowMature', 'scopeCovered', 'watermarkCovered', 'closureBasis']) ||
      !member(observation.readability, ['Available', 'Unavailable', 'Partial']) ||
      !member(observation.completeness, ['Complete', 'Partial', 'Unknown']) ||
      !['searched', 'mappingValid', 'applicable', 'windowMature', 'scopeCovered', 'watermarkCovered']
        .every(key => typeof observation[key] === 'boolean') ||
      typeof observation.matches !== 'number' || !Number.isSafeInteger(observation.matches) ||
      observation.matches < 0 || !nullableString(observation.closureBasis)) {
    return fail('INVALID_SNAPSHOT', 'Invalid observation; matches must be a non-negative safe integer');
  }
  return freeze(clean as unknown as Snapshot);
}

/** Validate structure only; supplied design/method labels are not scientific proof. */
export function validateClaim(value: unknown): Claim {
  const clean = copy(value);
  if (!record(clean) || !shape(clean, ['kind', 'fact', 'causalDesign', 'uncertainty',
    'uncertaintyMethod', 'requiresIndependentSources']) ||
      !member(clean.kind, ['Descriptive', 'Associational', 'Causal', 'Predictive', 'Normative']) ||
      typeof clean.fact !== 'string' || !clean.fact.trim() || !nullableString(clean.causalDesign) ||
      !member(clean.uncertainty, ['None', 'ScenarioEnvelope', 'ConfidenceInterval']) ||
      !member(clean.uncertaintyMethod, ['None', 'Envelope', 'Statistical']) ||
      typeof clean.requiresIndependentSources !== 'boolean') {
    return fail('INVALID_CLAIM', 'Expected exact claim structure with valid kind and uncertainty labels');
  }
  return freeze(clean as unknown as Claim);
}

/** Pure structural evaluation. No authorization, causal identification or real independence is proved. */
export function evaluateSnapshot(snapshotValue: unknown, claimValue: unknown): EvaluationReport {
  const snapshot = validateSnapshot(snapshotValue), claim = validateClaim(claimValue);
  const issues: string[] = [];
  const conflict = snapshot.conflicts.includes(claim.fact) || snapshot.conflicts.includes('recordAbsent');
  if (conflict) issues.push('INPUT_CONFLICT');
  if (claim.kind === 'Causal' && !claim.causalDesign?.trim()) issues.push('IDENTIFICATION_REQUIRED');
  if (claim.uncertainty === 'ConfidenceInterval' && claim.uncertaintyMethod === 'Envelope') {
    issues.push('UNCERTAINTY_KIND_MISMATCH');
  }
  if (claim.requiresIndependentSources && new Set(snapshot.lineageRoots).size < 2) issues.push('SHARED_SOURCE_ROOT');

  const metadata = snapshot.observation;
  let observation: ObservationState;
  if (metadata.readability === 'Unavailable' || !metadata.searched || !metadata.mappingValid ||
      !metadata.applicable || conflict) {
    observation = 'UnableToDetermine';
  } else if (metadata.matches > 0) {
    observation = 'Observed';
  } else if (metadata.readability === 'Available' && metadata.completeness === 'Complete' &&
      metadata.windowMature && metadata.scopeCovered && metadata.watermarkCovered && metadata.closureBasis?.trim()) {
    observation = 'ConfirmedAbsent';
  } else {
    observation = 'NotObserved';
  }

  let truth: Truth = 'Unknown';
  if (claim.fact === 'recordAbsent') {
    if (observation === 'ConfirmedAbsent') truth = 'True';
    else if (observation === 'Observed') truth = 'False';
  } else {
    if (Object.hasOwn(snapshot.facts, claim.fact)) {
      const fact = snapshot.facts[claim.fact];
      if (typeof fact !== 'boolean') return fail('TYPE_ERROR', `Fact ${claim.fact} must be Bool`);
      if (!conflict) truth = fact ? 'True' : 'False';
    }
  }
  return freeze({ truth, observation, issues, reviewRequired: issues.length > 0 });
}
