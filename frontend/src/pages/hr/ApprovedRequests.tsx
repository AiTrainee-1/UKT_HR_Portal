import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListEmployeeRequests, useEmployeeRequestAction,
  getListEmployeeRequestsQueryKey, EmployeeRequest,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2, XCircle, MessageSquare, Clock, Search,
  Calendar, IndianRupee, Shuffle, Wallet, Shield, HelpCircle,
  ChevronRight,
} from "lucide-react";

const TYPE_CONFIG: Record<string, { label: string; icon: React.ComponentType<{ size?: number }>; color: string }> = {
  leave:            { label: "Leave Request",      icon: Calendar,    color: "text-blue-600 bg-blue-50" },
  salary_enquiry:   { label: "Salary Enquiry",     icon: IndianRupee, color: "text-green-600 bg-green-50" },
  shift_correction: { label: "Shift Correction",   icon: Shuffle,     color: "text-purple-600 bg-purple-50" },
  advance:          { label: "Advance Request",    icon: Wallet,      color: "text-amber-600 bg-amber-50" },
  permission:       { label: "Permission Request", icon: Shield,      color: "text-cyan-600 bg-cyan-50" },
  general:          { label: "General Query",      icon: HelpCircle,  color: "text-gray-600 bg-gray-50" },
};

const STATUS_CONFIG: Record<string, { label: string; cls: string }> = {
  pending:   { label: "Pending",          cls: "bg-amber-50 text-amber-700 border-amber-200" },
  in_review: { label: "In Review",        cls: "bg-blue-50 text-blue-700 border-blue-200" },
  approved:  { label: "Approved",         cls: "bg-green-50 text-green-700 border-green-200" },
  rejected:  { label: "Rejected",         cls: "bg-red-50 text-red-700 border-red-200" },
  more_info: { label: "More Info Needed", cls: "bg-orange-50 text-orange-700 border-orange-200" },
};

