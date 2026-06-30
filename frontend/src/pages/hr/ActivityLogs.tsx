import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity, Search, LogIn, Plus, Edit, Trash2, CheckCircle,
  XCircle, Lock, FileDown, Calendar, Shield, RefreshCw,
  TrendingUp, AlertTriangle,
} from "lucide-react";
import { useListAuditLogs, useAuditLogStats } from "@/lib/api-client";

// ─── Config ───────────────────────────────────────────────────────────────────

const ACTION_CONFIG: Record<string, {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  cls: string;
  dot: string;
}> = {
  login:        { icon: LogIn,        label: "Login",       cls: "bg-blue-50 text-blue-700 border-blue-200",     dot: "bg-blue-500" },
  login_failed: { icon: AlertTriangle,label: "Login Failed",cls: "bg-orange-50 text-orange-700 border-orange-200",dot: "bg-orange-500" },
  create:       { icon: Plus,         label: "Create",      cls: "bg-emerald-50 text-emerald-700 border-emerald-200", dot: "bg-emerald-500" },
  update:       { icon: Edit,         label: "Update",      cls: "bg-amber-50 text-amber-700 border-amber-200",   dot: "bg-amber-500" },
  delete:       { icon: Trash2,       label: "Delete",      cls: "bg-red-50 text-red-700 border-red-200",         dot: "bg-red-500" },
  approve:      { icon: CheckCircle,  label: "Approve",     cls: "bg-green-50 text-green-700 border-green-200",   dot: "bg-green-500" },
  reject:       { icon: XCircle,      label: "Reject",      cls: "bg-rose-50 text-rose-700 border-rose-200",      dot: "bg-rose-500" },
  lock:         { icon: Lock,         label: "Lock",        cls: "bg-purple-50 text-purple-700 border-purple-200",dot: "bg-purple-500" },
  export:       { icon: FileDown,     label: "Export",      cls: "bg-gray-50 text-gray-700 border-gray-200",      dot: "bg-gray-500" },
};

const MODULE_LABELS: Record<string, string> = {
  auth: "Auth", employees: "Employees", payroll: "Payroll", leave: "Leave",
  attendance: "Attendance", shifts: "Shifts", reports: "Reports",
  settings: "Settings", user_management: "User Mgmt",
};

