import { useMemo, useState } from "react";
import {
  Activity,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  Download,
  Search,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { Input } from "@/components/ui/input";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useAuth } from "@/contexts/AuthContext";
import { useHrActivity, type HrActivityFilters, type HrActivityRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ACTION_CHOICES, ACTION_TONE, actionLabel, changesOf, toCsv, when } from "./assistant-activity/logic";
import { StatCard } from "./account-management/parts";

const PAGE_SIZE = 50;

function Changes({ row }: { row: HrActivityRow }) {
  const changes = changesOf(row);
  if (!changes.length) return null;
  return (
    <ul className="mt-1 space-y-0.5 text-[11px] text-gray-500" data-testid={`activity-changes-${row.id}`}>
      {changes.slice(0, 6).map((c) => (
        <li key={c.field} className="break-words">
          <b className="font-semibold text-gray-600">{c.field}</b>:{" "}
          {c.before !== null ? (
            <>
              <span className="line-through decoration-gray-300">{c.before}</span> → {c.after}
            </>
          ) : (
            c.after
          )}
        </li>
      ))}
      {changes.length > 6 && <li>… {changes.length - 6} more</li>}
    </ul>
  );
}

function ActionChip({ action }: { action: string }) {
  return (
    <span
      className={cn(
        "inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold",
        ACTION_TONE[action] ?? "border-gray-200 bg-gray-50 text-gray-600",
      )}
    >
      {actionLabel(action)}
    </span>
  );
}

