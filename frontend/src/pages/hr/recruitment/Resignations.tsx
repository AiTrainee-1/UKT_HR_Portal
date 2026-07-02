import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  useListResignations, useResignationAction, useResignationEmail,
  useDeleteResignation, downloadResignationPdf,
  getListResignationsQueryKey, type ResignationRequest,
} from "@/lib/api-client";
import { useAuth } from "@/contexts/AuthContext";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import {
  Clock, CheckCircle2, XCircle, Eye, FileDown, Mail,
  CheckCircle, AlertTriangle, Trash2,
} from "lucide-react";

// ── Survey Questions ─────────────────────────────────────────────────────────

const SURVEY_QUESTIONS = [
  "What is your primary reason for leaving the company?",
  "Would you recommend this company as a place to work?",
  "Is there anything we could have done to retain you?",
];

// ── 3-Step Progress Indicator ────────────────────────────────────────────────

type StepState = "done" | "active" | "rejected" | "waiting";

function Step({
  label, state, sublabel, last,
}: {
  label: string; state: StepState; sublabel?: string; last?: boolean;
}) {
  const colors: Record<StepState, { bg: string; text: string; border: string }> = {
    done:     { bg: "#059669", text: "white", border: "#059669" },
    active:   { bg: "#d97706", text: "white", border: "#d97706" },
    rejected: { bg: "#dc2626", text: "white", border: "#dc2626" },
    waiting:  { bg: "#f0f4f8", text: "#94a3b8", border: "#cbd5e1" },
  };
  const c = colors[state];
  const icon =
    state === "done"     ? <CheckCircle2 className="w-3 h-3" /> :
    state === "active"   ? <Clock className="w-3 h-3" /> :
    state === "rejected" ? <XCircle className="w-3 h-3" /> :
    <span className="w-2 h-2 rounded-full bg-slate-300 inline-block" />;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex flex-col items-center gap-0.5">
        <div
          className="flex items-center justify-center w-6 h-6 rounded-full text-[10px] font-bold"
          style={{ background: c.bg, color: c.text, border: `2px solid ${c.border}` }}
        >
          {icon}
        </div>
        <span className="text-[9px] font-semibold text-center leading-tight" style={{ color: c.border, maxWidth: "56px" }}>
          {label}
        </span>
        {sublabel && (
          <span className="text-[8px] text-center text-slate-400 leading-tight" style={{ maxWidth: "56px" }}>
            {sublabel}
          </span>
        )}
      </div>
      {!last && (
        <div
          className="w-8 h-0.5 mb-4 shrink-0"
          style={{ background: state === "done" || state === "rejected" ? c.border : "#e2e8f0" }}
        />
      )}
    </div>
  );
}

function ResignationProgress({ r }: { r: ResignationRequest }) {
  const step1State: StepState = "done";

  let step2State: StepState;
  let step2Sub: string | undefined;
  if (r.status === "pending") {
    step2State = "active"; step2Sub = "Pending";
  } else if (r.status === "dept_approved" || r.status === "approved") {
    step2State = "done";
    step2Sub = r.deptHeadName ? `By ${r.deptHeadName.split(" ")[0]}` : undefined;
  } else if (r.status === "rejected" && r.rejectedBy === "dept_head") {
    step2State = "rejected"; step2Sub = "Rejected";
  } else {
    step2State = "done";
  }

  let step3State: StepState;
  let step3Sub: string | undefined;
  if (r.status === "pending") {
    step3State = "waiting"; step3Sub = "Not reached";
  } else if (r.status === "dept_approved") {
    step3State = "active"; step3Sub = "Pending";
  } else if (r.status === "approved") {
    step3State = "done";
    step3Sub = r.approvedBy ? `By ${r.approvedBy.split(" ")[0]}` : undefined;
  } else if (r.status === "rejected" && r.rejectedBy === "hr") {
    step3State = "rejected"; step3Sub = "Rejected";
  } else if (r.status === "rejected" && r.rejectedBy === "dept_head") {
    step3State = "waiting"; step3Sub = "Not reached";
  } else {
    step3State = "waiting";
  }

  return (
    <div className="flex items-start">
      <Step label="Submitted" state={step1State} />
      <Step label="Dept Head" state={step2State} sublabel={step2Sub} />
      <Step label="HR Final" state={step3State} sublabel={step3Sub} last />
    </div>
  );
}

