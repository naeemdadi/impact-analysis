import { deterministicPrAnalysisSchema, type DeterministicPrAnalysis } from "../impact/pr-impact-types.js";
import type { ImpactAssessment } from "../impact/impact-assessment.js";
import type { ReportEvidence } from "./report-types.js";

export function buildReportEvidence(analysisInput: DeterministicPrAnalysis, impactAssessment: ImpactAssessment): ReportEvidence {
  const analysis = deterministicPrAnalysisSchema.parse(analysisInput);
  if (analysis.status === "ready" && analysis.affectedItems.some((item) => item.dependencyPath.length === 0)) throw new Error("ready PR analysis contains an affected item without dependency evidence");
  return {
    version: 5,
    repoId: analysis.repoId,
    pullRequestNumber: analysis.pullRequestNumber,
    baseSha: analysis.baseSha,
    headSha: analysis.headSha,
    analysisStatus: analysis.status,
    insufficientReason: analysis.insufficientReason,
    unresolvedImportCount: analysis.unresolvedImportCount,
    changedFiles: analysis.changedFiles,
    changedSymbols: analysis.changedSymbols.map((symbol) => ({ id: `symbol:${symbol.symbolKey}`, name: symbol.name, changeKind: symbol.changeKind, filePath: symbol.filePath })).sort((a, b) => a.id.localeCompare(b.id)),
    affectedItems: analysis.affectedItems.map((item) => ({ id: `affected:${item.projectRoot ?? ""}:${item.kind}:${item.httpMethod ?? ""}:${item.routePath ?? item.path}`, path: item.path, kind: item.kind, projectRoot: item.projectRoot, routePath: item.routePath, httpMethod: item.httpMethod, impact: item.impact, dependencyPath: item.dependencyPath })).sort((a, b) => a.kind.localeCompare(b.kind) || (a.projectRoot ?? "").localeCompare(b.projectRoot ?? "") || (a.routePath ?? a.path).localeCompare(b.routePath ?? b.path)),
    impactAssessment,
  };
}
