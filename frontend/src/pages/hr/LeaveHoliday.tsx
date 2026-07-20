import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListHolidays, useCreateHoliday, useDeleteHoliday,
  getListHolidaysQueryKey,
  useListPermissions, useCreatePermission, useUpdatePermissionStatus, useDeletePermission,
  getListPermissionsQueryKey,
  useListEmployees,
} from "@/lib/api-client";
import {
  useListLeaveRequests, useUpdateLeaveStatus, useDeleteLeaveRequest,
  getListLeaveRequestsQueryKey,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { Calendar, Plus, Trash2, CheckCircle, XCircle, Gift, Clock, User, Building2, Briefcase, FileText } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { Separator } from "@/components/ui/separator";

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  pending:  { label: "Pending",  className: "bg-amber-50 text-amber-700 border-amber-200" },
  approved: { label: "Approved", className: "bg-green-50 text-green-700 border-green-200" },
  rejected: { label: "Rejected", className: "bg-red-50 text-red-700 border-red-200" },
};

export default function LeaveHoliday() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const defaultTab = new URLSearchParams(window.location.search).get("tab") ?? "leaves";
  const [activeTab, setActiveTab] = useState(defaultTab);
  const [showHolidayDialog, setShowHolidayDialog] = useState(false);
  const [selectedLeave, setSelectedLeave] = useState<any | null>(null);
  const [selectedPerm, setSelectedPerm] = useState<any | null>(null);
  const [holidayForm, setHolidayForm] = useState({ name: "", date: "", holidayType: "national", description: "" });
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterYear, setFilterYear] = useState(new Date().getFullYear());

  const [permFilterStatus, setPermFilterStatus] = useState("all");
  const [permFilterMonth, setPermFilterMonth] = useState<number | "all">("all");
  const [permFilterYear, setPermFilterYear] = useState(new Date().getFullYear());
  const [showPermDialog, setShowPermDialog] = useState(false);

  const { data: employees } = useListEmployees({ status: "active" });
  const [permForm, setPermForm] = useState({
    employeeId: "",
    date: new Date().toISOString().slice(0, 10),
    permissionTime: "",
    reason: "",
  });

  const { data: leaves, isLoading: leavesLoading } = useListLeaveRequests();
  const { data: holidays, isLoading: holidaysLoading } = useListHolidays({ year: filterYear });
  const { data: permissions, isLoading: permissionsLoading } = useListPermissions({
    ...(permFilterStatus !== "all" ? { status: permFilterStatus } : {}),
    ...(permFilterMonth !== "all" ? { month: permFilterMonth } : {}),
    year: permFilterYear,
  });
  const updateLeaveMutation = useUpdateLeaveStatus();
  const deleteLeaveMutation = useDeleteLeaveRequest();
  const createHolidayMutation = useCreateHoliday();
  const deleteHolidayMutation = useDeleteHoliday();
  const createPermMutation = useCreatePermission();
  const updatePermMutation = useUpdatePermissionStatus();
  const deletePermMutation = useDeletePermission();

  const filteredLeaves = (leaves ?? []).filter(l =>
    filterStatus === "all" || l.status === filterStatus,
  );

  const updateLeaveStatus = async (id: number, status: string) => {
    try {
      await updateLeaveMutation.mutateAsync({ id, data: { status: status as any } });
    } catch {
      toast({ title: "Failed to update leave request", variant: "destructive" });
      return;
    }
    toast({ title: `Leave request ${status}` });
    queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
  };

  const deleteLeaveRequest = async (id: number) => {
    try {
      await deleteLeaveMutation.mutateAsync(id);
    } catch {
      toast({ title: "Failed to delete leave request", variant: "destructive" });
      return;
    }
    toast({ title: "Leave request deleted" });
    queryClient.invalidateQueries({ queryKey: getListLeaveRequestsQueryKey() });
  };

  const addHoliday = async () => {
    if (!holidayForm.name || !holidayForm.date) {
      toast({ title: "Name and date are required", variant: "destructive" });
      return;
    }
    try {
      await createHolidayMutation.mutateAsync({
        name: holidayForm.name,
        date: holidayForm.date,
        holidayType: holidayForm.holidayType,
        description: holidayForm.description || undefined,
      });
    } catch {
      toast({ title: "Failed to add holiday", variant: "destructive" });
      return;
    }
    toast({ title: "Holiday added" });
    setHolidayForm({ name: "", date: "", holidayType: "national", description: "" });
    setShowHolidayDialog(false);
    queryClient.invalidateQueries({ queryKey: getListHolidaysQueryKey({ year: filterYear }) });
  };

  const deleteHoliday = async (id: number) => {
    try {
      await deleteHolidayMutation.mutateAsync(id);
    } catch {
      toast({ title: "Failed to delete holiday", variant: "destructive" });
      return;
    }
    toast({ title: "Holiday deleted" });
    queryClient.invalidateQueries({ queryKey: getListHolidaysQueryKey({ year: filterYear }) });
  };

  const permQueryKey = getListPermissionsQueryKey({
    ...(permFilterStatus !== "all" ? { status: permFilterStatus } : {}),
    ...(permFilterMonth !== "all" ? { month: permFilterMonth as number } : {}),
    year: permFilterYear,
  });

  const addPermission = async () => {
    if (!permForm.employeeId || !permForm.date) {
      toast({ title: "Please select an employee and date", variant: "destructive" });
      return;
    }
    try {
      await createPermMutation.mutateAsync({
        employeeId: Number(permForm.employeeId),
        date: permForm.date,
        permissionTime: permForm.permissionTime || undefined,
        reason: permForm.reason || undefined,
      });
    } catch (err: any) {
      const msg = err?.message || "Failed to add permission";
      toast({ title: msg, variant: "destructive" });
      return;
    }
    toast({ title: "Permission added" });
    setPermForm({ employeeId: "", date: new Date().toISOString().slice(0, 10), permissionTime: "", reason: "" });
    setShowPermDialog(false);
    queryClient.invalidateQueries({ queryKey: permQueryKey });
  };

  const updatePermStatus = async (id: number, status: string) => {
    try {
      await updatePermMutation.mutateAsync({ id, data: { status } });
    } catch {
      toast({ title: "Failed to update permission", variant: "destructive" });
      return;
    }
    toast({ title: `Permission ${status}` });
    queryClient.invalidateQueries({ queryKey: permQueryKey });
  };

  const deletePermission = async (id: number) => {
    try {
      await deletePermMutation.mutateAsync(id);
    } catch {
      toast({ title: "Failed to delete permission", variant: "destructive" });
      return;
    }
    toast({ title: "Permission deleted" });
    queryClient.invalidateQueries({ queryKey: permQueryKey });
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Leave & Holiday</h2>
            <p className="text-muted-foreground text-sm mt-0.5">Manage leave requests and company holidays</p>
          </div>
        </div>

        {/* Summary — changes based on active tab */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(activeTab === "permissions" ? [
            { label: "Pending",   value: (permissions ?? []).filter(p => p.status === "pending").length,  color: "text-amber-700 bg-amber-50 border-amber-100" },
            { label: "Approved",  value: (permissions ?? []).filter(p => p.status === "approved").length, color: "text-green-700 bg-green-50 border-green-100" },
            { label: "Rejected",  value: (permissions ?? []).filter(p => p.status === "rejected").length, color: "text-red-700 bg-red-50 border-red-100" },
            { label: "Total",     value: (permissions ?? []).length,                                      color: "text-gray-700 bg-gray-50 border-gray-100" },
          ] : activeTab === "holidays" ? [
            { label: "Holidays",  value: (holidays ?? []).length,  color: "text-blue-700 bg-blue-50 border-blue-100" },
            { label: "Pending Leaves",  value: (leaves ?? []).filter(l => l.status === "pending").length,  color: "text-amber-700 bg-amber-50 border-amber-100" },
            { label: "Pending Perms",   value: (permissions ?? []).filter(p => p.status === "pending").length, color: "text-cyan-700 bg-cyan-50 border-cyan-100" },
            { label: "",          value: null, color: "text-gray-700 bg-gray-50 border-gray-100" },
          ] : [
            { label: "Pending",  value: (leaves ?? []).filter(l => l.status === "pending").length,  color: "text-amber-700 bg-amber-50 border-amber-100" },
            { label: "Approved", value: (leaves ?? []).filter(l => l.status === "approved").length, color: "text-green-700 bg-green-50 border-green-100" },
            { label: "Rejected", value: (leaves ?? []).filter(l => l.status === "rejected").length, color: "text-red-700 bg-red-50 border-red-100" },
            { label: "Holidays", value: (holidays ?? []).length,                                     color: "text-blue-700 bg-blue-50 border-blue-100" },
          ]).map(s => (
            s.value === null ? <div key={s.label} /> :
            <Card key={s.label} className={`border ${s.color.split(" ").slice(1).join(" ")}`}>
              <CardContent className="p-4">
                <p className={`text-2xl font-black ${s.color.split(" ")[0]}`}>{s.value}</p>
                <p className="text-xs font-medium text-gray-600 mt-0.5">{s.label}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <PillTabs
            items={[
              { value: "leaves", label: "Leave Requests", icon: <Calendar size={14} /> },
              { value: "permissions", label: "Permissions", icon: <Clock size={14} /> },
              { value: "holidays", label: "Holidays", icon: <Gift size={14} /> },
            ]}
            value={activeTab}
            onChange={setActiveTab}
          />

          <TabsContent value="leaves" className="mt-4 space-y-4">
            <div className="flex items-center gap-2 flex-wrap">
              <PillTabs
                items={["all", "pending", "approved", "rejected"].map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
                value={filterStatus}
                onChange={setFilterStatus}
                size="sm"
              />
            </div>

            <div className="space-y-3">
              {leavesLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <Card key={i} className="border-0 shadow-sm">
                    <CardContent className="p-4">
                      <Skeleton className="h-5 w-40 mb-2" />
                      <Skeleton className="h-4 w-64" />
                    </CardContent>
                  </Card>
                ))
              ) : filteredLeaves.length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">No leave requests found.</div>
              ) : (
                filteredLeaves.map(leave => {
                  const cfg = STATUS_CONFIG[leave.status] ?? STATUS_CONFIG.pending;
                  const days = (leave as any).totalDays ?? (leave.startDate && leave.endDate
                    ? Math.round((new Date(leave.endDate).getTime() - new Date(leave.startDate).getTime()) / 86400000) + 1
                    : 1);
                  const isSingleDay = leave.startDate === leave.endDate;
                  return (
                    <Card key={leave.id}
                      className="border hover:shadow-sm transition-shadow cursor-pointer"
                      onClick={() => setSelectedLeave({ ...leave, totalDays: days })}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-bold text-sm text-gray-900">{leave.employeeName ?? (leave as any).employeeCode ?? `#${leave.employeeId}`}</p>
                              <Badge className={`text-xs border ${cfg.className}`}>{cfg.label}</Badge>
                              <Badge variant="outline" className="text-xs capitalize">{leave.type}</Badge>
                            </div>
                            <p className="text-xs text-gray-500 mt-1">
                              {isSingleDay
                                ? new Date(leave.startDate).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long", year: "numeric" })
                                : `${leave.startDate} → ${leave.endDate}`}
                              &nbsp;·&nbsp; {days} day{days !== 1 ? "s" : ""}
                            </p>
                            {leave.reason && <p className="text-xs text-gray-400 mt-0.5 truncate">{leave.reason}</p>}
                          </div>
                          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                            {leave.status === "pending" && (
                              <>
                                <Button size="sm" variant="outline"
                                  className="h-8 gap-1 text-green-700 border-green-200 hover:bg-green-50"
                                  onClick={() => updateLeaveStatus(leave.id, "approved")}
                                  disabled={updateLeaveMutation.isPending}>
                                  <CheckCircle size={13} /> Approve
                                </Button>
                                <Button size="sm" variant="outline"
                                  className="h-8 gap-1 text-red-600 border-red-200 hover:bg-red-50"
                                  onClick={() => updateLeaveStatus(leave.id, "rejected")}
                                  disabled={updateLeaveMutation.isPending}>
                                  <XCircle size={13} /> Reject
                                </Button>
                              </>
                            )}
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-600"
                              onClick={() => deleteLeaveRequest(leave.id)}
                              disabled={deleteLeaveMutation.isPending}>
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </TabsContent>

          <TabsContent value="permissions" className="mt-4">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div className="flex items-center gap-2 flex-wrap">
                <PillTabs
                  items={["all", "pending", "approved", "rejected"].map((s) => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))}
                  value={permFilterStatus}
                  onChange={setPermFilterStatus}
                  size="sm"
                />
                <div className="flex items-center gap-1 ml-2">
                  <select
                    value={permFilterMonth}
                    onChange={e => setPermFilterMonth(e.target.value === "all" ? "all" : Number(e.target.value))}
                    className="h-8 rounded-md border px-2 text-xs bg-background">
                    <option value="all">All Months</option>
                    {["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"].map((m, i) => (
                      <option key={i} value={i + 1}>{m}</option>
                    ))}
                  </select>
                  <Input
                    type="number"
                    value={permFilterYear}
                    onChange={e => setPermFilterYear(Number(e.target.value))}
                    className="w-20 h-8 text-xs"
                    min={2020} max={2030}
                  />
                </div>
              </div>
              <Button onClick={() => setShowPermDialog(true)} className="gap-2">
                <Plus size={15} /> Add Permission
              </Button>
            </div>

            {permissionsLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Card key={i} className="border-0 shadow-sm">
                    <CardContent className="p-4">
                      <Skeleton className="h-5 w-40 mb-2" />
                      <Skeleton className="h-4 w-64" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (permissions ?? []).length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">No permissions found.</div>
            ) : (
              <div className="space-y-3">
                {(permissions ?? []).map(p => {
                  const cfg = STATUS_CONFIG[p.status] ?? STATUS_CONFIG.pending;
                  return (
                    <Card key={p.id}
                      className="border hover:shadow-sm transition-shadow cursor-pointer"
                      onClick={() => setSelectedPerm(p)}>
                      <CardContent className="p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap mb-1">
                              <p className="font-bold text-sm text-gray-900">{p.employeeName}</p>
                              <span className="text-xs text-gray-400">{p.employeeCode}</span>
                              <Badge className={`text-xs border ${cfg.className}`}>{cfg.label}</Badge>
                            </div>
                            <p className="text-xs text-gray-500">
                              {new Date(p.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long", year: "numeric" })}
                              {p.permissionTime && <span className="ml-2">at {p.permissionTime}</span>}
                            </p>
                            {p.reason && <p className="text-xs text-gray-400 mt-0.5 truncate">{p.reason}</p>}
                            {p.hrComment && <p className="text-xs text-blue-600 mt-0.5 italic">HR: {p.hrComment}</p>}
                            {p.monthlyUsed != null && (
                              <div className="flex items-center gap-2 mt-2">
                                <div className="flex gap-0.5">
                                  {Array.from({ length: p.monthlyLimit }).map((_, i) => (
                                    <div key={i} className={`w-4 h-1.5 rounded-full ${i < p.monthlyUsed! ? "bg-amber-400" : "bg-gray-200"}`} />
                                  ))}
                                </div>
                                <span className="text-xs text-gray-400">{p.monthlyUsed}/{p.monthlyLimit} this month</span>
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                            {p.status === "pending" && (
                              <>
                                <Button size="sm" variant="outline"
                                  className="h-8 gap-1 text-green-700 border-green-200 hover:bg-green-50"
                                  onClick={() => updatePermStatus(p.id, "approved")}
                                  disabled={updatePermMutation.isPending}>
                                  <CheckCircle size={13} /> Approve
                                </Button>
                                <Button size="sm" variant="outline"
                                  className="h-8 gap-1 text-red-600 border-red-200 hover:bg-red-50"
                                  onClick={() => updatePermStatus(p.id, "rejected")}
                                  disabled={updatePermMutation.isPending}>
                                  <XCircle size={13} /> Reject
                                </Button>
                              </>
                            )}
                            <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-600"
                              onClick={() => deletePermission(p.id)}
                              disabled={deletePermMutation.isPending}>
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}

            <Dialog open={showPermDialog} onOpenChange={setShowPermDialog}>
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>Add Permission</DialogTitle>
                </DialogHeader>
                <div className="space-y-4 py-2">
                  <p className="text-xs text-muted-foreground">Each employee is allowed up to 3 permissions per month (1 hour each).</p>
                  <div className="space-y-1.5">
                    <Label>Employee</Label>
                    <EmployeeSearchSelect
                      employees={employees}
                      value={permForm.employeeId}
                      onChange={v => setPermForm(f => ({ ...f, employeeId: v }))}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Date</Label>
                      <Input type="date" value={permForm.date}
                        onChange={e => setPermForm(f => ({ ...f, date: e.target.value }))} />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Time (optional)</Label>
                      <Input type="time" value={permForm.permissionTime}
                        onChange={e => setPermForm(f => ({ ...f, permissionTime: e.target.value }))} />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label>Reason (optional)</Label>
                    <Input value={permForm.reason}
                      onChange={e => setPermForm(f => ({ ...f, reason: e.target.value }))}
                      placeholder="Brief reason" />
                  </div>
                  <div className="flex gap-3 pt-2">
                    <Button variant="outline" className="flex-1" onClick={() => setShowPermDialog(false)}>Cancel</Button>
                    <Button className="flex-1" onClick={addPermission} disabled={createPermMutation.isPending}>
                      {createPermMutation.isPending ? "Adding…" : "Add Permission"}
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>
          </TabsContent>

          <TabsContent value="holidays" className="mt-4">
            <div className="flex items-center justify-between mb-4 gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                <Label className="text-sm font-medium text-gray-600 shrink-0">Year:</Label>
                <Input
                  type="number"
                  value={filterYear}
                  onChange={e => setFilterYear(Number(e.target.value))}
                  className="w-24 h-8 text-sm"
                  min={2020}
                  max={2030}
                />
              </div>
              <Button onClick={() => setShowHolidayDialog(true)} className="gap-2">
                <Plus size={15} /> Add Holiday
              </Button>
            </div>
            {holidaysLoading ? (
              <div className="grid sm:grid-cols-2 gap-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Card key={i} className="border-0 shadow-sm">
                    <CardContent className="p-4">
                      <Skeleton className="h-5 w-32 mb-2" />
                      <Skeleton className="h-4 w-48" />
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (holidays ?? []).length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">No holidays for {filterYear}.</div>
            ) : (
              <div className="grid sm:grid-cols-2 gap-3">
                {(holidays ?? []).map(h => (
                  <Card key={h.id} className="border hover:shadow-sm transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="flex items-center gap-2 mb-1">
                            <p className="font-bold text-sm text-gray-900">{h.name}</p>
                            <Badge variant="outline" className="text-xs capitalize">{h.holidayType}</Badge>
                            {h.isRecurring && (
                              <Badge className="text-xs bg-blue-50 text-blue-600 border-blue-200">Recurring</Badge>
                            )}
                          </div>
                          <p className="text-xs text-gray-500">
                            {new Date(h.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long", year: "numeric" })}
                          </p>
                          {h.description && <p className="text-xs text-gray-400 mt-0.5">{h.description}</p>}
                        </div>
                        <Button variant="ghost" size="icon" className="h-7 w-7 text-red-400 hover:text-red-600 shrink-0"
                          onClick={() => deleteHoliday(h.id)}
                          disabled={deleteHolidayMutation.isPending}>
                          <Trash2 size={13} />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>
        </Tabs>

        <Dialog open={showHolidayDialog} onOpenChange={setShowHolidayDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Add Holiday</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Holiday Name</Label>
                <Input value={holidayForm.name}
                  onChange={e => setHolidayForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Pongal" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Date</Label>
                  <Input type="date" value={holidayForm.date}
                    onChange={e => setHolidayForm(f => ({ ...f, date: e.target.value }))} />
                </div>
                <div className="space-y-1.5">
                  <Label>Type</Label>
                  <select value={holidayForm.holidayType}
                    onChange={e => setHolidayForm(f => ({ ...f, holidayType: e.target.value }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                    <option value="national">National</option>
                    <option value="regional">Regional</option>
                    <option value="company">Company</option>
                  </select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Description (optional)</Label>
                <Input value={holidayForm.description}
                  onChange={e => setHolidayForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Brief description" />
              </div>
              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowHolidayDialog(false)}>Cancel</Button>
                <Button className="flex-1" onClick={addHoliday} disabled={createHolidayMutation.isPending}>
                  {createHolidayMutation.isPending ? "Adding…" : "Add Holiday"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* ── Leave Request Detail Dialog ─────────────────────────────────── */}
        {selectedLeave && (
          <Dialog open onOpenChange={() => setSelectedLeave(null)}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Leave Request Details</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-1">
                {/* Employee info */}
                <div className="rounded-xl border bg-gray-50 p-4 space-y-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Employee</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-start gap-2">
                      <User size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Name</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedLeave.employeeName ?? "—"}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <FileText size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Employee ID</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedLeave.employeeCode ?? `#${selectedLeave.employeeId}`}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Building2 size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Department</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedLeave.department ?? "—"}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Briefcase size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Designation</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedLeave.designation ?? "—"}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Leave details */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Leave Details</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-400">Leave Type</p>
                      <p className="text-sm font-semibold capitalize text-gray-900">{selectedLeave.type}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Status</p>
                      <Badge className={`text-xs border ${(STATUS_CONFIG[selectedLeave.status] ?? STATUS_CONFIG.pending).className}`}>
                        {(STATUS_CONFIG[selectedLeave.status] ?? STATUS_CONFIG.pending).label}
                      </Badge>
                    </div>
                    {selectedLeave.startDate === selectedLeave.endDate ? (
                      <div className="col-span-2">
                        <p className="text-xs text-gray-400">Date</p>
                        <p className="text-sm font-semibold text-gray-900">
                          {new Date(selectedLeave.startDate).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                          <span className="ml-2 text-xs font-normal text-gray-400">(1 day)</span>
                        </p>
                      </div>
                    ) : (
                      <>
                        <div>
                          <p className="text-xs text-gray-400">From</p>
                          <p className="text-sm font-semibold text-gray-900">
                            {new Date(selectedLeave.startDate).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long", year: "numeric" })}
                          </p>
                        </div>
                        <div>
                          <p className="text-xs text-gray-400">To</p>
                          <p className="text-sm font-semibold text-gray-900">
                            {new Date(selectedLeave.endDate).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long", year: "numeric" })}
                          </p>
                        </div>
                      </>
                    )}
                    <div>
                      <p className="text-xs text-gray-400">Working Days</p>
                      <p className="text-sm font-semibold text-gray-900">
                        {selectedLeave.totalDays ?? 1} day{(selectedLeave.totalDays ?? 1) !== 1 ? "s" : ""}
                      </p>
                    </div>
                  </div>
                  {selectedLeave.reason && (
                    <div>
                      <p className="text-xs text-gray-400 mb-1">Reason</p>
                      <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 border">{selectedLeave.reason}</p>
                    </div>
                  )}
                  {selectedLeave.hrComment && (
                    <div>
                      <p className="text-xs text-gray-400 mb-1">HR Comment</p>
                      <p className="text-sm text-blue-700 bg-blue-50 rounded-lg p-3 border border-blue-100">{selectedLeave.hrComment}</p>
                    </div>
                  )}
                  <p className="text-xs text-gray-300">
                    Submitted: {selectedLeave.createdAt ? new Date(selectedLeave.createdAt).toLocaleString("en-IN") : "—"}
                  </p>
                </div>

                {/* Actions */}
                {selectedLeave.status === "pending" && (
                  <div className="flex gap-2 pt-1">
                    <Button className="flex-1 gap-1 bg-green-600 hover:bg-green-700"
                      onClick={() => { updateLeaveStatus(selectedLeave.id, "approved"); setSelectedLeave(null); }}
                      disabled={updateLeaveMutation.isPending}>
                      <CheckCircle size={14} /> Approve
                    </Button>
                    <Button variant="outline" className="flex-1 gap-1 text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => { updateLeaveStatus(selectedLeave.id, "rejected"); setSelectedLeave(null); }}
                      disabled={updateLeaveMutation.isPending}>
                      <XCircle size={14} /> Reject
                    </Button>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}

        {/* ── Permission Detail Dialog ────────────────────────────────────── */}
        {selectedPerm && (
          <Dialog open onOpenChange={() => setSelectedPerm(null)}>
            <DialogContent className="max-w-lg">
              <DialogHeader>
                <DialogTitle>Permission Request Details</DialogTitle>
              </DialogHeader>
              <div className="space-y-4 py-1">
                {/* Employee info */}
                <div className="rounded-xl border bg-gray-50 p-4 space-y-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Employee</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="flex items-start gap-2">
                      <User size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Name</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedPerm.employeeName}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <FileText size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Employee ID</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedPerm.employeeCode ?? `#${selectedPerm.employeeId}`}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Building2 size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Department</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedPerm.department ?? "—"}</p>
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <Briefcase size={14} className="mt-0.5 text-gray-400 shrink-0" />
                      <div>
                        <p className="text-xs text-gray-400">Designation</p>
                        <p className="text-sm font-semibold text-gray-900">{selectedPerm.designation ?? "—"}</p>
                      </div>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Permission details */}
                <div className="space-y-3">
                  <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Permission Details</p>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-400">Date</p>
                      <p className="text-sm font-semibold text-gray-900">
                        {selectedPerm.date
                          ? new Date(selectedPerm.date).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "long", year: "numeric" })
                          : "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Time</p>
                      <p className="text-sm font-semibold text-gray-900">{selectedPerm.permissionTime ?? "Not specified"}</p>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Status</p>
                      <Badge className={`text-xs border ${(STATUS_CONFIG[selectedPerm.status] ?? STATUS_CONFIG.pending).className}`}>
                        {(STATUS_CONFIG[selectedPerm.status] ?? STATUS_CONFIG.pending).label}
                      </Badge>
                    </div>
                    <div>
                      <p className="text-xs text-gray-400">Monthly Usage</p>
                      {selectedPerm.monthlyUsed != null ? (
                        <div className="flex items-center gap-2 mt-1">
                          <div className="flex gap-0.5">
                            {Array.from({ length: selectedPerm.monthlyLimit }).map((_: any, i: number) => (
                              <div key={i} className={`w-4 h-1.5 rounded-full ${i < selectedPerm.monthlyUsed ? "bg-amber-400" : "bg-gray-200"}`} />
                            ))}
                          </div>
                          <span className="text-xs text-gray-500">{selectedPerm.monthlyUsed}/{selectedPerm.monthlyLimit}</span>
                        </div>
                      ) : <p className="text-sm font-semibold text-gray-900">—</p>}
                    </div>
                  </div>
                  {selectedPerm.reason && (
                    <div>
                      <p className="text-xs text-gray-400 mb-1">Reason</p>
                      <p className="text-sm text-gray-700 bg-gray-50 rounded-lg p-3 border">{selectedPerm.reason}</p>
                    </div>
                  )}
                  {selectedPerm.hrComment && (
                    <div>
                      <p className="text-xs text-gray-400 mb-1">HR Comment</p>
                      <p className="text-sm text-blue-700 bg-blue-50 rounded-lg p-3 border border-blue-100">{selectedPerm.hrComment}</p>
                    </div>
                  )}
                  <p className="text-xs text-gray-300">
                    Submitted: {selectedPerm.createdAt ? new Date(selectedPerm.createdAt).toLocaleString("en-IN") : "—"}
                  </p>
                </div>

                {/* Actions */}
                {selectedPerm.status === "pending" && (
                  <div className="flex gap-2 pt-1">
                    <Button className="flex-1 gap-1 bg-green-600 hover:bg-green-700"
                      onClick={() => { updatePermStatus(selectedPerm.id, "approved"); setSelectedPerm(null); }}
                      disabled={updatePermMutation.isPending}>
                      <CheckCircle size={14} /> Approve
                    </Button>
                    <Button variant="outline" className="flex-1 gap-1 text-red-600 border-red-200 hover:bg-red-50"
                      onClick={() => { updatePermStatus(selectedPerm.id, "rejected"); setSelectedPerm(null); }}
                      disabled={updatePermMutation.isPending}>
                      <XCircle size={14} /> Reject
                    </Button>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </HrLayout>
  );
}
