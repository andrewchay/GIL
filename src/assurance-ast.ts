// Phase4 共享接口。所有字段均为合成、过程内数据；不是真实凭证或签名。
export type AttestationResult = 'Pass' | 'Fail' | 'Unknown';
export interface MaterialRef { id: string; contentHash: string }
export interface RequirementSnapshot {
  kind: 'requirement'; version: string; contentHash: string;
  studyId: string; siteId: string; findingId: string; staffId: string;
  protocolVersion: string; materials: MaterialRef[];
}
export interface EvidenceSnapshot {
  kind: 'evidence'; version: string;
  studyId: string; siteId: string; findingId: string; staffId: string;
  protocolVersion: string; requirementHash: string;
  materials: MaterialRef[];
  // 来源与检查结论分离：submitterClaims 只是提交方断言，绝不进入可信检查输入。
  submitterClaims?: { authenticityEstablished?: boolean; complete?: boolean };
}
export interface Attestation {
  kind: 'attestation'; version: string; id: string; result: AttestationResult;
  verifierId: string; method: 'HumanReview' | 'DocumentCheck'; methodVersion: string;
  specHash: string; targetHash: string; contextHash: string;
  coverage: string[]; assumptions: string[];
  issuedAt: number; validUntil: number;
}
export interface Challenge {
  kind: 'challenge'; id: string; version: string;
  targetAttestationId: string; targetHash: string;
  reason: string; raisedBy: string; at: number;
}
export interface ReviewInput {
  evidenceHash: string;
  attestationId: string;
  requirementHash: string;
  specHash: string;
}
export interface AssuranceEvaluation {
  result: AttestationResult;
  active: boolean;
  reasons: string[];
}
