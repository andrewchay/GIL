/**
 * 决策日志演示：同一合同与快照重跑两次，记录判定并计算自洽性。
 *
 * 全部为合成夹具。这个演示只证明 L1（同一输入是否得同一结论），
 * 不证明判对了——后者需要事后回填 ground truth 才开始。
 */
import { DecisionLog, fileSink, memorySink, summarize, fieldsFromReport } from './decision-log.ts';
import type { LogSink } from './decision-log.ts';
import { agentDemo } from './agent-demo.ts';

export interface DemoOptions {
  /** 提供路径则写入 JSONL；缺省用内存 sink，不产生文件。 */
  path?: string;
  /** 演示用的固定判定时间，避免时钟进入输出。 */
  decidedAt?: string;
}

export async function decisionLogDemo(options: DemoOptions = {}) {
  const decidedAt = options.decidedAt ?? '2026-11-03T08:00:00Z';
  const sink: LogSink = options.path ? fileSink(options.path) : memorySink();
  const log = new DecisionLog(sink);
  const runs: { run: number; domains: string[] }[] = [];

  // 两次独立运行：若实现是确定性的，同 (合同, 快照) 必得同一判定。
  for (let run = 1; run <= 2; run++) {
    const result = await agentDemo();
    const domains: string[] = [];
    for (const scenario of result.scenarios) {
      log.appendDecision(fieldsFromReport(scenario.view.report, scenario.view.draft.claim.kind, decidedAt,
        { contractHash: scenario.view.contractHash, snapshotHash: scenario.view.snapshotHash },
        scenario.execution.status));
      domains.push(scenario.domain);
    }
    runs.push({ run, domains });
  }

  const records = log.records();
  const summary = summarize(records);
  // 回填一条合成 ground truth，演示 append-only 的纠错路径。
  const first = records.find(r => r.kind === 'decision')!;
  log.appendGroundTruth({ decisionId: first.id, recordedAt: '2026-11-04T08:00:00Z',
    value: 'True', source: 'expert-consensus', auditor: 'synthetic-panel', note: 'synthetic fixture only' });
  const withBackfill = summarize(log.records());

  return {
    ok: summary.repeat.examined > 0 && summary.repeat.rate === 0,
    mode: 'synthetic-decision-log-simulation',
    productionAudit: false,
    warning: 'SYNTHETIC ONLY: fixture decisions and a synthetic backfill; no ground truth, no real audit, no production persistence',
    storage: options.path ? 'jsonl-file' : 'memory',
    runs,
    summary,
    afterBackfill: { covered: withBackfill.groundTruth.covered, coveredShare: withBackfill.groundTruth.coveredShare,
      bySource: withBackfill.groundTruth.bySource },
    boundaries: [
      'L1 repeat value only checks determinism, never correctness',
      'ground truth is appended as a separate event and never rewrites the verdict',
      'content hash proves the record was not edited, not that it was right when written',
      'no signature, cross-process transaction or durable audit store',
    ],
  };
}
