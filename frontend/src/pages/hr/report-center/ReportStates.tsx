import type { ReactNode } from "react";
import { AlertCircle, BarChart3, FileSearch, History, Info, ShieldAlert } from "lucide-react";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { formatCell } from "@/lib/report-format";
import type { ReportSummaryCard } from "@/lib/report-center";

/** Before the first run. `waiting`: the report does not run on open (its defaults are too heavy), so say why. */
export function IdleState({ waiting = false }: { waiting?: boolean }) {
  return (
    <div
      className="rounded-xl border-2 border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center"
      data-testid="report-idle"
    >
      <BarChart3 className="mx-auto mb-3 h-10 w-10 text-gray-300" />
      <p className="text-base font-semibold text-gray-700">Choose your filters, then press “Show report”</p>
      <p className="mt-1 text-sm text-muted-foreground">
        {waiting
          ? "This report can be large, so it waits for you: narrow it to a department or a few employees first."
          : "The report appears here. You can download it as PDF or Excel once it has loaded."}
      </p>
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border bg-white py-16" role="status">
      <ShieldLoader size={88} />
      <p className="text-sm text-muted-foreground">Building the report…</p>
    </div>
  );
}

export function EmptyState({ filters }: { filters: { label: string; value: string }[] }) {
  return (
    <div className="rounded-xl border bg-white px-6 py-14 text-center">
      <FileSearch className="mx-auto mb-3 h-9 w-9 text-gray-300" />
      <p className="text-base font-semibold text-gray-700">No records for these filters</p>
      {filters.length > 0 && (
        <p className="mt-1 text-sm text-muted-foreground">
          {filters.map((f) => `${f.label}: ${f.value}`).join("  ·  ")}
        </p>
      )}
      <p className="mt-1 text-sm text-muted-foreground">Try a wider date range or remove a filter.</p>
    </div>
  );
}

export interface ReportErrorInfo {
  title: string;
  message: string;
  forbidden: boolean;
  /** Worth a "Try again": a server or network hiccup. A refused filter or a missing report fails the same way again. */
  retry: boolean;
  /** The query parameter (or filter key) a 400 points at, for highlighting the filter (lib/report-center.ts). */
  field: string | null;
  /** "warning": the filters were refused (the user's to change); "error": the report could not be made. */
  tone: "warning" | "error";
}

/** A human message for whatever went wrong loading a report. */
export function describeReportError(err: unknown): ReportErrorInfo {
  if (err instanceof ApiError) {
    const data = (err.data ?? {}) as { error?: string; message?: string; field?: string };
    const base = { forbidden: false, retry: false, field: null, tone: "error" as const };
    if (err.status === 403 && data.error === "report_forbidden") {
      return {
        ...base,
        title: "You don’t have access to this report",
        message: data.message ?? "Ask an administrator to grant access.",
        forbidden: true,
      };
    }
    if (err.status === 403) {
      return { ...base, title: "Access denied", message: "Your role can’t open the Reports section.", forbidden: true };
    }
    if (err.status === 400) {
      return {
        ...base,
        title: "Check the filters",
        message: data.message ?? "One of the filters is not valid.",
        field: typeof data.field === "string" ? data.field : null,
        tone: "warning",
      };
    }
    if (err.status === 404) {
      return {
        ...base,
        title: "Report not found",
        message: "This report doesn’t exist, or the server has not been updated yet.",
      };
    }
    if (err.status >= 500) {
      return {
        ...base,
        title: "The report could not be generated",
        message: data.message ?? "The server had a problem. Please try again in a moment.",
        retry: true,
      };
    }
  }
  return {
    title: "Could not load the report",
    message: "Check your connection and try again.",
    forbidden: false,
    retry: true,
    field: null,
    tone: "error",
  };
}

/** `filterLabel`: the filter a refused run points at (highlighted in the filter bar), named in the hint. `hint` replaces
 *  the "... then press Show report" line under a refused run, for a page with no such button (the builder's preview). */
export function ErrorState({
  error,
  onRetry,
  filterLabel,
  hint,
}: {
  error: unknown;
  onRetry?: () => void;
  filterLabel?: string | null;
  hint?: string;
}) {
  const { title, message, forbidden, retry, tone } = describeReportError(error);
  const Icon = forbidden ? ShieldAlert : AlertCircle;
  return (
    <div
      className={`flex items-start gap-3 rounded-xl border p-4 ${
        tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-800"
      }`}
      role="alert"
      data-testid="report-error"
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-sm">{message}</p>
        {tone === "warning" && (
          <p className="mt-1 text-xs">
            {hint ??
              `${filterLabel ? `Change “${filterLabel}” above` : "Change the filters above"}, then press Show report.`}
          </p>
        )}
      </div>
      {/* a refused filter or a missing report fails the same way again: "Try again" only for a hiccup */}
      {onRetry && retry && (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

export function Banner({ tone, children }: { tone: "warning" | "info"; children: ReactNode }) {
  const cls =
    tone === "warning" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-sky-200 bg-sky-50 text-sky-900";
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-sm ${cls}`}
      role={tone === "warning" ? "alert" : "note"}
    >
      <Info className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

/** "Restored your last filters (Department, Month) · Reset": the report opened with what was used last time. */
export function RestoredNotice({ labels, onReset }: { labels: string[]; onReset: () => void }) {
  if (!labels.length) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-900"
      role="note"
      data-testid="report-restored"
    >
      <History className="h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">
        Restored your last filters <span className="font-semibold">({labels.join(", ")})</span>
      </span>
      <span aria-hidden="true">·</span>
      <button type="button" onClick={onReset} className="font-semibold underline underline-offset-2 hover:no-underline">
        Reset
      </button>
    </div>
  );
}

export function SummaryCards({ cards }: { cards: ReportSummaryCard[] }) {
  if (!cards.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="report-summary">
      {cards.map((c) => (
        <div key={c.label} className="min-w-0 rounded-xl border bg-white p-3 shadow-sm sm:p-3.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{c.label}</p>
          {/* a phone card is ~145 px wide: ₹1,86,05,345.68 steps down a size and may wrap rather than spill over */}
          <p className="mt-1 break-words text-lg font-black leading-tight tabular-nums text-gray-900 sm:text-2xl">
            {formatCell(c.value, c.format)}
          </p>
        </div>
      ))}
    </div>
  );
}

export function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-500">Notes</p>
      <ul className="list-disc space-y-0.5 pl-4 text-xs text-gray-600">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}

export function AppliedFilters({ filters }: { filters: { label: string; value: string }[] }) {
  if (!filters.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="report-applied-filters">
      {filters.map((f) => (
        <span key={f.label} className="rounded-full border bg-white px-2.5 py-0.5 text-[11px] text-gray-600">
          <span className="text-muted-foreground">{f.label}: </span>
          <span className="font-semibold text-gray-800">{f.value}</span>
        </span>
      ))}
    </div>
  );
}