const MODULES = ["all", "auth", "employees", "payroll", "leave", "attendance", "shifts", "reports", "settings", "user_management"];
const ACTIONS = ["all", "login", "login_failed", "create", "update", "delete", "approve", "reject", "export"];
const PAGE_SIZE = 50;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function exportCsv(logs: any[]) {
  const header = ["ID", "Time", "User", "Action", "Module", "Description", "IP"];
  const rows = logs.map((l) => [
    l.id,
    l.createdAt ? fmtTime(l.createdAt) : "",
    l.userName,
    l.action,
    l.module,
    (l.recordDescription ?? "").replace(/,/g, ";"),
    l.ipAddress ?? "",
  ]);
  const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `activity-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── StatsCard ────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, color }: {
  label: string; value: number | string; sub?: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  color: string;
}) {
  return (
    <div className={`rounded-2xl p-4 flex items-start gap-3 ${color}`}>
      <div className="mt-0.5 opacity-80">
        <Icon size={18} />
      </div>
      <div>
        <p className="text-xs font-medium opacity-70">{label}</p>
        <p className="text-2xl font-black">{value}</p>
        {sub && <p className="text-xs opacity-60 mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function ActivityLogs() {
  const [search, setSearch]           = useState("");
  const [filterModule, setFilterModule] = useState("all");
  const [filterAction, setFilterAction] = useState("all");
  const [dateFrom, setDateFrom]       = useState("");
  const [dateTo, setDateTo]           = useState("");
  const [page, setPage]               = useState(1);

  const { data, isLoading, refetch } = useListAuditLogs({
    module:   filterModule !== "all" ? filterModule : undefined,
    action:   filterAction !== "all" ? filterAction : undefined,
    userName: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo:   dateTo || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const { data: stats } = useAuditLogStats();

  const logs = data?.results ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const topModule = stats?.byModule
    ? Object.entries(stats.byModule).sort((a, b) => b[1] - a[1])[0]
    : null;

  return (
    <HrLayout>
      <div className="space-y-6">

        {/* ── Header ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Activity Logs</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Complete audit trail — every login, create, update, delete and approval
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline" size="sm"
              className="gap-1.5 text-xs"
              onClick={() => refetch()}
            >
              <RefreshCw size={13} /> Refresh
            </Button>
            <Button
              variant="outline" size="sm"
              className="gap-1.5 text-xs"
              onClick={() => exportCsv(logs)}
              disabled={logs.length === 0}
            >
              <FileDown size={13} /> Export CSV
            </Button>
          </div>
        </div>

        {/* ── Stats ──────────────────────────────────────────────────────── */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard
            label="Today" value={stats?.today ?? 0}
            sub="events since midnight"
            icon={Calendar}
            color="bg-blue-50 text-blue-800"
          />
          <StatCard
            label="This Week" value={stats?.thisWeek ?? 0}
            sub="events since Monday"
            icon={TrendingUp}
            color="bg-emerald-50 text-emerald-800"
          />
          <StatCard
            label="Total Events" value={(stats?.total ?? 0).toLocaleString()}
            sub="all time"
            icon={Activity}
            color="bg-indigo-50 text-indigo-800"
          />
          <StatCard
            label="Top Module"
            value={topModule ? (MODULE_LABELS[topModule[0]] ?? topModule[0]) : "—"}
            sub={topModule ? `${topModule[1]} events` : "No data yet"}
            icon={Shield}
            color="bg-amber-50 text-amber-800"
          />
        </div>

        {/* ── Module breakdown bar ───────────────────────────────────────── */}
        {stats && Object.keys(stats.byModule).length > 0 && (
          <Card className="border-0 shadow-sm">
            <CardHeader className="pb-2">
              <CardTitle className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Events by Module</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {Object.entries(stats.byModule)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([mod, count]) => {
                  const pct = stats.total > 0 ? Math.round((count / stats.total) * 100) : 0;
                  return (
                    <div key={mod} className="flex items-center gap-3">
                      <span className="text-xs text-gray-500 w-24 shrink-0">
                        {MODULE_LABELS[mod] ?? mod}
                      </span>
                      <div className="flex-1 bg-gray-100 rounded-full h-1.5 overflow-hidden">
                        <div
                          className="h-1.5 rounded-full bg-blue-500 transition-all"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="text-xs text-gray-500 w-14 text-right">
                        {count.toLocaleString()} ({pct}%)
                      </span>
                    </div>
                  );
                })}
            </CardContent>
          </Card>
        )}

        {/* ── Action filter chips ────────────────────────────────────────── */}
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((action) => {
            const cfg = ACTION_CONFIG[action];
            const count = action !== "all" ? (stats?.byAction?.[action] ?? 0) : stats?.total;
            const active = filterAction === action;
            return (
              <button
                key={action}
                onClick={() => { setFilterAction(action); setPage(1); }}
                className={`flex items-center gap-1.5 px-3 py-1 text-xs rounded-full border transition-all ${
                  active
                    ? "bg-slate-800 text-white border-slate-800"
                    : "bg-white text-gray-600 border-gray-200 hover:border-gray-400"
                }`}
              >
                {action === "all" ? "All Actions" : (cfg?.label ?? action)}
                {count !== undefined && (
                  <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                    active ? "bg-white/20" : "bg-gray-100 text-gray-500"
                  }`}>
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* ── Filters ────────────────────────────────────────────────────── */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-3">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by user name…"
                  value={search}
                  onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                  className="pl-9 h-9 text-sm"
                />
              </div>
              <select
                value={filterModule}
                onChange={(e) => { setFilterModule(e.target.value); setPage(1); }}
                className="h-9 rounded-md border px-3 text-sm bg-background"
              >
                {MODULES.map((m) => (
                  <option key={m} value={m}>
                    {m === "all" ? "All Modules" : (MODULE_LABELS[m] ?? m)}
                  </option>
                ))}
              </select>
              <Input
                type="date" value={dateFrom}
                onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                className="h-9 text-sm" title="From date"
              />
              <Input
                type="date" value={dateTo}
                onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                className="h-9 text-sm" title="To date"
              />
            </div>
          </CardContent>
        </Card>

        {/* ── Log table ──────────────────────────────────────────────────── */}
        <div className="clay-card rounded-2xl overflow-hidden">
          <div className="px-5 py-3 flex items-center justify-between" style={{ borderBottom: "1px solid rgba(0,100,150,0.07)" }}>
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
              {isLoading ? "Loading…" : `${total.toLocaleString()} event${total !== 1 ? "s" : ""}`}
            </span>
          </div>

          {isLoading ? (
            <div className="divide-y divide-gray-50">
              {Array.from({ length: 8 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-5 py-3.5">
                  <Skeleton className="w-8 h-8 rounded-lg shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-48" />
                    <Skeleton className="h-3 w-72" />
                  </div>
                  <Skeleton className="h-3 w-28" />
                </div>
              ))}
            </div>
          ) : logs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 text-gray-400">
              <Activity size={40} className="opacity-20 mb-3" />
              <p className="text-sm font-medium text-gray-500">No activity logs found</p>
              <p className="text-xs mt-1">
                {total === 0
                  ? "Logs will appear here as you use the system — login, create employees, generate payroll, etc."
                  : "Try adjusting your filters"}
              </p>
            </div>
          ) : (
            <div className="divide-y divide-gray-50">
              {logs.map((log) => {
                const cfg = ACTION_CONFIG[log.action] ?? { icon: Activity, label: log.action, cls: "bg-gray-50 text-gray-700 border-gray-200", dot: "bg-gray-400" };
                const Icon = cfg.icon;
                return (
                  <div key={log.id} className="flex items-center gap-4 px-5 py-3 hover:bg-gray-50/60 transition-colors">
                    {/* Action icon */}
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border ${cfg.cls}`}>
                      <Icon size={13} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm text-gray-900">{log.userName}</span>
                        <Badge variant="outline" className={`text-[10px] px-1.5 py-0 border ${cfg.cls}`}>
                          {cfg.label}
                        </Badge>
                        <span className="text-xs text-gray-400">
                          {MODULE_LABELS[log.module] ?? log.module}
                        </span>
                      </div>
                      {log.recordDescription && (
                        <p className="text-xs text-gray-500 mt-0.5 truncate">{log.recordDescription}</p>
                      )}
                      {log.ipAddress && (
                        <p className="text-[10px] text-gray-300 mt-0.5">IP: {log.ipAddress}</p>
                      )}
                    </div>

                    {/* Time */}
                    <span className="text-xs text-gray-400 shrink-0 tabular-nums">
                      {log.createdAt ? fmtTime(log.createdAt) : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Pagination ─────────────────────────────────────────────────── */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-xs px-2">{page} / {totalPages}</span>
              <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          </div>
        )}
      </div>
    </HrLayout>
  );
}
