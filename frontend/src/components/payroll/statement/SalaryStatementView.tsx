import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  Building2,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileSpreadsheet,
  RefreshCw,
  Users,
} from "lucide-react";
import type { SalaryStatement, StatementRow } from "@/lib/api-client/custom-hooks";
import { plural } from "@/components/payroll/kit/format";
import { Chip, EmptyNote, PayrollLoader } from "@/components/payroll/kit/parts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import UktLogoMark from "@/components/ui/UktLogoMark";
import { cn } from "@/lib/utils";
import { ACCENT } from "./accent";
import { SHEET_PX } from "./paper-css";
import { PaperStyle, StatementSheet, usePaper } from "./StatementSheets";
import { StatementScrollTable } from "./StatementScrollTable";
import { formatStamp, statementRowCount, statementTitle, type StatementAccent } from "./statement-model";
import { useElementWidth } from "./use-element-width";

export type StatementView = "scroll" | "pages";

export type SalaryStatementViewProps = {
  statement?: SalaryStatement;
  /** The statement is on its way: with nothing to show yet this is the skeleton of the paper. */
  loading?: boolean;
  /** The request failed: with nothing to show this is a message with Retry. */
  error?: unknown;
  onRetry?: () => void;
  /** Indigo on Staff Payroll, amber on Production Payroll. */
  accent: StatementAccent;
  /** Called with the row when its name is clicked: the page opens that payroll's details. */
  onOpenDetails?: (row: StatementRow) => void;
  /** An extra last column ("Actions") with whatever the page wants on each row (Mark as Cleared, Adjust ...). */
  renderRowActions?: (row: StatementRow) => ReactNode;
  /** "scroll": one continuous table. "pages": the A4 landscape sheets as they print, one at a time. */
  view?: StatementView;
  /** The sheet on show in the "pages" view (1-based). Leave it out and the view keeps the page itself. */
  page?: number;
  onPageChange?: (page: number) => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Something went wrong while loading it. Try again in a moment.";
}

/** True once `active` has lasted `ms`: the point where a plain skeleton should say it is still working. */
function useLongWait(active: boolean, ms = 2500): boolean {
  const [long, setLong] = useState(false);
  useEffect(() => {
    if (!active) {
      setLong(false);
      return;
    }
    const timer = setTimeout(() => setLong(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return long;
}

// ── Not a statement yet ──────────────────────────────────────────────────────

function StatementSkeleton({ accent, long }: { accent: StatementAccent; long: boolean }) {
  return (
    <section
      className="clay-card min-w-0 overflow-hidden rounded-2xl border border-slate-100 bg-white"
      data-testid="statement-skeleton"
      aria-busy="true"
      aria-label="Loading the salary statement"
    >
      <div className={cn("h-1.5 bg-gradient-to-r", ACCENT[accent].topBar)} aria-hidden="true" />
      <div className="flex flex-col items-center gap-2 px-6 pb-2 pt-6">
        <Skeleton className="h-11 w-16 rounded-xl" />
        <Skeleton className="h-5 w-56 max-w-full" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <div className="px-3 pb-5 pt-4 sm:px-5">
        <div className="overflow-hidden rounded-xl border border-slate-100">
          <div className="flex items-center gap-3 bg-slate-50 px-3 py-3" data-testid="statement-skeleton-head">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-32" />
            <Skeleton className="hidden h-3 w-24 sm:block" />
            <Skeleton className="ml-auto h-3 w-16" />
            <Skeleton className="hidden h-3 w-16 sm:block" />
            <Skeleton className="hidden h-3 w-16 md:block" />
          </div>
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="flex items-center gap-3 border-t border-slate-100 px-3 py-2.5"
              data-testid="statement-skeleton-row"
            >
              <Skeleton className="h-4 w-8" />
              <Skeleton className="h-4 w-14" />
              <Skeleton className="h-4 w-32" />
              <Skeleton className="hidden h-4 w-24 sm:block" />
              <Skeleton className="ml-auto h-4 w-16" />
              <Skeleton className="hidden h-4 w-16 sm:block" />
              <Skeleton className="hidden h-4 w-16 md:block" />
            </div>
          ))}
        </div>
        {long && <PayrollLoader label="Preparing the salary statement" className="pt-2" />}
      </div>
    </section>
  );
}

function StatementError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-3 rounded-2xl border border-red-100 bg-red-50/60 px-6 py-12 text-center"
      data-testid="statement-error"
    >
      <AlertTriangle size={30} className="text-red-400" />
      <p className="text-sm font-bold text-red-800">The salary statement could not be loaded</p>
      <p className="max-w-md text-xs text-red-700">{errorMessage(error)}</p>
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} data-testid="statement-retry" className="gap-2">
          <RefreshCw size={14} /> Retry
        </Button>
      )}
    </div>
  );
}

