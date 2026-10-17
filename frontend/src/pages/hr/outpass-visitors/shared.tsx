import { useEffect, useState } from "react";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { KpiRunningBorder } from "@/components/ui/KpiLoader";
import {
  useListBranches,
  getListBranchesQueryKey,
  type GateRange,
  type GateSummary,
} from "@/lib/api-client/custom-hooks";
import { Calendar, CalendarDays, CalendarRange } from "lucide-react";

export const PAGE_SIZE = 20;
export const RANGE_LABEL: Record<GateRange, string> = { today: "Today", week: "This Week", month: "This Month" };

export function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ── KPI row ───────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon,
  label,
  value,
  colorCls,
  accent,
  isLoading,
}: {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  value: number;
  colorCls: string;
  accent: string;
  isLoading?: boolean;
}) {
  return (
    <Card className="relative border">
      {isLoading && <KpiRunningBorder accent={accent} radius={12} />}
      <CardContent className="p-5">
        <div className="flex items-center justify-between mb-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-gray-500">{label}</p>
          <div className={`p-1.5 rounded-lg ${colorCls}`}>
            <Icon size={14} className="text-white" />
          </div>
        </div>
        <p className="flex h-9 items-center text-3xl font-black text-gray-900 leading-none">{isLoading ? "" : value}</p>
      </CardContent>
    </Card>
  );
}

export function KpiRow({ summary, isLoading }: { summary: GateSummary | undefined; isLoading: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard
        icon={Calendar}
        label="Today"
        value={summary?.today ?? 0}
        colorCls="bg-sky-500"
        accent="#0ea5e9"
        isLoading={isLoading}
      />
      <StatCard
        icon={CalendarDays}
        label="This Week"
        value={summary?.thisWeek ?? 0}
        colorCls="bg-violet-500"
        accent="#8b5cf6"
        isLoading={isLoading}
      />
      <StatCard
        icon={CalendarRange}
        label="This Month"
        value={summary?.thisMonth ?? 0}
        colorCls="bg-amber-500"
        accent="#f59e0b"
        isLoading={isLoading}
      />
    </div>
  );
}

// ── Range filter ──────────────────────────────────────────────────────────

export function RangeFilter({ value, onChange }: { value: GateRange; onChange: (v: GateRange) => void }) {
  return (
    <PillTabs
      size="sm"
      items={(["today", "week", "month"] as GateRange[]).map((r) => ({ value: r, label: RANGE_LABEL[r] }))}
      value={value}
      onChange={(v) => onChange(v as GateRange)}
      baseColor="#0f172a"
      pillBg="#f1f5f9"
    />
  );
}

// ── Branch picker (unscoped/super-admin only) ────────────────────────────

export function useSelectedBranch(isBranchScoped: boolean) {
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const [branchId, setBranchId] = useState<string>("");
  useEffect(() => {
    if (!isBranchScoped && !branchId && branches && branches.length > 0) {
      setBranchId(String(branches[0].id));
    }
  }, [isBranchScoped, branches, branchId]);
  return { branches, branchId, setBranchId };
}

export function BranchPicker({
  branches,
  branchId,
  setBranchId,
}: {
  branches: { id: number; name: string }[] | undefined;
  branchId: string;
  setBranchId: (v: string) => void;
}) {
  return (
    <Select value={branchId} onValueChange={setBranchId}>
      <SelectTrigger className="w-full sm:w-52">
        <SelectValue placeholder="Select branch" />
      </SelectTrigger>
      <SelectContent>
        {branches?.map((b) => (
          <SelectItem key={b.id} value={String(b.id)}>
            {b.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Pagination footer ─────────────────────────────────────────────────────

export function RecordsPagination({
  page,
  total,
  pageSize,
  onPageChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const pageSafe = Math.min(page, totalPages);
  if (totalPages <= 1) return null;

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between border-t">
      <p className="text-xs text-muted-foreground">
        Showing {(pageSafe - 1) * pageSize + 1}–{Math.min(pageSafe * pageSize, total)} of {total}
      </p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious
              href="#"
              className={pageSafe === 1 ? "pointer-events-none opacity-50" : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (pageSafe > 1) onPageChange(pageSafe - 1);
              }}
            />
          </PaginationItem>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <PaginationItem key={p}>
              <PaginationLink
                href="#"
                isActive={p === pageSafe}
                onClick={(e) => {
                  e.preventDefault();
                  onPageChange(p);
                }}
              >
                {p}
              </PaginationLink>
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              href="#"
              className={pageSafe === totalPages ? "pointer-events-none opacity-50" : undefined}
              onClick={(e) => {
                e.preventDefault();
                if (pageSafe < totalPages) onPageChange(pageSafe + 1);
              }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

// A timestamp as date over time. Kept on two short lines that never wrap, so a column of them lines
// up row after row instead of breaking into a four-line block ("25 / Sept, / 12:36 / pm").
export function DateTimeStack({ iso }: { iso?: string | null }) {
  if (!iso) return <span className="text-muted-foreground">—</span>;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return <span className="whitespace-nowrap">{iso}</span>;
  return (
    <div className="leading-tight whitespace-nowrap">
      <p className="font-medium">{d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" })}</p>
      <p className="text-xs text-muted-foreground">
        {d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
      </p>
    </div>
  );
}

// Fixed column widths + one shared horizontal padding: every header sits exactly over its cells.
export const PASS_TH = "px-4 whitespace-nowrap";
export const PASS_TD = "px-4 py-3 align-middle";
