import type { ReactNode } from "react";
import { Link } from "wouter";
import { ChevronRight, Workflow } from "lucide-react";
import { TYPE_LABEL } from "./logic";
import { LOAN_ADVANCE_BASE, LOAN_ADVANCE_TITLE, type LoanAdvancePage } from "./routes";

/**
 * The title row of every Loan & Advance page (owner 2026-11-27): the breadcrumb (Loan & Advance › Salary Advance on a
 * type's page), the page's name, the Automation Method's badge when it runs, a line on what the page is, and the page's
 * buttons on the right. No tabs here: the sidebar's sub-items choose the page.
 */
export default function PageHeading({
  page,
  automation = false,
  children,
  actions,
}: {
  page: LoanAdvancePage;
  /** The Automation Method runs: a badge says so. */
  automation?: boolean;
  /** The line under the title. */
  children: ReactNode;
  actions?: ReactNode;
}) {
  const title = page === "overview" ? LOAN_ADVANCE_TITLE : TYPE_LABEL[page];
  return (
    <div className="flex flex-wrap items-start justify-between gap-3" data-testid="loan-advance-heading">
      <div className="min-w-0">
        <nav aria-label="Breadcrumb" className="mb-0.5" data-testid="loan-advance-breadcrumb">
          <ol className="flex flex-wrap items-center gap-1 text-xs font-semibold text-slate-500">
            {page === "overview" ? (
              <li aria-current="page">{LOAN_ADVANCE_TITLE}</li>
            ) : (
              <>
                <li>
                  <Link href={LOAN_ADVANCE_BASE} className="hover:text-slate-800 hover:underline">
                    {LOAN_ADVANCE_TITLE}
                  </Link>
                </li>
                <li aria-hidden>
                  <ChevronRight size={12} />
                </li>
                <li aria-current="page" className="text-slate-700">
                  {title}
                </li>
              </>
            )}
          </ol>
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-2xl font-black text-gray-900" data-testid="loan-advance-title">
            {title}
          </h2>
          {automation && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-bold text-indigo-700"
              data-testid="settlement-method-badge"
            >
              <Workflow size={12} aria-hidden /> Automation Method
            </span>
          )}
        </div>
        <div className="mt-0.5 max-w-3xl text-sm text-muted-foreground">{children}</div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