export default function ApprovedRequests() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [filterType, setFilterType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [selectedRequest, setSelectedRequest] = useState<EmployeeRequest | null>(null);
  const [hrNote, setHrNote] = useState("");

  const { data: requests, isLoading } = useListEmployeeRequests();
  const actionMutation = useEmployeeRequestAction();

  const filtered = (requests ?? []).filter((r) => {
    const matchSearch =
      !search ||
      r.employeeName.toLowerCase().includes(search.toLowerCase()) ||
      r.subject.toLowerCase().includes(search.toLowerCase());
    const matchType = filterType === "all" || r.requestType === filterType;
    const matchStatus = filterStatus === "all" || r.status === filterStatus;
    return matchSearch && matchType && matchStatus;
  });

  const pendingCount = (requests ?? []).filter((r) => r.status === "pending").length;

  const updateStatus = async (id: number, status: string, note?: string) => {
    try {
      await actionMutation.mutateAsync({ id, status, hrNotes: note });
    } catch {
      toast({ title: "Failed to update request", variant: "destructive" });
      return;
    }
    toast({ title: `Request ${status.replace("_", " ")}` });
    setSelectedRequest(null);
    queryClient.invalidateQueries({ queryKey: getListEmployeeRequestsQueryKey() });
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              Approved Requests
              {pendingCount > 0 && <Badge className="bg-amber-500 text-white">{pendingCount} pending</Badge>}
            </h2>
            <p className="text-muted-foreground text-sm mt-0.5">Employee requests from the mobile app</p>
          </div>
        </div>

        {/* Filters */}
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by employee or subject…"
              className="pl-9 h-9"
            />
          </div>
          <select
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
            className="h-9 rounded-md border px-3 text-sm bg-background"
          >
            <option value="all">All Types</option>
            {Object.entries(TYPE_CONFIG).map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
          <select
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
            className="h-9 rounded-md border px-3 text-sm bg-background"
          >
            <option value="all">All Status</option>
            {Object.entries(STATUS_CONFIG).map(([key, { label }]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </div>

        {/* Request Cards */}
        <div className="space-y-3">
          {isLoading ? (
            Array.from({ length: 4 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" />
                  <Skeleton className="h-4 w-64" />
                </CardContent>
              </Card>
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">No requests found.</div>
          ) : (
            filtered.map((req) => {
              const type = TYPE_CONFIG[req.requestType] ?? TYPE_CONFIG.general;
              const status = STATUS_CONFIG[req.status] ?? STATUS_CONFIG.pending;
              const TypeIcon = type.icon;
              return (
                <Card
                  key={req.id}
                  className="border hover:shadow-sm transition-shadow cursor-pointer"
                  onClick={() => { setSelectedRequest(req); setHrNote(req.hrNotes ?? ""); }}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <div className={`p-2 rounded-lg shrink-0 ${type.color}`}>
                          <TypeIcon size={16} />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="font-bold text-sm text-gray-900">{req.employeeName}</p>
                            <span className="text-xs text-gray-400">{req.employeeCode}</span>
                            <Badge className={`text-xs border ${status.cls}`}>{status.label}</Badge>
                          </div>
                          <p className="text-sm text-gray-700 mt-0.5 font-medium">{req.subject}</p>
                          <p className="text-xs text-gray-400 mt-0.5 truncate">{req.description}</p>
                          <p className="text-xs text-gray-300 mt-1">
                            {type.label} ·{" "}
                            {req.createdAt ? new Date(req.createdAt).toLocaleDateString("en-IN") : ""}
                          </p>
                        </div>
                      </div>
                      <ChevronRight size={16} className="text-gray-300 shrink-0 mt-1" />
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* Detail Dialog */}
        {selectedRequest && (
          <Dialog open onOpenChange={() => setSelectedRequest(null)}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Request Details</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-2">
                <div className="p-4 rounded-xl bg-gray-50 border space-y-2">
                  <div className="flex items-center justify-between">
                    <p className="font-bold text-gray-900">{selectedRequest.employeeName}</p>
                    <Badge className={`text-xs border ${(STATUS_CONFIG[selectedRequest.status] ?? STATUS_CONFIG.pending).cls}`}>
                      {(STATUS_CONFIG[selectedRequest.status] ?? STATUS_CONFIG.pending).label}
                    </Badge>
                  </div>
                  <p className="text-sm font-medium">{selectedRequest.subject}</p>
                  <p className="text-xs text-gray-500">{selectedRequest.description}</p>
                  <p className="text-xs text-gray-400">
                    {(TYPE_CONFIG[selectedRequest.requestType] ?? TYPE_CONFIG.general).label} ·{" "}
                    {selectedRequest.createdAt
                      ? new Date(selectedRequest.createdAt).toLocaleDateString("en-IN")
                      : ""}
                  </p>
                </div>
                <div className="space-y-1.5">
                  <Label>HR Notes / Response</Label>
                  <textarea
                    value={hrNote}
                    onChange={(e) => setHrNote(e.target.value)}
                    className="w-full rounded-md border p-3 text-sm resize-none h-24 bg-background"
                    placeholder="Add internal notes or response for this request…"
                  />
                </div>
                {selectedRequest.status === "pending" || selectedRequest.status === "in_review" ? (
                  <div className="flex gap-2 flex-wrap">
                    <Button size="sm" className="gap-1 bg-green-600 hover:bg-green-700"
                      onClick={() => updateStatus(selectedRequest.id, "approved", hrNote)}
                      disabled={actionMutation.isPending}>
                      <CheckCircle2 size={14} /> Approve
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1 text-red-600 border-red-200"
                      onClick={() => updateStatus(selectedRequest.id, "rejected", hrNote)}
                      disabled={actionMutation.isPending}>
                      <XCircle size={14} /> Reject
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1"
                      onClick={() => updateStatus(selectedRequest.id, "in_review", hrNote)}
                      disabled={actionMutation.isPending}>
                      <Clock size={14} /> Mark In Review
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1"
                      onClick={() => updateStatus(selectedRequest.id, "more_info", hrNote)}
                      disabled={actionMutation.isPending}>
                      <MessageSquare size={14} /> Need More Info
                    </Button>
                  </div>
                ) : (
                  <Button size="sm" variant="outline"
                    onClick={() => updateStatus(selectedRequest.id, selectedRequest.status, hrNote)}
                    disabled={actionMutation.isPending}>
                    Save Notes
                  </Button>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </HrLayout>
  );
}
