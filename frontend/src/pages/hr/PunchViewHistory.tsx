import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { ArrowLeft, ArrowRight, History, Search, X } from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { DataPagination } from "@/components/ui/DataPagination";
import {
  usePunchHistory,
  type PunchHistoryAction,
  type PunchHistoryItem,
  type PunchHistoryValue,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatusChip } from "./punch-view/parts";

const ACTIONS: { value: PunchHistoryAction | ""; label: string }[] = [
  { value: "", label: "Everything" },
  { value: "status_set", label: "Status set by hand" },
  { value: "status_reset", label: "Status back to automatic" },
  { value: "status_auto", label: "Status changed by the punches" },
  { value: "punch_added", label: "Punch added" },
  { value: "punch_edited", label: "Punch edited" },
  { value: "punch_deleted", label: "Punch deleted" },
];

const ACTION_TONE: Record<PunchHistoryAction, string> = {
  status_set: "bg-indigo-50 text-indigo-700 border-indigo-200",
  status_reset: "bg-slate-100 text-slate-700 border-slate-200",
  status_auto: "bg-amber-50 text-amber-700 border-amber-200",
  punch_added: "bg-green-50 text-green-700 border-green-200",
  punch_edited: "bg-blue-50 text-blue-700 border-blue-200",
  punch_deleted: "bg-red-50 text-red-700 border-red-200",
};

const useDebounced = <T,>(value: T, ms = 300): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

/** "13:00:00 OUT" / "5 Oct 09:00:00 IN" for a punch value. */
function punchText(v: PunchHistoryValue, withDate: boolean): string {
  if (!v) return "";
  const parts = [withDate && v.date ? v.date : "", v.time ?? "", v.type ?? ""].filter(Boolean);
  return parts.join(" ");
}

