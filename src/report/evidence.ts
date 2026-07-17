import { deterministicPrAnalysisSchema, type DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import type { ReportConfidence, ReportEvidence } from "./report-types.js";

export function buildReportEvidence(analysisInput: DeterministicPrAnalysis): ReportEvidence {
  const analysis = deterministicPrAnalysisSchema.parse(analysisInput);
  const confidence = calculateConfidence(analysis);
  if (analysis.status === "ready" && analysis.affectedItems.some((item) => item.dependencyPath.length === 0)) {
    throw new Error("ready PR analysis contains an affected item without dependency evidence");
  }
  return {
    version: 1,
    repoId: analysis.repoId,
    pullRequestNumber: analysis.pullRequestNumber,
    baseSha: analysis.baseSha,
    headSha: analysis.headSha,
    analysisStatus: analysis.status,
    impactLevel: analysis.impactLevel,
    confidence,
    insufficientReason: analysis.insufficientReason,
    unresolvedImportCount: analysis.unresolvedImportCount,
    changedSymbols: analysis.changedSymbols.map((symbol) => ({
      id: `symbol:${symbol.symbolKey}`,
      name: symbol.name,
      changeKind: symbol.changeKind,
      filePath: symbol.filePath,
    })).sort((left, right) => left.id.localeCompare(right.id)),
    affectedItems: analysis.affectedItems.map((item) => ({
      id: `affected:${item.path}`,
      path: item.path,
      kind: item.kind,
      impact: item.impact,
      dependencyPath: item.dependencyPath,
    })).sort((left, right) => left.kind.localeCompare(right.kind) || left.path.localeCompare(right.path)),
  };
}

export function calculateConfidence(analysis: DeterministicPrAnalysis): ReportConfidence {
  if (analysis.status === "insufficient_evidence") return "insufficient";
  if (analysis.affectedItems.some((item) => item.dependencyPath.length === 0)) return "low";
  if (analysis.unresolvedImportCount === 0) return "high";
  if (analysis.unresolvedImportCount <= 3) return "medium";
  return "low";
}
