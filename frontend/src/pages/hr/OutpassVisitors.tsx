import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import QRCode from "qrcode";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import { KpiRunningBorder } from "@/components/ui/KpiLoader";
import { useAuth } from "@/contexts/AuthContext";
import {
  useListBranches, getListBranchesQueryKey,
  useOutpassQr, useOutpassSummary, useOutpassRecords,
  useVisitorQr, useVisitorSummary, useVisitorRecords,
  type GateRange, type GateSummary, type OutpassRecordRow, type VisitorRecordRow,
} from "@/lib/api-client/custom-hooks";
import {
  DoorOpen, UserRound, QrCode as QrCodeIcon, CalendarDays, CalendarRange, Calendar,
  Download, Eye, EyeOff,
} from "lucide-react";

const PAGE_SIZE = 20;
const RANGE_LABEL: Record<GateRange, string> = { today: "Today", week: "This Week", month: "This Month" };

function fmtDateTime(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

// ── KPI row ───────────────────────────────────────────────────────────────

function StatCard({
  icon: Icon, label, value, colorCls, accent, isLoading,
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
        <p className="flex h-9 items-center text-3xl font-black text-gray-900 leading-none">
          {isLoading ? "" : value}
        </p>
      </CardContent>
    </Card>
  );
}

function KpiRow({ summary, isLoading }: { summary: GateSummary | undefined; isLoading: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <StatCard icon={Calendar} label="Today" value={summary?.today ?? 0} colorCls="bg-sky-500" accent="#0ea5e9" isLoading={isLoading} />
      <StatCard icon={CalendarDays} label="This Week" value={summary?.thisWeek ?? 0} colorCls="bg-violet-500" accent="#8b5cf6" isLoading={isLoading} />
      <StatCard icon={CalendarRange} label="This Month" value={summary?.thisMonth ?? 0} colorCls="bg-amber-500" accent="#f59e0b" isLoading={isLoading} />
    </div>
  );
}

// ── Gate QR ───────────────────────────────────────────────────────────────

function GateQrDialog({ kind, token, branchName }: { kind: "outpass" | "visitor"; token?: string; branchName?: string }) {
  const [open, setOpen] = useState(false);
  const [qrImage, setQrImage] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const url = `${window.location.origin}/gate/${kind}/${token}`;
    QRCode.toDataURL(url, { width: 220, margin: 1, color: { dark: "#0f172a", light: "#ffffff" } }).then((img) => {
      if (!cancelled) setQrImage(img);
    });
    return () => { cancelled = true; };
  }, [open, token, kind]);

  const download = () => {
    if (!qrImage) return;
    const a = document.createElement("a");
    a.href = qrImage;
    a.download = `${kind}-gate-qr${branchName ? `-${branchName.toLowerCase().replace(/\s+/g, "-")}` : ""}.png`;
    a.click();
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="outline" size="sm" className="gap-1.5" disabled={!token} onClick={() => setOpen(true)}>
        <QrCodeIcon size={14} /> Gate QR
      </Button>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{kind === "outpass" ? "Outpass" : "Visitor"} Gate QR{branchName ? ` — ${branchName}` : ""}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col items-center gap-3 py-2">
          {qrImage ? (
            <img src={qrImage} alt="Gate QR code" className="rounded-lg border" width={220} height={220} />
          ) : (
            <div className="h-[220px] w-[220px] rounded-lg border bg-gray-50 animate-pulse" />
          )}
          <Button variant="outline" size="sm" className="gap-1.5" disabled={!qrImage} onClick={download}>
            <Download size={14} /> Download QR
          </Button>
          <p className="text-xs text-muted-foreground text-center max-w-xs">
            This QR is permanent for this branch — print it once and reuse it at the gate. Scanning it opens the{" "}
            {kind === "outpass" ? "outpass" : "visitor"} form on any phone, no login required.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Range filter ──────────────────────────────────────────────────────────

function RangeFilter({ value, onChange }: { value: GateRange; onChange: (v: GateRange) => void }) {
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

function useSelectedBranch(isBranchScoped: boolean) {
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const [branchId, setBranchId] = useState<string>("");
  useEffect(() => {
    if (!isBranchScoped && !branchId && branches && branches.length > 0) {
      setBranchId(String(branches[0].id));
    }
  }, [isBranchScoped, branches, branchId]);
  return { branches, branchId, setBranchId };
}

function BranchPicker({
  branches, branchId, setBranchId,
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
          <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Pagination footer ─────────────────────────────────────────────────────

function RecordsPagination({
  page, total, pageSize, onPageChange,
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
              onClick={(e) => { e.preventDefault(); if (pageSafe > 1) onPageChange(pageSafe - 1); }}
            />
          </PaginationItem>
          {Array.from({ length: totalPages }, (_, i) => i + 1).map((p) => (
            <PaginationItem key={p}>
              <PaginationLink href="#" isActive={p === pageSafe} onClick={(e) => { e.preventDefault(); onPageChange(p); }}>
                {p}
              </PaginationLink>
            </PaginationItem>
          ))}
          <PaginationItem>
            <PaginationNext
              href="#"
              className={pageSafe === totalPages ? "pointer-events-none opacity-50" : undefined}
              onClick={(e) => { e.preventDefault(); if (pageSafe < totalPages) onPageChange(pageSafe + 1); }}
            />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}

// ── Outpass tab ───────────────────────────────────────────────────────────

function OutpassTab({ isBranchScoped }: { isBranchScoped: boolean }) {
  const [range, setRange] = useState<GateRange>("today");
  const [page, setPage] = useState(1);
  const { branches, branchId, setBranchId } = useSelectedBranch(isBranchScoped);
  const effectiveBranchId = isBranchScoped ? undefined : (branchId ? Number(branchId) : undefined);

  const { data: qr } = useOutpassQr(effectiveBranchId);
  const { data: summary, isLoading: summaryLoading } = useOutpassSummary();
  const { data: page_, isLoading: recordsLoading } = useOutpassRecords(range, page, PAGE_SIZE);
  const records: OutpassRecordRow[] = page_?.items ?? [];

  const changeRange = (v: GateRange) => { setRange(v); setPage(1); };

  return (
    <div className="space-y-4">
      <KpiRow summary={summary} isLoading={summaryLoading} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeFilter value={range} onChange={changeRange} />
        <div className="flex items-center gap-2">
          {!isBranchScoped && <BranchPicker branches={branches} branchId={branchId} setBranchId={setBranchId} />}
          <GateQrDialog kind="outpass" token={qr?.token} branchName={qr?.branchName} />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Submitted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recordsLoading && !page_ ? (
                <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : !records.length ? (
                <TableRow><TableCell colSpan={5} className="text-center py-10 text-muted-foreground">No outpass records for {RANGE_LABEL[range].toLowerCase()}.</TableCell></TableRow>
              ) : (
                records.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.employeeName}</TableCell>
                    <TableCell>{r.employeeCode}</TableCell>
                    <TableCell>{r.destination}</TableCell>
                    <TableCell>{r.branchName ?? "—"}</TableCell>
                    <TableCell className="text-muted-foreground">{fmtDateTime(r.submittedAt)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          {page_ && <RecordsPagination page={page_.page} total={page_.total} pageSize={page_.pageSize} onPageChange={setPage} />}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Visitors tab ──────────────────────────────────────────────────────────

function VisitorsTab({ isBranchScoped }: { isBranchScoped: boolean }) {
  const [range, setRange] = useState<GateRange>("today");
  const [page, setPage] = useState(1);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const { branches, branchId, setBranchId } = useSelectedBranch(isBranchScoped);
  const effectiveBranchId = isBranchScoped ? undefined : (branchId ? Number(branchId) : undefined);

  const { data: qr } = useVisitorQr(effectiveBranchId);
  const { data: summary, isLoading: summaryLoading } = useVisitorSummary();
  const { data: page_, isLoading: recordsLoading } = useVisitorRecords(range, page, PAGE_SIZE);
  const records: VisitorRecordRow[] = page_?.items ?? [];

  const changeRange = (v: GateRange) => { setRange(v); setPage(1); };
  const toggleReveal = (id: number) => {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <KpiRow summary={summary} isLoading={summaryLoading} />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <RangeFilter value={range} onChange={changeRange} />
        <div className="flex items-center gap-2">
          {!isBranchScoped && <BranchPicker branches={branches} branchId={branchId} setBranchId={setBranchId} />}
          <GateQrDialog kind="visitor" token={qr?.token} branchName={qr?.branchName} />
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Visitor</TableHead>
                <TableHead>Phone</TableHead>
                <TableHead>Aadhaar</TableHead>
                <TableHead>Whom to Meet</TableHead>
                <TableHead>Purpose</TableHead>
                <TableHead>Branch</TableHead>
                <TableHead>Visited</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recordsLoading && !page_ ? (
                <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : !records.length ? (
                <TableRow><TableCell colSpan={7} className="text-center py-10 text-muted-foreground">No visitor records for {RANGE_LABEL[range].toLowerCase()}.</TableCell></TableRow>
              ) : (
                records.map((r) => {
                  const isRevealed = revealed.has(r.id);
                  return (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.name}</TableCell>
                      <TableCell>{r.phone}</TableCell>
                      <TableCell className="tracking-wider">
                        {r.aadhaarLast4 ? (
                          <button
                            type="button"
                            onClick={() => toggleReveal(r.id)}
                            className="inline-flex items-center gap-1.5 hover:text-foreground text-muted-foreground"
                            title={isRevealed ? "Hide Aadhaar number" : "Reveal Aadhaar number"}
                          >
                            <span className="font-mono">{isRevealed && r.aadhaar ? r.aadhaar : `••••${r.aadhaarLast4}`}</span>
                            {isRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                          </button>
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell>{r.whomToMeet}</TableCell>
                      <TableCell>{r.purpose}</TableCell>
                      <TableCell>{r.branchName ?? "—"}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDateTime(r.visitedAt)}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
          {page_ && <RecordsPagination page={page_.page} total={page_.total} pageSize={page_.pageSize} onPageChange={setPage} />}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function OutpassVisitors() {
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;
  const [location, navigate] = useLocation();
  // URL-driven, same convention as Attendance's Staff/Production split
  // (/hr/attendance/staff | /hr/attendance/production) -so the sidebar's
  // Outpass/Visitors children (dashboard-sidebar.tsx) deep-link straight
  // into the right tab of this one page.
  const tab: "outpass" | "visitors" = location.includes("/outpass-visitors/visitors") ? "visitors" : "outpass";
  const setTab = (v: "outpass" | "visitors") => navigate(`/hr/outpass-visitors/${v}`);

  return (
    <HrLayout>
      <div className="space-y-5">
        <div>
          <h2 className="text-2xl font-black flex items-center gap-2">
            <DoorOpen size={20} className="text-teal-600" /> Outpass / Visitors
          </h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Gate exit and front-desk visitor logs, collected via a permanent per-branch QR code -no attendance or payroll impact.
          </p>
        </div>

        <PillTabs
          items={[
            { value: "outpass", label: "Outpass", icon: <DoorOpen size={13} /> },
            { value: "visitors", label: "Visitors", icon: <UserRound size={13} /> },
          ]}
          value={tab}
          onChange={(v) => setTab(v as "outpass" | "visitors")}
          baseColor="#0f172a"
          pillBg="#f1f5f9"
        />

        {tab === "outpass" ? <OutpassTab isBranchScoped={isBranchScoped} /> : <VisitorsTab isBranchScoped={isBranchScoped} />}
      </div>
    </HrLayout>
  );
}
