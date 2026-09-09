import { useEffect, useState, type FormEvent } from "react";
import { useLocation } from "wouter";
import QRCode from "qrcode";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import {
  Pagination, PaginationContent, PaginationItem, PaginationLink,
  PaginationNext, PaginationPrevious,
} from "@/components/ui/pagination";
import { KpiRunningBorder } from "@/components/ui/KpiLoader";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListBranches, getListBranchesQueryKey,
  useOutpassQr, useOutpassSummary, useOutpassRecords,
  useVisitorQr, useVisitorSummary, useVisitorRecords,
  useListOutpassRequests, getListOutpassRequestsQueryKey, useUpdateOutpassRequestStatus,
  useListGateDevices, getListGateDevicesQueryKey,
  useCreateGateDevice, useUpdateGateDevice, useDeleteGateDevice,
  type GateRange, type GateSummary, type OutpassRecordRow, type VisitorRecordRow,
  type OutpassRequestItem, type OutpassScanStatus, type GateDevice,
} from "@/lib/api-client/custom-hooks";
import {
  DoorOpen, UserRound, QrCode as QrCodeIcon, CalendarDays, CalendarRange, Calendar,
  Download, Eye, EyeOff, ShieldCheck, Plus, Copy, KeyRound, Trash2,
  CheckCircle2, XCircle, Inbox,
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

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

// ── Gate Scanner device management ─────────────────────────────────────────
// A GateDevice is a completely different concept from the GateQr above: that
// one is a permanent, unauthenticated QR for the entry form; this is a real
// username/password login for a kiosk that scans an *approved* Outpass's own
// QR (see the "Approved Passes" table below) and records the employee's
// exit. See backend/api/gate_scanner_views.py.

function GateDeviceRow({
  gate, onToggleActive, onResetPassword, onDelete, isMutating,
}: {
  gate: GateDevice;
  onToggleActive: (gate: GateDevice, next: boolean) => void;
  onResetPassword: (gate: GateDevice) => void;
  onDelete: (gate: GateDevice) => void;
  isMutating: boolean;
}) {
  const { toast } = useToast();
  const loginUrl = `${window.location.origin}/gate-scanner/${gate.loginToken}`;

  const copyLink = () => {
    navigator.clipboard.writeText(loginUrl);
    toast({ title: "Login link copied" });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold">{gate.name}</p>
          <Badge
            variant={gate.isActive ? "default" : "secondary"}
            className={`text-[10px] ${gate.isActive ? "!bg-green-100 !text-green-700" : ""}`}
          >
            {gate.isActive ? "Active" : "Deactivated"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {gate.branchName ?? "No branch"} · Username: <span className="font-mono">{gate.username}</span>
          {gate.lastLoginAt && ` · Last login ${new Date(gate.lastLoginAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs px-2" onClick={copyLink}>
          <Copy size={12} /> Copy Login Link
        </Button>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs px-2" onClick={() => onResetPassword(gate)} disabled={isMutating}>
          <KeyRound size={12} /> Reset Password
        </Button>
        <Switch checked={gate.isActive} onCheckedChange={(v) => onToggleActive(gate, v)} disabled={isMutating} />
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs px-2 text-red-600 border-red-200 hover:bg-red-50" onClick={() => onDelete(gate)} disabled={isMutating}>
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  );
}

function GateDevicesDialog({ isBranchScoped, branches, defaultBranchId }: {
  isBranchScoped: boolean;
  branches: { id: number; name: string }[] | undefined;
  defaultBranchId?: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", branchId: defaultBranchId ?? "", username: "", password: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<GateDevice | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const { data: gates, isLoading } = useListGateDevices();
  const createMutation = useCreateGateDevice();
  const updateMutation = useUpdateGateDevice();
  const deleteMutation = useDeleteGateDevice();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListGateDevicesQueryKey() });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (form.name.trim().length < 1) return setFormError("Gate name is required.");
    if (!isBranchScoped && !form.branchId) return setFormError("Please select a branch.");
    if (form.username.trim().length < 3) return setFormError("Username must be at least 3 characters.");
    if (form.password.length < 6) return setFormError("Password must be at least 6 characters.");

    try {
      await createMutation.mutateAsync({
        name: form.name.trim(),
        branchId: form.branchId ? Number(form.branchId) : undefined,
        username: form.username.trim(),
        password: form.password,
      });
      toast({ title: `${form.name.trim()} created` });
      setForm({ name: "", branchId: defaultBranchId ?? "", username: "", password: "" });
      invalidate();
    } catch (err: any) {
      setFormError(err?.message ?? "Could not create gate profile");
    }
  };

  const toggleActive = async (gate: GateDevice, next: boolean) => {
    await updateMutation.mutateAsync({ id: gate.id, data: { isActive: next } });
    toast({ title: next ? `${gate.name} reactivated` : `${gate.name} deactivated` });
    invalidate();
  };

  const submitReset = async () => {
    if (!resetTarget) return;
    if (resetPassword.length < 6) return toast({ title: "Password must be at least 6 characters", variant: "destructive" });
    await updateMutation.mutateAsync({ id: resetTarget.id, data: { password: resetPassword } });
    toast({ title: `Password reset for ${resetTarget.name}` });
    setResetTarget(null);
    setResetPassword("");
  };

  const handleDelete = async (gate: GateDevice) => {
    if (!confirm(`Remove ${gate.name}? Its scan history is kept, but its login will stop working immediately.`)) return;
    await deleteMutation.mutateAsync(gate.id);
    toast({ title: `${gate.name} removed` });
    invalidate();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <ShieldCheck size={14} /> Manage Gates
        </Button>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Gate Scanner Devices</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-1 max-h-[70vh] overflow-y-auto">
            <div className="flex flex-col gap-2">
              {isLoading ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
              ) : !gates?.length ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No gates created yet.</p>
              ) : (
                gates.map((g) => (
                  <GateDeviceRow
                    key={g.id}
                    gate={g}
                    onToggleActive={toggleActive}
                    onResetPassword={(gate) => setResetTarget(gate)}
                    onDelete={handleDelete}
                    isMutating={updateMutation.isPending || deleteMutation.isPending}
                  />
                ))
              )}
            </div>

            <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded-xl border p-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Add a Gate</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="gate-name">Gate Name</Label>
                  <Input id="gate-name" placeholder="Gate 1" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
                </div>
                {!isBranchScoped && (
                  <div className="flex flex-col gap-1">
                    <Label>Branch</Label>
                    <Select value={form.branchId} onValueChange={(v) => setForm((f) => ({ ...f, branchId: v }))}>
                      <SelectTrigger><SelectValue placeholder="Select branch" /></SelectTrigger>
                      <SelectContent>
                        {branches?.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <Label htmlFor="gate-username">Username</Label>
                  <Input id="gate-username" value={form.username} onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))} />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="gate-password">Password</Label>
                  <Input id="gate-password" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} />
                </div>
              </div>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" className="gap-1.5" disabled={createMutation.isPending}>
                <Plus size={14} /> {createMutation.isPending ? "Creating…" : "Create Gate"}
              </Button>
            </form>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reset-password mini dialog */}
      {resetTarget && (
        <Dialog open onOpenChange={() => { setResetTarget(null); setResetPassword(""); }}>
          <DialogContent className="max-w-xs">
            <DialogHeader>
              <DialogTitle>Reset password for {resetTarget.name}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Input type="password" placeholder="New password" value={resetPassword} onChange={(e) => setResetPassword(e.target.value)} />
              <DialogFooter>
                <Button onClick={submitReset} disabled={updateMutation.isPending}>Save</Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
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

// ── Approved Passes (rich, approval-workflow view) ─────────────────────────
// Distinct from the OutpassRecord table below it: that one is every
// anonymous QR-form submission (no approval step at all). This one is every
// OutpassRequest -the approve/reject flow from earlier this session -now
// enriched with gate-scan/exit fields, which is where the fields the user
// actually asked for (approval status, gate, scan status, exit time) live.

const SCAN_STATUS_BADGE: Record<OutpassScanStatus, { label: string; cls: string }> = {
  not_applicable: { label: "—", cls: "bg-gray-50 text-gray-400 border-gray-200" },
  pending_exit: { label: "Awaiting Exit", cls: "bg-blue-50 text-blue-700 border-blue-200" },
  exited: { label: "Exited", cls: "bg-green-50 text-green-700 border-green-200" },
  expired_unscanned: { label: "Expired, Not Scanned", cls: "bg-red-50 text-red-700 border-red-200" },
};

const APPROVAL_STATUS_CLS: Record<string, string> = {
  pending: "bg-amber-50 text-amber-700 border-amber-200",
  approved: "bg-green-50 text-green-700 border-green-200",
  rejected: "bg-red-50 text-red-700 border-red-200",
};

// "hr" -> just "HR"; "dept_head" -> "HOD – <name>", the name coming straight
// from OutpassRequest.approved_by, never hardcoded; "system" is an On-Duty
// session's auto-approval (geo_attendance_views.py::_create_outpass_from_on_duty).
// Mirrors gate/GateScannerConsole.tsx's formatApprover so the same request
// reads the same way on both the gate console and this HR table.
function formatApprover(approverRole?: string | null, approvedBy?: string | null): string {
  if (!approvedBy && !approverRole) return "—";
  if (approverRole === "hr") return "HR";
  if (approverRole === "dept_head") return approvedBy ? `HOD – ${approvedBy}` : "HOD";
  if (approverRole === "system") return "On-Duty approval";
  return approvedBy ?? "—";
}

function ApprovedPassesSection() {
  const [page, setPage] = useState(1);
  const { data: requests, isLoading } = useListOutpassRequests();
  const rows: OutpassRequestItem[] = requests ?? [];
  // Client-side paging, same reasoning as OutpassRequestsSection below -this
  // endpoint also serves the Mobile/Web apps' own flat "my requests" array,
  // so it can't switch to a {items,total,page,pageSize} response shape
  // without breaking them.
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageRows = rows.slice((pageSafe - 1) * PAGE_SIZE, pageSafe * PAGE_SIZE);

  return (
    <Card>
      <CardContent className="p-0">
        <div className="flex items-center justify-between px-4 pt-4 pb-2">
          <div>
            <p className="font-bold text-sm">Approved Passes</p>
            <p className="text-xs text-muted-foreground">Every Outpass request, with live gate-scan/exit status.</p>
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Employee</TableHead>
                <TableHead>Department</TableHead>
                <TableHead>Destination</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Date / Time</TableHead>
                <TableHead>Expiry</TableHead>
                <TableHead>Approval</TableHead>
                <TableHead>Approved By</TableHead>
                <TableHead>Gate</TableHead>
                <TableHead>Scan Status</TableHead>
                <TableHead>Exit Time</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={11} className="text-center py-10 text-muted-foreground">Loading…</TableCell></TableRow>
              ) : !rows.length ? (
                <TableRow><TableCell colSpan={11} className="text-center py-10 text-muted-foreground">No outpass requests yet.</TableCell></TableRow>
              ) : (
                pageRows.map((r) => {
                  const scan = SCAN_STATUS_BADGE[r.scanStatus] ?? SCAN_STATUS_BADGE.not_applicable;
                  return (
                    <TableRow key={r.id}>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Avatar className="size-7">
                            <AvatarImage src={r.employee?.photoUrl ?? undefined} />
                            <AvatarFallback className="text-[10px]">{r.employee?.name?.[0] ?? "?"}</AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{r.employee?.name ?? `#${r.employeeId}`}</p>
                            <p className="text-xs text-muted-foreground">{r.employee?.employeeCode}</p>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{r.employee?.department ?? "—"}</TableCell>
                      <TableCell>{r.destination}</TableCell>
                      <TableCell className="max-w-[160px] truncate" title={r.reason}>{r.reason}</TableCell>
                      <TableCell className="text-muted-foreground">{fmtDateTime(r.createdAt)}</TableCell>
                      <TableCell className="text-muted-foreground">{r.expiresAt ? fmtDateTime(r.expiresAt) : "—"}</TableCell>
                      <TableCell>
                        <Badge className={`text-xs border ${APPROVAL_STATUS_CLS[r.status] ?? APPROVAL_STATUS_CLS.pending}`}>{r.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatApprover(r.approverRole, r.approvedBy)}</TableCell>
                      <TableCell>{r.exitGateName ?? "—"}</TableCell>
                      <TableCell><Badge className={`text-xs border ${scan.cls}`}>{scan.label}</Badge></TableCell>
                      <TableCell className="text-muted-foreground">{r.exitedAt ? fmtDateTime(r.exitedAt) : "—"}</TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </div>
        {rows.length > 0 && (
          <RecordsPagination page={pageSafe} total={rows.length} pageSize={PAGE_SIZE} onPageChange={setPage} />
        )}
      </CardContent>
    </Card>
  );
}

// ── Pending Outpass Requests (approve/reject, right here in the Outpass
//    section) -there's no notification/sidebar popup anywhere else in the
//    HRMS for a submitted Outpass request today, so this sub-tab is the
//    dedicated place to see and act on them without leaving this page.
//    Same hooks/endpoint as ApprovedPassesSection above and the general
//    Requests page (ApprovedRequests.tsx) -just filtered to pending and
//    laid out for acting on rather than auditing. ─────────────────────────

const REQUESTS_PAGE_SIZE = 5;

function OutpassRequestsSection() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const { data: requests, isLoading } = useListOutpassRequests("pending");
  const updateStatus = useUpdateOutpassRequestStatus();
  const pending: OutpassRequestItem[] = requests ?? [];
  // Client-side paging -this endpoint also serves the Mobile/Web apps' own
  // "my requests" list as a flat array, so it can't switch to a
  // {items,total,page,pageSize} shape without breaking them. A pending
  // queue is small enough that paging the already-fetched list is fine.
  const pageCount = Math.max(1, Math.ceil(pending.length / REQUESTS_PAGE_SIZE));
  const pageSafe = Math.min(page, pageCount);
  const pageItems = pending.slice((pageSafe - 1) * REQUESTS_PAGE_SIZE, pageSafe * REQUESTS_PAGE_SIZE);

  const act = async (id: number, status: "approved" | "rejected") => {
    try {
      await updateStatus.mutateAsync({ id, data: { status } });
      toast({ title: status === "approved" ? "Outpass approved" : "Outpass rejected" });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey() });
      queryClient.invalidateQueries({ queryKey: getListOutpassRequestsQueryKey("pending") });
    } catch {
      toast({ title: "Failed to update the request", variant: "destructive" });
    }
  };

  return (
    <Card>
      <CardContent className="p-0">
        <div className="px-4 pt-4 pb-2">
          <p className="font-bold text-sm">Pending Outpass Requests</p>
          <p className="text-xs text-muted-foreground">
            Submitted from the Mobile App / Employee Web App -approval from either the employee's HOD or HR is enough.
          </p>
        </div>
        <div className="divide-y">
          {isLoading ? (
            <p className="py-10 text-center text-sm text-muted-foreground">Loading…</p>
          ) : !pending.length ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center text-muted-foreground">
              <Inbox size={22} className="opacity-40" />
              <p className="text-sm">No pending outpass requests.</p>
            </div>
          ) : (
            pageItems.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <Avatar className="size-9 shrink-0">
                  <AvatarImage src={r.employee?.photoUrl ?? undefined} />
                  <AvatarFallback className="text-xs">{r.employee?.name?.[0] ?? "?"}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {r.employee?.name ?? `#${r.employeeId}`}
                    <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                      {r.employee?.employeeCode}{r.employee?.department && ` · ${r.employee.department}`}
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{r.destination} · {r.reason}</p>
                  <p className="text-[11px] text-muted-foreground/70">{fmtDateTime(r.createdAt)}</p>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm" variant="outline"
                    className="h-8 gap-1 border-green-200 text-green-700 hover:bg-green-50"
                    onClick={() => act(r.id, "approved")}
                    disabled={updateStatus.isPending}
                  >
                    <CheckCircle2 size={14} /> Approve
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="h-8 gap-1 border-red-200 text-red-600 hover:bg-red-50"
                    onClick={() => act(r.id, "rejected")}
                    disabled={updateStatus.isPending}
                  >
                    <XCircle size={14} /> Reject
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
        {pending.length > 0 && (
          <RecordsPagination page={pageSafe} total={pending.length} pageSize={REQUESTS_PAGE_SIZE} onPageChange={setPage} />
        )}
      </CardContent>
    </Card>
  );
}

// ── Outpass tab ───────────────────────────────────────────────────────────

function OutpassTab({ isBranchScoped }: { isBranchScoped: boolean }) {
  const [section, setSection] = useState<"overview" | "requests">("overview");
  const [range, setRange] = useState<GateRange>("today");
  const [page, setPage] = useState(1);
  const { branches, branchId, setBranchId } = useSelectedBranch(isBranchScoped);
  const effectiveBranchId = isBranchScoped ? undefined : (branchId ? Number(branchId) : undefined);

  const { data: qr } = useOutpassQr(effectiveBranchId);
  const { data: summary, isLoading: summaryLoading } = useOutpassSummary();
  const { data: page_, isLoading: recordsLoading } = useOutpassRecords(range, page, PAGE_SIZE);
  const records: OutpassRecordRow[] = page_?.items ?? [];
  // Shares its cache with OutpassRequestsSection's own identical call -this
  // is purely to badge the sub-tab with a live pending count.
  const { data: pendingRequests } = useListOutpassRequests("pending");

  const changeRange = (v: GateRange) => { setRange(v); setPage(1); };

  return (
    <div className="space-y-4">
      <PillTabs
        size="sm"
        items={[
          { value: "overview", label: "Overview" },
          { value: "requests", label: "Requests", count: pendingRequests?.length || undefined },
        ]}
        value={section}
        onChange={(v) => setSection(v as "overview" | "requests")}
        baseColor="#0f172a"
        pillBg="#f1f5f9"
      />

      {section === "requests" ? (
        <OutpassRequestsSection />
      ) : (
        <>
          <KpiRow summary={summary} isLoading={summaryLoading} />

          <div className="flex flex-wrap items-center justify-between gap-3">
            <RangeFilter value={range} onChange={changeRange} />
            <div className="flex items-center gap-2">
              {!isBranchScoped && <BranchPicker branches={branches} branchId={branchId} setBranchId={setBranchId} />}
              <GateDevicesDialog isBranchScoped={isBranchScoped} branches={branches} defaultBranchId={branchId} />
              <GateQrDialog kind="outpass" token={qr?.token} branchName={qr?.branchName} />
            </div>
          </div>

          <ApprovedPassesSection />

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
        </>
      )}
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
