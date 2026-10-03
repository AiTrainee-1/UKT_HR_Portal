import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  Info,
  Search,
  Sparkles,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { ROW_STATUS_META, ROW_STATUS_ORDER } from "./config";
import { downloadResultReport } from "./excel";
import { countsOfRows, filterRows, problemCount, type RowFilter } from "./logic";
import type { BulkResult, RowReport, RowStatus, UploadContext } from "./types";

const PAGE_SIZE = 20;

/** "Ready to import" in a check, "Created" once it is done. */
function statusLabel(status: RowStatus, preview: boolean): string {
  if (preview && status === "created") return "Ready to import";
  if (preview && status === "updated") return "Will update";
  return ROW_STATUS_META[status].label;
}

function StatusChip({ status, preview }: { status: RowStatus; preview: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold",
        ROW_STATUS_META[status].chip,
      )}
    >
      {statusLabel(status, preview)}
    </span>
  );
}

function Tile({ label, value, tone, testId }: { label: string; value: number; tone: string; testId: string }) {
  return (
    <div className={cn("rounded-xl border bg-white px-3 py-3", value === 0 && "opacity-60")} data-testid={testId}>
      <p className={cn("text-2xl font-black leading-none", value > 0 ? tone : "text-gray-400")}>{value}</p>
      <p className="mt-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500">{label}</p>
    </div>
  );
}

function Details({ r, preview }: { r: RowReport; preview: boolean }) {
  return (
    <div className="space-y-1 text-xs leading-relaxed">
      {r.messages.map((m, i) => (
        <p
          key={`m${i}`}
          className={cn(
            r.status === "unchanged" || r.status === "skipped" ? "text-gray-500" : "font-medium text-red-700",
          )}
        >
          {m}
        </p>
      ))}
      {r.changes.length > 0 && (
        <p className="text-blue-700">
          <span className="font-semibold">Changed:</span> {r.changes.join(", ")}
        </p>
      )}
      {(r.notes ?? []).map((n, i) => (
        <p key={`n${i}`} className="flex items-start gap-1 text-emerald-700" data-testid="bulk-row-note">
          <Sparkles size={12} className="mt-0.5 shrink-0" /> {preview ? n.replace(/^Created /, "Will create ") : n}
        </p>
      ))}
      {r.warnings.map((w, i) => (
        <p key={`w${i}`} className="flex items-start gap-1 text-amber-700">
          <AlertTriangle size={12} className="mt-0.5 shrink-0" /> {w}
        </p>
      ))}
      {r.status === "created" && r.warnings.length === 0 && <p className="text-gray-500">Added to the employee list</p>}
    </div>
  );
}

type Props = {
  result: BulkResult;
  context: UploadContext;
};

