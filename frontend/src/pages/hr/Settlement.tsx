import { Redirect, useLocation } from "wouter";
import HrLayout from "@/components/HrLayout";
import { Skeleton } from "@/components/ui/skeleton";
import { useSettlementMethod } from "@/lib/api-client/custom-hooks/settlement-automation";
import AutomationOverview from "./settlement/automation/AutomationOverview";
import AutomationSettlement from "./settlement/automation/AutomationSettlement";
import NormalSettlement from "./settlement/NormalSettlement";
import { loanAdvancePageOf, loanAdvancePath } from "./settlement/routes";

/**
 * Loan & Advance (the Settlement page, renamed 2026-11-27): three addresses, each a sidebar sub-item and each with at
 * most one row of tabs of its own (owner: never a tab row inside a tab, never sections stacked on one long page):
 *
 *   /hr/Loan&Advance                  Overview of both types
 *   /hr/Loan&Advance/salary-advance   Salary Advance
 *   /hr/Loan&Advance/term-loan        Term Loan
 *
 * Settings -> Loan & Advance chooses the method (owner 2026-11-26). The Normal Method is the list page (both types on the
 * Overview, one type on its own page); the Automation Method is the month-wise workflow: the Overview shows where each
 * type's workflow stands, each type's page is its own workflow (Salary Advance and Term Loan run independently). Until the
 * method is known a skeleton shows, so an approve button never appears on a page that would refuse it; if it cannot be
 * read, the Normal Method's page shows (the server still refuses its approve / reject while the Automation Method is on).
 * An address under /hr/Loan&Advance that is not one of the three, or one written another way (case, a "/" at the end),
 * is sent to its page's own address.
 */
export default function LoanAdvance() {
  const [location] = useLocation();
  const page = loanAdvancePageOf(location);
  const { data, isLoading } = useSettlementMethod();

  const canonical = loanAdvancePath(page ?? "overview");
  // the query as the browser has it (not decoded): a search for "a&b" stays one value
  if (location !== canonical) return <Redirect to={`${canonical}${window.location.search}`} replace />;

  if (isLoading) {
    return (
      <HrLayout>
        <div className="space-y-4" data-testid="settlement-method-loading">
          <Skeleton className="h-10 w-48 rounded-xl" />
          <Skeleton className="h-32 w-full rounded-2xl" />
          <Skeleton className="h-72 w-full rounded-2xl" />
        </div>
      </HrLayout>
    );
  }
  const shown = page ?? "overview";
  if (data?.method === "automation") {
    return shown === "overview" ? <AutomationOverview /> : <AutomationSettlement key={shown} advanceType={shown} />;
  }
  return <NormalSettlement key={shown} page={shown} />;
}
