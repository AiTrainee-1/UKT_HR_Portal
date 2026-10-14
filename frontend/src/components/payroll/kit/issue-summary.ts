import type { PayrollIssuesSummary } from "@/lib/api-client/custom-hooks";

/**
 * The employees skipped at generation are not payroll rows, so the server's issue summary does not count them; the Issues view
 * lists them (as "Skipped at generation", critical). The dashboard tile and the view's count must agree with that list, so this
 * adds the skipped employees to the summary: the total, the critical count, the people affected and a "skipped" type.
 */
export function addSkipped(
  summary: PayrollIssuesSummary | undefined,
  skipped: number,
): PayrollIssuesSummary | undefined {
  if (!summary || skipped <= 0) return summary;
  const already = summary.byCode.find((c) => c.code === "skipped");
  if (already) return summary; // the server counted them itself
  return {
    ...summary,
    total: summary.total + skipped,
    employeesWithIssues: summary.employeesWithIssues + skipped,
    bySeverity: { ...summary.bySeverity, critical: summary.bySeverity.critical + skipped },
    byCode: [
      { code: "skipped", label: "Skipped at generation", severity: "critical", category: "generation", count: skipped },
      ...summary.byCode,
    ],
  };
}
