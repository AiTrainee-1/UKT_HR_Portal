import type { ReactNode } from "react";
import { AlertCircle, BarChart3, FileSearch, Info, ShieldAlert } from "lucide-react";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { formatCell } from "@/lib/report-format";
import type { ReportSummaryCard } from "@/lib/report-center";

export function IdleState() {
  return (
    <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white/60 px-6 py-16 text-center">
      <BarChart3 className="mx-auto mb-3 h-10 w-10 text-gray-300" />
      <p className="text-base font-semibold text-gray-700">Choose your filters, then press “Show report”</p>
      <p className="mt-1 text-sm text-muted-foreground">
        The report appears here. You can download it as PDF or Excel once it has loaded.
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

/** A human message for whatever went wrong loading a report. */
export function describeReportError(err: unknown): { title: string; message: string; forbidden: boolean } {
  if (err instanceof ApiError) {
    const data = (err.data ?? {}) as { error?: string; message?: string };
    if (err.status === 403 && data.error === "report_forbidden") {
      return {
        title: "You don’t have access to this report",
        message: data.message ?? "Ask an administrator to grant access.",
        forbidden: true,
      };
    }
    if (err.status === 403) {
      return { title: "Access denied", message: "Your role can’t open the Reports section.", forbidden: true };
    }
    if (err.status === 400) {
      return {
        title: "Check the filters",
        message: data.message ?? "One of the filters is not valid.",
        forbidden: false,
      };
    }
    if (err.status === 404) {
      return {
        title: "Report not found",
        message: "This report doesn’t exist, or the server has not been updated yet.",
        forbidden: false,
      };
    }
    if (err.status >= 500) {
      return {
        title: "The report could not be generated",
        message: data.message ?? "The server had a problem. Please try again in a moment.",
        forbidden: false,
      };
    }
  }
  return { title: "Could not load the report", message: "Check your connection and try again.", forbidden: false };
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const { title, message, forbidden } = describeReportError(error);
  const Icon = forbidden ? ShieldAlert : AlertCircle;
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-red-800" role="alert">
      <Icon className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="flex-1">
        <p className="text-sm font-semibold">{title}</p>
        <p className="mt-0.5 text-sm">{message}</p>
      </div>
      {onRetry && !forbidden && (
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

export function SummaryCards({ cards }: { cards: ReportSummaryCard[] }) {
  if (!cards.length) return null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="report-summary">
      {cards.map((c) => (
        <div key={c.label} className="rounded-xl border bg-white p-3.5 shadow-sm">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-500">{c.label}</p>
          <p className="mt-1 text-2xl font-black tabular-nums text-gray-900">{formatCell(c.value, c.format)}</p>
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
          <span className="text-gray-400">{f.label}: </span>
          <span className="font-semibold text-gray-800">{f.value}</span>
        </span>
      ))}
    </div>
  );
}
