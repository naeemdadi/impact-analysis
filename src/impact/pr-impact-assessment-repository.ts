import { eq } from "drizzle-orm";
import { db } from "../storage/db.js";
import { prImpactAssessmentTable } from "../storage/schema.js";
import type { ImpactAssessment } from "./impact-assessment.js";

export async function ensureImpactAssessment(analysisId: string, assessment: ImpactAssessment): Promise<ImpactAssessment> {
  const rows = await db.select({ assessmentJson: prImpactAssessmentTable.assessmentJson }).from(prImpactAssessmentTable).where(eq(prImpactAssessmentTable.prAnalysisId, analysisId)).limit(1);
  if (rows[0]?.assessmentJson) return rows[0].assessmentJson as unknown as ImpactAssessment;
  await db.insert(prImpactAssessmentTable).values({ prAnalysisId: analysisId, version: assessment.version, status: "ready", assessmentJson: assessment as unknown as Record<string, unknown>, completedAt: new Date() }).onConflictDoNothing();
  return assessment;
}

export async function findImpactAssessment(analysisId: string): Promise<ImpactAssessment | null> {
  const rows = await db.select({ assessmentJson: prImpactAssessmentTable.assessmentJson })
    .from(prImpactAssessmentTable)
    .where(eq(prImpactAssessmentTable.prAnalysisId, analysisId)).limit(1);
  return rows[0]?.assessmentJson ? rows[0].assessmentJson as unknown as ImpactAssessment : null;
}