function ValueView({ item }: { item: PunchHistoryItem }) {
  const { action, before, after } = item;
  if (action.startsWith("status")) {
    return (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {before?.status ? (
          <StatusChip status={before.status} source={before.source} />
        ) : (
          <span className="text-slate-400">—</span>
        )}
        <ArrowRight size={12} className="text-slate-400" />
        {after?.status ? (
          <StatusChip status={after.status} source={after.source} />
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </span>
    );
  }
  if (action === "punch_edited") {
    const moved = before?.date !== after?.date;
    return (
      <span className="font-mono text-xs">
        {punchText(before, moved)}
        {before?.employee ? ` (was ${before.employee})` : ""} → {punchText(after, moved)}
      </span>
    );
  }
  return <span className="font-mono text-xs">{punchText(action === "punch_deleted" ? before : after, false)}</span>;
}

const whenText = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";

/**
 * Punch View history: every change made from the Punch View page - punches added, edited and deleted by an upload, a day's
 * status set by hand (or put back to automatic), and the days whose status changed by itself as a result.
 */
export default function PunchViewHistory() {
  const [, navigate] = useLocation();
  const [action, setAction] = useState<PunchHistoryAction | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [by, setBy] = useState("");
  const [text, setText] = useState("");
  const q = useDebounced(text.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // a new filter starts again from page 1
  useEffect(() => setPage(1), [q, action, from, to, by, pageSize]);

  const { data, isLoading, isError, error, refetch } = usePunchHistory({
    q,
    action,
    from,
    to,
    by: by.trim(),
    page,
    pageSize,
  });
  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const filtered = !!(q || action || from || to || by.trim());

  return (
    <HrLayout>
      <div className="space-y-5 pb-8" data-testid="punch-history-page">
        <div className="flex items-center gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => navigate("/hr/attendance/punch-view")}
            aria-label="Back to Punch View"
          >
            <ArrowLeft size={18} />
          </Button>
          <div className="rounded-2xl bg-indigo-600 p-2.5 text-white shadow-sm">
            <History size={20} />
          </div>
          <div>
            <h2 className="text-2xl font-black text-gray-900">Punch View History</h2>
            <p className="text-sm text-muted-foreground">
              Every change made from Punch View: punches added, edited or deleted, and days set to Present, Half Day or
              Absent.
            </p>
          </div>
        </div>

        <Card className="border-0 shadow-sm">
          <CardContent className="space-y-3 p-4">
            <div className="grid gap-3 md:grid-cols-4">
              <div className="space-y-1.5 md:col-span-2">
                <Label className="text-xs">Employee</Label>
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                  <Input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Employee Code or name"
                    className="h-9 pl-8 text-sm"
                    data-testid="history-search"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">What changed</Label>
                <select
                  value={action}
                  onChange={(e) => setAction(e.target.value as PunchHistoryAction | "")}
                  className="h-9 w-full rounded-md border bg-white px-2 text-sm"
                  data-testid="history-action"
                >
                  {ACTIONS.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Changed by</Label>
                <Input
                  value={by}
                  onChange={(e) => setBy(e.target.value)}
                  placeholder="Name"
                  className="h-9 text-sm"
                  data-testid="history-by"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Changed from</Label>
                <Input
                  type="date"
                  value={from}
                  max={to || undefined}
                  onChange={(e) => setFrom(e.target.value)}
                  className="h-9 text-sm"
                  data-testid="history-from"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Changed to</Label>
                <Input
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(e) => setTo(e.target.value)}
                  className="h-9 text-sm"
                  data-testid="history-to"
                />
              </div>
              {filtered && (
                <div className="flex items-end">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-1.5 text-xs"
                    onClick={() => {
                      setText("");
                      setAction("");
                      setFrom("");
                      setTo("");
                      setBy("");
                    }}
                    data-testid="history-clear"
                  >
                    <X size={13} /> Clear filters
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border-0 shadow-sm">
          <CardContent className="p-0">
            {isLoading ? (
              <div className="space-y-2 p-4">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-10 rounded" />
                ))}
              </div>
            ) : isError ? (
              <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700">
                <span>The history could not be loaded: {(error as Error)?.message ?? "no answer"}.</span>
                <Button size="sm" variant="outline" onClick={() => refetch()}>
                  Try again
                </Button>
              </div>
            ) : items.length === 0 ? (
              <div className="py-16 text-center" data-testid="history-empty">
                <History size={30} className="mx-auto mb-3 text-gray-200" />
                <p className="text-sm text-gray-500">
                  {filtered ? "Nothing matches these filters." : "Nothing has been changed from Punch View yet."}
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="history-table">
                  <thead>
                    <tr className="bg-slate-50 text-left">
                      {["When", "By", "Employee", "Day", "What changed", "Change", "Reason"].map((h) => (
                        <th
                          key={h}
                          className="whitespace-nowrap px-3 py-2 text-[11px] font-bold uppercase tracking-wide text-gray-500"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((it) => (
                      <tr
                        key={it.id}
                        className="border-t align-top hover:bg-slate-50/60"
                        data-testid={`history-row-${it.id}`}
                      >
                        <td className="whitespace-nowrap px-3 py-2 text-xs text-gray-600">{whenText(it.createdAt)}</td>
                        <td className="px-3 py-2 text-xs text-gray-700">
                          {it.actorName || "—"}
                          <span className="block text-[10px] text-gray-400">
                            {it.via === "import" ? "Excel upload" : "this page"}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className="font-semibold text-gray-900">{it.employeeName}</span>
                          <span className="block font-mono text-[11px] text-gray-500">{it.employeeCode}</span>
                        </td>
                        <td className="whitespace-nowrap px-3 py-2 text-xs">{it.date ?? ""}</td>
                        <td className="px-3 py-2">
                          <span
                            className={cn(
                              "inline-block whitespace-nowrap rounded-md border px-1.5 py-0.5 text-[10px] font-bold",
                              ACTION_TONE[it.action],
                            )}
                          >
                            {it.actionLabel}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <ValueView item={it} />
                        </td>
                        <td className="max-w-[18rem] px-3 py-2 text-xs text-gray-600">{it.note}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {total > 0 && (
          <DataPagination
            page={Math.min(page, pages)}
            totalPages={pages}
            totalItems={total}
            pageSize={pageSize}
            pageSizes={[25, 50, 100]}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </div>
    </HrLayout>
  );
}