function StatementEmpty() {
  return (
    <EmptyNote
      icon={FileSpreadsheet}
      title="No payroll to put on a statement for this period"
      hint="Generate payroll first - the statement is built from it."
      testId="statement-empty"
    />
  );
}

// ── The paper ────────────────────────────────────────────────────────────────

function Letterhead({ statement, accent }: { statement: SalaryStatement; accent: StatementAccent }) {
  const { name, branchLabel } = statement.company;
  return (
    <header data-testid="statement-letterhead">
      <div className={cn("h-1.5 bg-gradient-to-r", ACCENT[accent].topBar)} aria-hidden="true" />
      <div className="px-4 pb-1 pt-5 text-center sm:px-6">
        <div className="mx-auto flex max-w-full flex-col items-center gap-2 sm:flex-row sm:justify-center sm:gap-4">
          <UktLogoMark className="h-11 shrink-0" />
          <div className="min-w-0">
            <h3
              className="text-lg font-black leading-tight tracking-wide text-slate-900 sm:text-xl"
              data-testid="statement-company"
            >
              {name}
              {branchLabel ? <span className="text-slate-400"> - {branchLabel}</span> : null}
            </h3>
            <p className="mt-0.5 text-sm font-semibold text-slate-600" data-testid="statement-title">
              {statementTitle(statement)}
            </p>
          </div>
        </div>
      </div>
    </header>
  );
}

function CountChips({ statement }: { statement: SalaryStatement }) {
  const { employees, departments, paid, pending } = statement.counts;
  return (
    <div
      className="flex flex-wrap items-center justify-center gap-2 px-4 pb-3 pt-3 sm:px-6"
      data-testid="statement-chips"
    >
      <Chip tone="info" icon={Users}>
        <span data-testid="statement-chip-employees">{plural(employees, "employee")}</span>
      </Chip>
      <Chip tone="neutral" icon={Building2}>
        <span data-testid="statement-chip-departments">{plural(departments, "department")}</span>
      </Chip>
      <Chip tone="success" icon={CheckCircle2}>
        <span data-testid="statement-chip-paid">{paid} cleared</span>
      </Chip>
      <Chip tone="warning" icon={Clock}>
        <span data-testid="statement-chip-pending">{pending} pending</span>
      </Chip>
      {statement.period.cycleLabel ? <Chip tone="accent">{statement.period.cycleLabel}</Chip> : null}
    </div>
  );
}