/** What the HR Assistants did (and, for the Super Admin, the HR Managers): Super Admin and HR Managers only. */
export default function AssistantActivity() {
  const { user } = useAuth();
  const allowed = !!user?.isSuperAdmin || user?.category === "hr_manager";
  const initial = useMemo(() => new URLSearchParams(typeof window !== "undefined" ? window.location.search : ""), []);
  const [category, setCategory] = useState<"hr_assistant" | "hr_manager">(
    initial.get("category") === "hr_manager" ? "hr_manager" : "hr_assistant",
  );
  const [accountId, setAccountId] = useState(initial.get("accountId") ?? "all");
  const [module, setModule] = useState("all");
  const [action, setAction] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const filters: HrActivityFilters = {
    category,
    accountId,
    module,
    action,
    dateFrom,
    dateTo,
    search: search.trim(),
    page,
    pageSize: PAGE_SIZE,
  };
  const { data, isLoading, error } = useHrActivity(filters, allowed);
  const rows = data?.results ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const filtered =
    accountId !== "all" || module !== "all" || action !== "all" || !!dateFrom || !!dateTo || !!search.trim();
  const who = category === "hr_manager" ? "HR Manager" : "HR Assistant";
  const change =
    <T,>(setter: (v: T) => void) =>
    (v: T) => {
      setter(v);
      setPage(1);
    };

  const exportCsv = () => {
    const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${category === "hr_manager" ? "hr-manager" : "hr-assistant"}-activity-page-${page}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-indigo-600 p-2.5 text-white shadow-sm">
              <Activity size={22} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-gray-900" data-testid="activity-title">
                {who} activity
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Every change, approval and sign-in by the {who}s
                {user?.isSuperAdmin
                  ? ""
                  : `${user?.branchName ? ` of ${user.branchName}` : ""}, in the modules you can open`}
                , newest first.
              </p>
            </div>
          </div>
          {data?.canSeeManagers && (
            <PillTabs
              size="sm"
              items={[
                { value: "hr_assistant", label: "HR Assistants", icon: <ClipboardList size={13} /> },
                { value: "hr_manager", label: "HR Managers", icon: <ShieldCheck size={13} /> },
              ]}
              value={category}
              onChange={(v) => {
                setCategory(v as typeof category);
                setAccountId("all");
                setModule("all");
                setPage(1);
              }}
            />
          )}
        </div>

        {!allowed ? (
          <Card className="rounded-2xl">
            <CardContent className="py-12 text-center text-sm text-muted-foreground">
              Only the Super Admin and HR Managers can review this activity.
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard
                testId="activity-stat-accounts"
                label={`${who}s`}
                value={data ? data.accounts.length : "—"}
                sub={data ? `${data.accounts.filter((a) => a.isActive).length} active` : undefined}
                icon={Users}
                tone="bg-violet-50 text-violet-800"
              />
              <StatCard
                testId="activity-stat-today"
                label="Today"
                value={data ? data.summary.today : "—"}
                sub="actions"
                icon={CalendarDays}
                tone="bg-slate-100 text-slate-800"
              />
              <StatCard
                testId="activity-stat-week"
                label="Last 7 days"
                value={data ? data.summary.last7Days : "—"}
                sub="actions"
                icon={Activity}
                tone="bg-blue-50 text-blue-800"
              />
              <StatCard
                testId="activity-stat-approvals"
                label="Approvals & rejections"
                value={data ? data.summary.approvals : "—"}
                sub="all time"
                icon={ShieldCheck}
                tone="bg-emerald-50 text-emerald-800"
              />
            </div>

            {/* ── filters ── */}
            <div className="space-y-2 rounded-2xl border bg-white p-3">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
                <Select value={accountId} onValueChange={change(setAccountId)}>
                  <SelectTrigger className="h-10" aria-label={`Filter by ${who}`} data-testid="activity-filter-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All {who}s</SelectItem>
                    {(data?.accounts ?? []).map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.fullName ? `${a.fullName} (${a.username})` : a.username}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={module} onValueChange={change(setModule)}>
                  <SelectTrigger className="h-10" aria-label="Filter by module" data-testid="activity-filter-module">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All modules</SelectItem>
                    {(data?.modules ?? []).map((m) => (
                      <SelectItem key={m.key} value={m.key}>
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select value={action} onValueChange={change(setAction)}>
                  <SelectTrigger className="h-10" aria-label="Filter by action" data-testid="activity-filter-action">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All actions</SelectItem>
                    {ACTION_CHOICES.map((a) => (
                      <SelectItem key={a} value={a}>
                        {actionLabel(a)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative">
                  <Search
                    size={15}
                    className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
                  />
                  <Input
                    value={search}
                    onChange={(e) => change(setSearch)(e.target.value)}
                    placeholder="Search what was done"
                    aria-label="Search activity"
                    className="h-10 pl-9"
                    data-testid="activity-search"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <label className="flex items-center gap-1.5">
                    From
                    <Input
                      type="date"
                      value={dateFrom}
                      onChange={(e) => change(setDateFrom)(e.target.value)}
                      className="h-9 w-[9.5rem]"
                      aria-label="From date"
                      data-testid="activity-from"
                    />
                  </label>
                  <label className="flex items-center gap-1.5">
                    to
                    <Input
                      type="date"
                      value={dateTo}
                      onChange={(e) => change(setDateTo)(e.target.value)}
                      className="h-9 w-[9.5rem]"
                      aria-label="To date"
                      data-testid="activity-to"
                    />
                  </label>
                  {filtered && (
                    <button
                      type="button"
                      onClick={() => {
                        setAccountId("all");
                        setModule("all");
                        setAction("all");
                        setDateFrom("");
                        setDateTo("");
                        setSearch("");
                        setPage(1);
                      }}
                      className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:underline"
                      data-testid="activity-clear"
                    >
                      <X size={12} /> Clear filters
                    </button>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={exportCsv}
                  disabled={!rows.length}
                  data-testid="activity-export"
                >
                  <Download size={14} /> Download CSV (this page)
                </Button>
              </div>
            </div>

            {/* ── the trail ── */}
            <Card className="overflow-hidden rounded-2xl">
              <CardContent className="p-0">
                {isLoading ? (
                  <CircleLoader texts={["UK Textiles", `${who} activity`, "Loading"]} />
                ) : error ? (
                  <div className="px-6 py-12 text-center text-sm text-rose-700">
                    {error instanceof Error ? error.message : "The activity could not be loaded."}
                  </div>
                ) : rows.length === 0 ? (
                  <div className="flex flex-col items-center gap-2 px-6 py-14 text-center" data-testid="activity-empty">
                    <div className="rounded-2xl bg-indigo-50 p-4 text-indigo-600">
                      <Activity size={26} />
                    </div>
                    <p className="font-bold text-gray-900">{filtered ? "Nothing matches" : "No activity yet"}</p>
                    <p className="max-w-sm text-sm text-muted-foreground">
                      {filtered
                        ? "Try another person, module or date range."
                        : `What the ${who}s change, approve and reject appears here as they work.`}
                    </p>
                  </div>
                ) : (
                  <>
                    <div className="hidden md:block">
                      <Table data-testid="activity-table">
                        <TableHeader>
                          <TableRow>
                            {["When", "Who", "Action", "Module", "What"].map((h) => (
                              <TableHead
                                key={h}
                                className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60"
                              >
                                {h}
                              </TableHead>
                            ))}
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {rows.map((r) => (
                            <TableRow key={r.id} data-testid={`activity-row-${r.id}`} className="align-top">
                              <TableCell className="whitespace-nowrap text-xs text-gray-500">{when(r.at)}</TableCell>
                              <TableCell>
                                <p className="text-sm font-semibold text-gray-900">{r.fullName || r.username}</p>
                                <p className="text-[11px] text-gray-500">{r.username}</p>
                              </TableCell>
                              <TableCell>
                                <ActionChip action={r.action} />
                              </TableCell>
                              <TableCell className="text-sm text-gray-700">{r.moduleLabel}</TableCell>
                              <TableCell className="max-w-[28rem]">
                                <p className="text-sm text-gray-800">
                                  {r.description}
                                  {r.recordId ? <span className="text-gray-400"> · #{r.recordId}</span> : null}
                                </p>
                                <Changes row={r} />
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                    <div className="divide-y md:hidden" data-testid="activity-cards">
                      {rows.map((r) => (
                        <div key={r.id} className="space-y-1.5 p-4">
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="text-sm font-semibold text-gray-900">{r.fullName || r.username}</p>
                              <p className="text-[11px] text-gray-500">
                                {when(r.at)} · {r.moduleLabel}
                              </p>
                            </div>
                            <ActionChip action={r.action} />
                          </div>
                          <p className="break-words text-sm text-gray-800">{r.description}</p>
                          <Changes row={r} />
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </CardContent>
            </Card>

            {data && data.total > data.pageSize && (
              <div className="flex items-center justify-between text-sm text-gray-600" data-testid="activity-pages">
                <span>
                  Page {page} of {pages} · {data.total} actions
                </span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft size={14} />
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= pages}
                    onClick={() => setPage((p) => Math.min(pages, p + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </HrLayout>
  );
}