/** What happened to every row of an uploaded sheet: tallies, a filterable list with the reason for each, and a report. */
export default function ResultsPanel({ result, context }: Props) {
  const preview = result.preview;
  const rows = result.rows;
  const byStatus = useMemo(() => countsOfRows(rows), [rows]);
  const [filter, setFilter] = useState<RowFilter>(problemCount(result.counts) > 0 ? "problems" : "all");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);

  const shown = useMemo(() => filterRows(rows, filter, query), [rows, filter, query]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  const pageRows = shown.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const problems = problemCount(result.counts);

  const create = context.kind === "create";
  const tiles: { status: RowStatus; tone: string }[] = [
    ...(create
      ? [{ status: "created" as const, tone: "text-green-700" }]
      : [
          { status: "updated" as const, tone: "text-blue-700" },
          { status: "unchanged" as const, tone: "text-slate-600" },
        ]),
    { status: "duplicate", tone: "text-orange-700" },
    { status: "invalid", tone: "text-red-700" },
    { status: "failed", tone: "text-rose-700" },
    ...(create ? [] : [{ status: "not_found" as const, tone: "text-purple-700" }]),
    { status: "skipped", tone: "text-yellow-700" },
  ];

  const banner =
    problems === 0
      ? {
          tone: "border-green-200 bg-green-50 text-green-800",
          icon: <CheckCircle2 size={18} className="shrink-0 text-green-600" />,
        }
      : (create ? result.counts.created : result.counts.updated) === 0
        ? {
            tone: "border-red-200 bg-red-50 text-red-800",
            icon: <XCircle size={18} className="shrink-0 text-red-600" />,
          }
        : {
            tone: "border-amber-200 bg-amber-50 text-amber-900",
            icon: <AlertTriangle size={18} className="shrink-0 text-amber-600" />,
          };

  return (
    <div className="space-y-4" data-testid="bulk-results">
      <div className={cn("flex items-start gap-3 rounded-xl border px-4 py-3", banner.tone)}>
        {banner.icon}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold" data-testid="bulk-result-message">
            {result.message}
          </p>
          <p className="mt-0.5 truncate text-xs opacity-80">
            {context.fileName} · {preview ? "checked only, nothing saved" : "saved"}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5 bg-white"
          onClick={() => void downloadResultReport(result, context)}
          data-testid="bulk-download-report"
        >
          <Download size={13} /> Report
        </Button>
      </div>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(104px,1fr))] gap-2">
        {tiles.map((t) => (
          <Tile
            key={t.status}
            label={statusLabel(t.status, preview) + (t.status === "duplicate" ? "s" : "")}
            value={result.counts[t.status === "not_found" ? "notFound" : t.status]}
            tone={t.tone}
            testId={`bulk-tile-${t.status}`}
          />
        ))}
        {!create && (result.counts.missing ?? 0) > 0 && (
          <Tile
            label="Not in file"
            value={result.counts.missing ?? 0}
            tone="text-gray-700"
            testId="bulk-tile-missing"
          />
        )}
        {!preview && (result.counts.madeInactive ?? 0) > 0 && (
          <Tile
            label="Made inactive"
            value={result.counts.madeInactive ?? 0}
            tone="text-slate-700"
            testId="bulk-tile-inactive"
          />
        )}
        {!preview && (result.counts.deleted ?? 0) > 0 && (
          <Tile label="Deleted" value={result.counts.deleted ?? 0} tone="text-red-700" testId="bulk-tile-deleted" />
        )}
      </div>

      {((result.newDesignations?.length ?? 0) > 0 || (result.newDepartments?.length ?? 0) > 0) && (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4" data-testid="bulk-new-records">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-emerald-900">
            <Sparkles size={14} className="text-emerald-600" />{" "}
            {preview
              ? "These will be created, because the sheet names them and they do not exist yet"
              : "Created, because the sheet names them and they did not exist yet"}
          </p>
          <ul className="space-y-1 text-xs text-emerald-900">
            {(result.newDepartments ?? []).map((d) => (
              <li key={`d-${d.name}`} data-testid="bulk-new-department">
                Department <span className="font-semibold">{d.name}</span> · {d.rows} employee{d.rows === 1 ? "" : "s"}
              </li>
            ))}
            {(result.newDesignations ?? []).map((d) => (
              <li key={`g-${d.department ?? ""}-${d.title}`} data-testid="bulk-new-designation">
                Designation <span className="font-semibold">{d.title}</span>
                {d.department ? ` in ${d.department}` : ""} · {d.rows} employee{d.rows === 1 ? "" : "s"}
              </li>
            ))}
          </ul>
        </div>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-gray-500">
          The file has no employee rows.
        </p>
      ) : (
        <div className="rounded-xl border bg-white">
          <div className="flex flex-wrap items-center gap-2 border-b p-3">
            {[
              { key: "all" as const, label: "All", n: rows.length },
              ...(problems > 0 ? [{ key: "problems" as const, label: "Needs attention", n: problems }] : []),
              ...ROW_STATUS_ORDER.filter((s) => byStatus[s] > 0).map((s) => ({
                key: s as RowFilter,
                label: statusLabel(s, preview),
                n: byStatus[s],
              })),
            ].map((chip) => (
              <button
                key={chip.key}
                type="button"
                aria-pressed={filter === chip.key}
                onClick={() => {
                  setFilter(chip.key);
                  setPage(1);
                }}
                className={cn(
                  "h-8 rounded-full border px-3 text-xs font-semibold transition-colors",
                  filter === chip.key
                    ? "border-gray-900 bg-gray-900 text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50",
                )}
              >
                {chip.label} <span className="opacity-70">{chip.n}</span>
              </button>
            ))}
            <div className="relative ml-auto w-full sm:w-64">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(1);
                }}
                placeholder="Search code, name or reason"
                aria-label="Search the results"
                className="h-8 pl-8 text-xs"
              />
            </div>
          </div>

          {/* wide screens: a table */}
          <div className="hidden overflow-x-auto md:block">
            <table className="w-full text-sm" data-testid="bulk-result-table">
              <thead className="border-b bg-gray-50 text-left text-[11px] font-semibold uppercase tracking-wide text-gray-500">
                <tr>
                  <th className="px-4 py-2.5">Row</th>
                  <th className="px-4 py-2.5">Employee</th>
                  <th className="px-4 py-2.5">Result</th>
                  <th className="px-4 py-2.5">Details</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((r) => (
                  <tr
                    key={`${r.row}-${r.code}`}
                    className="border-b last:border-0 align-top"
                    data-testid={`bulk-row-${r.row}`}
                    data-status={r.status}
                  >
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{r.row}</td>
                    <td className="px-4 py-3">
                      <p className="font-semibold text-gray-900">{r.code || "(no code)"}</p>
                      <p className="text-xs text-gray-500">{r.name || "No name"}</p>
                    </td>
                    <td className="px-4 py-3">
                      <StatusChip status={r.status} preview={preview} />
                    </td>
                    <td className="px-4 py-3">
                      <Details r={r} preview={preview} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* phones: a card for each row */}
          <div className="divide-y md:hidden">
            {pageRows.map((r) => (
              <div
                key={`${r.row}-${r.code}`}
                className="space-y-2 p-3"
                data-testid={`bulk-card-${r.row}`}
                data-status={r.status}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-gray-900">{r.code || "(no code)"}</p>
                    <p className="truncate text-xs text-gray-500">
                      Row {r.row} · {r.name || "No name"}
                    </p>
                  </div>
                  <StatusChip status={r.status} preview={preview} />
                </div>
                <Details r={r} preview={preview} />
              </div>
            ))}
          </div>

          {shown.length === 0 && <p className="p-6 text-center text-sm text-gray-500">No rows match this filter.</p>}

          {shown.length > PAGE_SIZE && (
            <div className="flex items-center justify-between border-t px-4 py-2.5 text-xs text-gray-500">
              <span>
                {(current - 1) * PAGE_SIZE + 1}-{Math.min(current * PAGE_SIZE, shown.length)} of {shown.length}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={current === 1}
                  onClick={() => setPage(current - 1)}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={14} />
                </Button>
                <span className="px-1">
                  {current} / {pages}
                </span>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-7 w-7"
                  disabled={current === pages}
                  onClick={() => setPage(current + 1)}
                  aria-label="Next page"
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {(result.missing ?? []).some((m) => m.result) && (
        <div className="rounded-xl border bg-white p-4" data-testid="bulk-removal-result">
          <p className="mb-2 flex items-center gap-1.5 text-sm font-bold text-gray-900">
            <Info size={14} className="text-gray-500" /> Employees that were not in the file
          </p>
          <ul className="space-y-1 text-xs text-gray-700">
            {(result.missing ?? []).map((m) => (
              <li key={m.code} className="flex flex-wrap justify-between gap-2">
                <span>
                  <span className="font-semibold">{m.code}</span> {m.name}
                </span>
                <span className={cn("font-semibold", m.action === "delete" ? "text-red-700" : "text-gray-600")}>
                  {m.result}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