function Notes({ statement }: { statement: SalaryStatement }) {
  return (
    <footer
      className="border-t border-slate-100 bg-slate-50/60 px-4 py-3 text-[11px] leading-relaxed text-muted-foreground sm:px-6"
      data-testid="statement-notes"
    >
      {statement.notes.length > 0 && (
        <>
          <p className="font-bold text-slate-600">Notes</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-4">
            {statement.notes.map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-2 text-right text-[10px]" data-testid="statement-generated">
        Generated {formatStamp(statement.generatedAt)}
      </p>
    </footer>
  );
}

function ScrollPaper({
  statement,
  accent,
  onOpenDetails,
  renderRowActions,
}: Pick<SalaryStatementViewProps, "onOpenDetails" | "renderRowActions"> & {
  statement: SalaryStatement;
  accent: StatementAccent;
}) {
  return (
    <section
      className="clay-card min-w-0 overflow-hidden rounded-2xl border border-slate-100 bg-white"
      data-testid="statement-paper"
    >
      <Letterhead statement={statement} accent={accent} />
      <CountChips statement={statement} />
      <div className="min-w-0 px-3 pb-4 sm:px-5">
        <StatementScrollTable
          statement={statement}
          accent={accent}
          onOpenDetails={onOpenDetails}
          renderRowActions={renderRowActions}
        />
      </div>
      <Notes statement={statement} />
    </section>
  );
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/** The sheets as they print, one at a time, scaled down to the width there is (never below 35%, then it scrolls). */
function PagesView({
  statement,
  page,
  onPageChange,
}: {
  statement: SalaryStatement;
  page?: number;
  onPageChange?: (page: number) => void;
}) {
  const { pages, layout } = usePaper(statement);
  const [own, setOwn] = useState(1);
  const [setBox, width] = useElementWidth<HTMLDivElement>();
  const current = clamp(page ?? own, 1, pages.length);
  const scale = width > 0 ? clamp(width / SHEET_PX.width, 0.35, 1) : 1;

  const go = (next: number) => {
    const target = clamp(next, 1, pages.length);
    if (page === undefined) setOwn(target);
    onPageChange?.(target);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") go(current - 1);
    else if (e.key === "ArrowRight") go(current + 1);
    else return;
    e.preventDefault();
  };

  return (
    <section
      className="clay-card min-w-0 rounded-2xl border border-slate-100 bg-white p-3 sm:p-4"
      data-testid="statement-pages"
    >
      <PaperStyle />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-bold text-slate-800">
          Paper preview <span className="text-xs font-normal text-muted-foreground">A4 landscape, as it prints</span>
        </p>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 px-0"
            aria-label="Previous page"
            disabled={current <= 1}
            onClick={() => go(current - 1)}
            data-testid="statement-page-prev"
          >
            <ChevronLeft size={15} />
          </Button>
          <span
            className="min-w-[6.5rem] text-center text-xs font-semibold tabular-nums text-slate-700"
            aria-live="polite"
            data-testid="statement-page-label"
          >
            Page {current} of {pages.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-8 w-8 px-0"
            aria-label="Next page"
            disabled={current >= pages.length}
            onClick={() => go(current + 1)}
            data-testid="statement-page-next"
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>
      <div
        ref={setBox}
        className="min-w-0 overflow-x-auto rounded-xl bg-slate-100 p-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300"
        role="region"
        aria-label="Paper preview of the salary statement"
        tabIndex={0}
        onKeyDown={onKeyDown}
        data-testid="statement-pages-box"
        data-scale={scale.toFixed(3)}
      >
        <div className="mx-auto" style={{ width: SHEET_PX.width * scale, height: SHEET_PX.height * scale }}>
          <div
            style={{
              width: SHEET_PX.width,
              height: SHEET_PX.height,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          >
            <StatementSheet
              preview
              statement={statement}
              page={pages[current - 1]}
              pageCount={pages.length}
              layout={layout}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// ── The view ─────────────────────────────────────────────────────────────────

/**
 * The Salary Statement on screen, in the printed statement's format: letterhead, the employees grouped under department bands
 * with a subtotal each, the grand total, the notes. Pure: it draws the statement it is given (the panel fetches and filters).
 */
export function SalaryStatementView({
  statement,
  loading,
  error,
  onRetry,
  accent,
  onOpenDetails,
  renderRowActions,
  view = "scroll",
  page,
  onPageChange,
}: SalaryStatementViewProps) {
  const waited = useLongWait(!!loading && !statement);

  if (!statement) {
    if (loading) return <StatementSkeleton accent={accent} long={waited} />;
    if (error) return <StatementError error={error} onRetry={onRetry} />;
    return <StatementEmpty />;
  }
  if (statementRowCount(statement) === 0) return <StatementEmpty />;

  return (
    <div
      className="min-w-0 space-y-3"
      data-testid="statement-view"
      data-view={view}
      aria-busy={loading ? "true" : undefined}
    >
      {error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-100 bg-red-50 px-4 py-2.5 text-xs text-red-800"
          data-testid="statement-inline-error"
        >
          <span className="flex items-center gap-2">
            <AlertTriangle size={14} /> Could not refresh the statement: showing what was loaded earlier.
          </span>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry} className="h-7 gap-1.5">
              <RefreshCw size={12} /> Retry
            </Button>
          )}
        </div>
      ) : null}
      {view === "pages" ? (
        <PagesView statement={statement} page={page} onPageChange={onPageChange} />
      ) : (
        <ScrollPaper
          statement={statement}
          accent={accent}
          onOpenDetails={onOpenDetails}
          renderRowActions={renderRowActions}
        />
      )}
    </div>
  );
}
