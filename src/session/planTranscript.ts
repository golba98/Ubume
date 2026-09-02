import type { TimelineEvent } from "./types.js";
import { getRunPlanText } from "./types.js";

function normalizePlanText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function hasFinalizedTranscriptPlan(events: readonly TimelineEvent[], planText: string | null | undefined): boolean {
  const expected = normalizePlanText(planText ?? "");
  if (!expected) return false;

  return events.some((event) => {
    if (event.type !== "run") return false;
    if (event.status !== "completed") return false;
    if (event.plan?.status !== "completed") return false;
    const transcriptPlan = normalizePlanText(getRunPlanText(event.plan));
    return transcriptPlan.length > 0 && transcriptPlan === expected;
  });
}
