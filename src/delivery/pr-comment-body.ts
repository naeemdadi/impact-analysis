export interface PrCommentAnalysisState {
  status: string;
  baseSha: string;
  headSha: string;
}

export function commentMarker(repoId: number, pullRequestNumber: number): string {
  return `<!-- impact-analysis:repo=${repoId}:pr=${pullRequestNumber} -->`;
}

export function renderPrCommentBody(input: {
  marker: string;
  analysis: PrCommentAnalysisState;
  markdown: string | null;
}): string {
  const footer = `\n\n---\nImpact Analysis · Base: \`${input.analysis.baseSha}\` · Head: \`${input.analysis.headSha}\`\n${input.marker}`;
  if (input.analysis.status === "building") return `## Impact Analysis\n\nAnalysis is running for \`${input.analysis.headSha}\`.${footer}`;
  if (input.analysis.status === "ready") {
    if (!input.markdown) throw new Error("ready PR analysis has no ready report for comment delivery");
    return `${input.markdown.trim()}${footer}`;
  }
  if (input.analysis.status === "insufficient_evidence") {
    return `## Impact Analysis\n\nAnalysis completed without impact claims because the available source evidence was insufficient.${footer}`;
  }
  return `## Impact Analysis\n\nAnalysis could not complete for \`${input.analysis.headSha}\`; no impact claims were made.${footer}`;
}
