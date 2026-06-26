import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Activity, Search, LogIn, Plus, Edit, Trash2, CheckCircle,
  XCircle, Lock, FileDown,
} from "lucide-react";
import { useListAuditLogs } from "@/lib/api-client";

const ACTION_CONFIG: Record<string, { icon: React.ComponentType<{ size?: number; className?: string }>; cls: string }> = {
  login:   { icon: LogIn,        cls: "bg-blue-50 text-blue-700" },
  create:  { icon: Plus,         cls: "bg-green-50 text-green-700" },
  update:  { icon: Edit,         cls: "bg-amber-50 text-amber-700" },
  delete:  { icon: Trash2,       cls: "bg-red-50 text-red-700" },
  approve: { icon: CheckCircle,  cls: "bg-emerald-50 text-emerald-700" },
  reject:  { icon: XCircle,      cls: "bg-orange-50 text-orange-700" },
  lock:    { icon: Lock,         cls: "bg-purple-50 text-purple-700" },
  export:  { icon: FileDown,     cls: "bg-gray-50 text-gray-700" },
};

const MODULES = ["all", "auth", "employees", "payroll", "leave", "attendance", "shifts", "reports", "settings"];
const ACTIONS = ["all", "login", "create", "update", "delete", "approve", "reject", "lock", "export"];

export default function ActivityLogs() {
  const [search, setSearch] = useState("");
  const [filterModule, setFilterModule] = useState("all");
  const [filterAction, setFilterAction] = useState("all");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;

  const { data, isLoading } = useListAuditLogs({
    module: filterModule !== "all" ? filterModule : undefined,
    action: filterAction !== "all" ? filterAction : undefined,
    userName: search || undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
    page,
    pageSize: PAGE_SIZE,
  });

  const logs = data?.results ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Activity Logs</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Complete audit trail of all HR system actions
            </p>
          </div>
          <Activity size={24} className="text-muted-foreground" />
        </div>

        {/* Filters */}
        <Card className="border-0 shadow-sm">
          <CardContent className="p-4">
            <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3">
              <div className="relative">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Search by user…"
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
                  <option key={m} value={m}>{m === "all" ? "All Modules" : m}</option>
                ))}
              </select>
              <select
                value={filterAction}
                onChange={(e) => { setFilterAction(e.target.value); setPage(1); }}
                className="h-9 rounded-md border px-3 text-sm bg-background"
              >
                {ACTIONS.map((a) => (
                  <option key={a} value={a}>{a === "all" ? "All Actions" : a}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => { setDateFrom(e.target.value); setPage(1); }}
                  className="h-9 text-sm"
                  title="From date"
                />
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => { setDateTo(e.target.value); setPage(1); }}
                  className="h-9 text-sm"
                  title="To date"
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Log List */}
        <div className="space-y-2">
          {isLoading ? (
            Array.from({ length: 6 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-4 w-48 mb-2" />
                  <Skeleton className="h-3 w-72" />
                </CardContent>
              </Card>
            ))
          ) : logs.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <CardContent className="p-10 flex flex-col items-center text-center">
                <Activity size={32} className="text-muted-foreground/30 mb-3" />
                <p className="font-semibold text-gray-700">No activity logs found</p>
                <p className="text-sm text-muted-foreground mt-1">Try adjusting your filters</p>
              </CardContent>
            </Card>
          ) : (
            logs.map((log) => {
              const cfg = ACTION_CONFIG[log.action] ?? { icon: Activity, cls: "bg-gray-50 text-gray-700" };
              const Icon = cfg.icon;
              return (
                <Card key={log.id} className="border-0 shadow-sm hover:shadow-md transition-shadow">
                  <CardContent className="p-4">
                    <div className="flex items-start gap-3">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${cfg.cls}`}>
                        <Icon size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm text-gray-900">{log.userName}</span>
                          <Badge variant="outline" className="text-xs capitalize">{log.action}</Badge>
                          <Badge variant="secondary" className="text-xs">{log.module}</Badge>
                          <span className="text-xs text-muted-foreground ml-auto shrink-0">
                            {log.createdAt
                              ? new Date(log.createdAt).toLocaleString("en-IN", {
                                  day: "2-digit", month: "short", year: "numeric",
                                  hour: "2-digit", minute: "2-digit",
                                })
                              : ""}
                          </span>
                        </div>
                        {log.recordDescription && (
                          <p className="text-sm text-gray-600 mt-1">{log.recordDescription}</p>
                        )}
                        {log.ipAddress && (
                          <p className="text-xs text-muted-foreground/60 mt-0.5">IP: {log.ipAddress}</p>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* Pagination */}
        {total > PAGE_SIZE && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} of {total}
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
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