// ── Status Badge ──────────────────────────────────────────────────────────────

function statusBadge(status: string) {
  if (status === "approved")
    return <Badge className="text-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200">Approved</Badge>;
  if (status === "rejected")
    return <Badge className="text-[10px] bg-red-50 text-red-600 border border-red-200">Rejected</Badge>;
  if (status === "dept_approved")
    return <Badge className="text-[10px] bg-blue-50 text-blue-700 border border-blue-200">Dept Approved</Badge>;
  return <Badge className="text-[10px] bg-amber-50 text-amber-700 border border-amber-200">Pending</Badge>;
}

// ── Resignation Table ─────────────────────────────────────────────────────────

function ResignationTable({
  rows, isLoading, emptyLabel, showApproveReject,
  onView, onApprove, onReject, onPdf, onEmail, onDelete,
  pdfLoading, emailLoading,
}: {
  rows: ResignationRequest[];
  isLoading: boolean;
  emptyLabel: string;
  showApproveReject: boolean;
  onView: (r: ResignationRequest) => void;
  onApprove: (r: ResignationRequest) => void;
  onReject: (r: ResignationRequest) => void;
  onPdf: (r: ResignationRequest) => void;
  onEmail: (r: ResignationRequest) => void;
  onDelete: (r: ResignationRequest) => void;
  pdfLoading: number | null;
  emailLoading: number | null;
}) {
  if (isLoading)
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-xl" />)}
      </div>
    );

  if (rows.length === 0)
    return <div className="py-14 text-center text-[#006496]/40 text-sm">{emptyLabel}</div>;

  return (
    <Table>
      <TableHeader>
        <TableRow style={{ borderColor: "rgba(0,100,150,0.07)" }}>
          <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[#006496]/50">Employee</TableHead>
          <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[#006496]/50">Dept</TableHead>
          <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[#006496]/50">Progress</TableHead>
          <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[#006496]/50">Last Day</TableHead>
          <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[#006496]/50">Submitted</TableHead>
          <TableHead className="text-[10px] font-bold uppercase tracking-wider text-[#006496]/50">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} style={{ borderColor: "rgba(0,100,150,0.05)" }} className="hover:bg-[#006496]/[0.02]">
            <TableCell>
              <div>
                <p className="font-semibold text-sm text-[#1a3a4a]">{r.employeeName ?? "—"}</p>
                <p className="text-[10px] text-[#006496]/50">{r.employeeCode}</p>
              </div>
            </TableCell>
            <TableCell className="text-sm text-[#1a3a4a]">{r.departmentName ?? "—"}</TableCell>
            <TableCell><ResignationProgress r={r} /></TableCell>
            <TableCell className="text-sm text-[#1a3a4a]">{r.lastWorkingDate ?? "—"}</TableCell>
            <TableCell className="text-sm text-[#006496]/60">
              {r.createdAt ? new Date(r.createdAt).toLocaleDateString() : "—"}
            </TableCell>
            <TableCell>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => onView(r)}>
                  <Eye className="w-3 h-3 mr-1" />View
                </Button>

                {r.status === "approved" && (
                  <Button
                    size="sm" variant="outline"
                    className="h-7 px-2 text-xs border-blue-200 text-blue-700 hover:bg-blue-50"
                    onClick={() => onPdf(r)} disabled={pdfLoading === r.id}
                  >
                    <FileDown className="w-3 h-3 mr-1" />{pdfLoading === r.id ? "…" : "PDF"}
                  </Button>
                )}

                {r.status === "approved" && (
                  <Button
                    size="sm" variant="outline"
                    className="h-7 px-2 text-xs border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                    onClick={() => onEmail(r)} disabled={emailLoading === r.id}
                  >
                    <Mail className="w-3 h-3 mr-1" />{emailLoading === r.id ? "…" : "Email"}
                  </Button>
                )}

                {showApproveReject && r.status === "dept_approved" && (
                  <Button
                    size="sm"
                    className="h-7 px-2 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
                    onClick={() => onApprove(r)}
                  >
                    <CheckCircle className="w-3 h-3 mr-1" />Approve
                  </Button>
                )}
                {showApproveReject && (r.status === "pending" || r.status === "dept_approved") && (
                  <Button size="sm" variant="destructive" className="h-7 px-2 text-xs" onClick={() => onReject(r)}>
                    Reject
                  </Button>
                )}

                <Button
                  size="sm" variant="ghost"
                  className="h-7 px-2 text-xs text-red-500 hover:bg-red-50 hover:text-red-600"
                  onClick={() => onDelete(r)}
                >
                  <Trash2 className="w-3 h-3" />
                </Button>
              </div>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export default function Resignations() {
  const [selected, setSelected] = useState<ResignationRequest | null>(null);
  const [actionType, setActionType] = useState<"approve" | "reject" | null>(null);
  const [hrComment, setHrComment] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ResignationRequest | null>(null);
  const [emailLoading, setEmailLoading] = useState<number | null>(null);
  const [pdfLoading, setPdfLoading] = useState<number | null>(null);

  const { token } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: allData, isLoading } = useListResignations(undefined);
  const actionMutation = useResignationAction();
  const emailMutation = useResignationEmail();
  const deleteMutation = useDeleteResignation();

  const refresh = () => {
    [undefined, "pending", "dept_approved", "approved", "rejected"].forEach((s) =>
      queryClient.invalidateQueries({ queryKey: getListResignationsQueryKey(s) }),
    );
    queryClient.invalidateQueries({ queryKey: ["/api/recruitment/dashboard"] });
  };

  const all      = allData ?? [];
  const active   = all.filter((r) => r.status === "pending" || r.status === "dept_approved");
  const approved = all.filter((r) => r.status === "approved");
  const rejected = all.filter((r) => r.status === "rejected");

  const pendingCount  = all.filter((r) => r.status === "pending").length;
  const deptApproved  = all.filter((r) => r.status === "dept_approved").length;

  const handleAction = () => {
    if (!selected || !actionType) return;
    actionMutation.mutate(
      { id: selected.id, action: actionType, hrComment: hrComment || undefined },
      {
        onSuccess: () => {
          toast({
            title: actionType === "approve" ? "Resignation Approved" : "Resignation Rejected",
            description:
              actionType === "approve"
                ? `${selected.employeeName}'s account has been deactivated.`
                : `${selected.employeeName}'s resignation was rejected.`,
          });
          setConfirmOpen(false);
          setSelected(null);
          setActionType(null);
          setHrComment("");
          refresh();
        },
        onError: (err: any) => {
          toast({ title: "Action failed", description: err?.message, variant: "destructive" });
          setConfirmOpen(false);
        },
      },
    );
  };

  const handleDelete = () => {
    if (!deleteTarget) return;
    deleteMutation.mutate(deleteTarget.id, {
      onSuccess: () => {
        toast({ title: "Deleted", description: `${deleteTarget.employeeName}'s resignation request has been removed.` });
        setDeleteTarget(null);
        refresh();
      },
      onError: (err: any) => {
        toast({ title: "Delete failed", description: err?.message, variant: "destructive" });
        setDeleteTarget(null);
      },
    });
  };

  const handlePdf = async (r: ResignationRequest) => {
    if (pdfLoading) return;
    setPdfLoading(r.id);
    try {
      await downloadResignationPdf(r.id, () => token);
    } catch (e: any) {
      toast({ title: "PDF Error", description: e.message, variant: "destructive" });
    } finally {
      setPdfLoading(null);
    }
  };

  const handleEmail = (r: ResignationRequest) => {
    if (emailLoading) return;
    setEmailLoading(r.id);
    emailMutation.mutate(
      { id: r.id },
      {
        onSuccess: (data) => {
          toast({ title: "Email Sent", description: `Sent to ${data.sentTo}` });
          setEmailLoading(null);
        },
        onError: (err: any) => {
          toast({ title: "Email failed", description: err?.message, variant: "destructive" });
          setEmailLoading(null);
        },
      },
    );
  };

  const tableProps = {
    isLoading,
    onView: setSelected,
    onApprove: (r: ResignationRequest) => { setSelected(r); setActionType("approve"); setConfirmOpen(true); },
    onReject:  (r: ResignationRequest) => { setSelected(r); setActionType("reject");  setConfirmOpen(true); },
    onPdf: handlePdf,
    onEmail: handleEmail,
    onDelete: setDeleteTarget,
    pdfLoading,
    emailLoading,
  };

  return (
    <HrLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-black text-[#1a3a4a] tracking-tight">Resignations</h1>
          <p className="text-sm text-[#006496]/60 mt-0.5">
            Three-stage workflow: Employee submits → Department Head reviews → HR gives final approval.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: "Dept Head Review", value: pendingCount,      icon: Clock,         color: "#d97706", urgent: pendingCount > 0 },
            { label: "Awaiting HR",      value: deptApproved,      icon: AlertTriangle, color: "#0891b2", urgent: deptApproved > 0 },
            { label: "Approved",         value: approved.length,   icon: CheckCircle2,  color: "#059669" },
            { label: "Rejected",         value: rejected.length,   icon: XCircle,       color: "#dc2626" },
          ].map(({ label, value, icon: Icon, color, urgent }) => (
            <Card
              key={label}
              className="rounded-2xl"
              style={{
                background: "#ffffff",
                boxShadow: "5px 5px 12px rgba(0,100,150,0.09), -3px -3px 9px rgba(255,255,255,0.9)",
                border: urgent ? `1.5px solid ${color}33` : "1px solid rgba(0,100,150,0.06)",
              }}
            >
              <CardContent className="p-4 flex items-center gap-3">
                <div className="p-2 rounded-xl shrink-0" style={{ background: color + "18" }}>
                  <Icon className="w-4 h-4" style={{ color }} strokeWidth={1.8} />
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-[#006496]/50 leading-none">{label}</p>
                  <p className="text-xl font-black text-[#1a3a4a]">{value}</p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Workflow reminder */}
        <div className="rounded-2xl px-4 py-3 flex items-start gap-4"
          style={{ background: "rgba(0,100,150,0.04)", border: "1px solid rgba(0,100,150,0.1)" }}>
          <div className="flex items-center gap-1.5 pt-0.5 shrink-0">
            <Step label="Employee" state="done" />
            <Step label="Dept Head" state="active" />
            <Step label="HR Final" state="waiting" last />
          </div>
          <div className="text-xs text-[#006496]/70 leading-relaxed">
            <p><strong>Pending</strong> — Waiting for Department Head to review.</p>
            <p><strong>Dept Approved</strong> — Dept Head approved, HR can now give final decision.</p>
            <p><strong>HR can reject at any stage.</strong> HR can only approve after Dept Head approves.</p>
          </div>
        </div>

        {/* Tabbed table */}
        <Card
          className="rounded-2xl overflow-hidden"
          style={{
            background: "#ffffff",
            boxShadow: "6px 6px 14px rgba(0,100,150,0.08), -4px -4px 10px rgba(255,255,255,0.9)",
            border: "1px solid rgba(0,100,150,0.06)",
          }}
        >
          <Tabs defaultValue="active">
            <div className="px-4 pt-4 border-b border-[#006496]/06">
              <TabsList className="bg-[#f0f4f8] h-9 p-1 gap-1">
                <TabsTrigger value="active" className="text-xs h-7 px-3 data-[state=active]:bg-white data-[state=active]:shadow-sm">
                  Active
                  {active.length > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700">
                      {active.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="approved" className="text-xs h-7 px-3 data-[state=active]:bg-white data-[state=active]:shadow-sm">
                  Approved
                  {approved.length > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-700">
                      {approved.length}
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="rejected" className="text-xs h-7 px-3 data-[state=active]:bg-white data-[state=active]:shadow-sm">
                  Rejected
                  {rejected.length > 0 && (
                    <span className="ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-600">
                      {rejected.length}
                    </span>
                  )}
                </TabsTrigger>
              </TabsList>
            </div>

            <TabsContent value="active" className="mt-0">
              <ResignationTable {...tableProps} rows={active} emptyLabel="No active resignation requests." showApproveReject />
            </TabsContent>

            <TabsContent value="approved" className="mt-0">
              <ResignationTable {...tableProps} rows={approved} emptyLabel="No approved resignations." showApproveReject={false} />
            </TabsContent>

            <TabsContent value="rejected" className="mt-0">
              <ResignationTable {...tableProps} rows={rejected} emptyLabel="No rejected resignations." showApproveReject={false} />
            </TabsContent>
          </Tabs>
        </Card>
      </div>

      {/* ── Detail Dialog ── */}
      <Dialog open={!!selected && !confirmOpen} onOpenChange={() => setSelected(null)}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Resignation Details</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4">
              <div className="bg-[#f0f4f8] rounded-xl p-3">
                <p className="text-[10px] font-bold text-[#006496]/50 uppercase tracking-wider mb-2">Approval Progress</p>
                <ResignationProgress r={selected} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-[10px] text-[#006496]/50 uppercase tracking-wider font-semibold mb-0.5">Employee</p>
                  <p className="text-sm font-bold text-[#1a3a4a]">{selected.employeeName}</p>
                  <p className="text-[11px] text-[#006496]/50">{selected.employeeCode}</p>
                </div>
                <div>
                  <p className="text-[10px] text-[#006496]/50 uppercase tracking-wider font-semibold mb-0.5">Department</p>
                  <p className="text-sm text-[#1a3a4a]">{selected.departmentName ?? "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] text-[#006496]/50 uppercase tracking-wider font-semibold mb-0.5">Last Working Day</p>
                  <p className="text-sm text-[#1a3a4a]">{selected.lastWorkingDate ?? "Not specified"}</p>
                </div>
                <div>
                  <p className="text-[10px] text-[#006496]/50 uppercase tracking-wider font-semibold mb-0.5">Status</p>
                  {statusBadge(selected.status)}
                </div>
              </div>

              {selected.reason && (
                <div>
                  <p className="text-[10px] text-[#006496]/50 uppercase tracking-wider font-semibold mb-1">Reason</p>
                  <p className="text-sm text-[#1a3a4a] bg-[#f0f4f8] rounded-xl p-3">{selected.reason}</p>
                </div>
              )}

              {(selected.surveyQ1Answer || selected.surveyQ2Answer || selected.surveyQ3Answer) && (
                <div>
                  <p className="text-[10px] text-[#006496]/50 uppercase tracking-wider font-semibold mb-2">Exit Survey</p>
                  <div className="space-y-2">
                    {SURVEY_QUESTIONS.map((q, i) => {
                      const ans = [selected.surveyQ1Answer, selected.surveyQ2Answer, selected.surveyQ3Answer][i];
                      if (!ans) return null;
                      return (
                        <div key={i} className="bg-[#f0f4f8] rounded-xl p-3">
                          <p className="text-[10px] text-[#006496]/60 font-semibold mb-1">{q}</p>
                          <p className="text-sm text-[#1a3a4a]">{ans}</p>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {selected.deptHeadStatus && (
                <div className={`rounded-xl p-3 ${selected.deptHeadStatus === "approved" ? "bg-blue-50 border border-blue-100" : "bg-red-50 border border-red-100"}`}>
                  <p className="text-[10px] font-bold uppercase tracking-wider mb-1"
                    style={{ color: selected.deptHeadStatus === "approved" ? "#1d4ed8" : "#dc2626" }}>
                    Department Head — {selected.deptHeadStatus === "approved" ? "Approved" : "Rejected"}
                  </p>
                  {selected.deptHeadName && <p className="text-xs text-[#1a3a4a] mb-1">By: {selected.deptHeadName}</p>}
                  {selected.deptHeadComment && <p className="text-sm text-[#1a3a4a]">{selected.deptHeadComment}</p>}
                  {selected.deptHeadApprovedAt && (
                    <p className="text-[10px] text-[#006496]/50 mt-1">{new Date(selected.deptHeadApprovedAt).toLocaleString()}</p>
                  )}
                </div>
              )}

              {selected.hrComment && (
                <div>
                  <p className="text-[10px] text-[#006496]/50 uppercase tracking-wider font-semibold mb-1">HR Comment</p>
                  <p className="text-sm text-[#1a3a4a] bg-[#f0f4f8] rounded-xl p-3">{selected.hrComment}</p>
                </div>
              )}

              {selected.status === "approved" && (
                <p className="text-[11px] text-emerald-600">
                  Approved by {selected.approvedBy} on{" "}
                  {selected.approvedAt ? new Date(selected.approvedAt).toLocaleDateString() : "—"}
                </p>
              )}

              {(selected.status === "dept_approved" || selected.status === "pending") && (
                <div className="flex gap-2 pt-1">
                  {selected.status === "dept_approved" && (
                    <Button
                      className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                      onClick={() => { setActionType("approve"); setConfirmOpen(true); }}
                    >
                      Final Approve
                    </Button>
                  )}
                  <Button
                    variant="destructive" className="flex-1"
                    onClick={() => { setActionType("reject"); setConfirmOpen(true); }}
                  >
                    Reject
                  </Button>
                </div>
              )}

              {selected.status === "approved" && (
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline" className="flex-1 border-blue-200 text-blue-700 hover:bg-blue-50"
                    onClick={() => handlePdf(selected)} disabled={pdfLoading === selected.id}
                  >
                    <FileDown className="w-4 h-4 mr-1.5" />
                    {pdfLoading === selected.id ? "Generating…" : "Download PDF"}
                  </Button>
                  <Button
                    variant="outline" className="flex-1 border-emerald-200 text-emerald-700 hover:bg-emerald-50"
                    onClick={() => handleEmail(selected)} disabled={emailLoading === selected.id}
                  >
                    <Mail className="w-4 h-4 mr-1.5" />
                    {emailLoading === selected.id ? "Sending…" : "Send Email"}
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ── Confirm HR Action ── */}
      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!o) { setConfirmOpen(false); setHrComment(""); } }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {actionType === "approve" ? "Final Approve Resignation?" : "Reject Resignation?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {actionType === "approve" ? (
                <>This will give <strong>HR final approval</strong> for <strong>{selected?.employeeName}</strong>'s resignation.
                Their account will be set to <strong>Inactive</strong> immediately.</>
              ) : (
                <>This will reject <strong>{selected?.employeeName}</strong>'s resignation
                {selected?.status === "dept_approved" ? " (overriding the Department Head's approval)" : ""}.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="px-4 pb-2">
            <p className="text-xs font-semibold text-[#006496]/60 mb-1">HR Comment (optional)</p>
            <Textarea
              placeholder="Add a comment for the employee..."
              value={hrComment} onChange={(e) => setHrComment(e.target.value)}
              className="text-sm" rows={3}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => { setConfirmOpen(false); setHrComment(""); }}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleAction}
              className={actionType === "approve" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-red-600 hover:bg-red-700"}
              disabled={actionMutation.isPending}
            >
              {actionMutation.isPending ? "Processing…" : actionType === "approve" ? "Yes, Approve" : "Yes, Reject"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Confirm Delete ── */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Resignation Record?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete <strong>{deleteTarget?.employeeName}</strong>'s resignation request.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-red-600 hover:bg-red-700"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Yes, Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </HrLayout>
  );
}
