import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useGetRecruitmentDashboard,
  type DeptAnalysisItem,
  type RecentJoineeItem,
  type RecentLeaveItem,
} from "@/lib/api-client";
import {
  Users,
  Building2,
  CalendarOff,
  UserPlus,
  Briefcase,
  AlertTriangle,
  ClipboardList,
  TrendingUp,
  CheckCircle2,
} from "lucide-react";

type DetailModal =
  | { type: "staff" }
  | { type: "departments" }
  | { type: "leaves" }
  | { type: "joinees" }
  | { type: "openRoles" }
  | { type: "resignations" }
  | { type: "vacancies" }
  | null;

function StatCard({
  label,
  value,
  icon: Icon,
  color,
  subLabel,
  onClick,
  urgent,
}: {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>;
  color: string;
  subLabel?: string;
  onClick?: () => void;
  urgent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className="text-left w-full"
    >
      <Card
        className="rounded-2xl transition-all duration-200 hover:-translate-y-1 hover:shadow-lg cursor-pointer"
        style={{
          background: "#ffffff",
          boxShadow: "6px 6px 14px rgba(0,100,150,0.10), -4px -4px 10px rgba(255,255,255,0.9)",
          border: urgent ? "1.5px solid rgba(239,68,68,0.3)" : "1px solid rgba(0,100,150,0.06)",
        }}
      >
        <CardContent className="p-4 flex items-start gap-3">
          <div
            className="p-2.5 rounded-xl shrink-0"
            style={{ background: color + "18" }}
          >
            <Icon className="w-5 h-5" style={{ color }} strokeWidth={1.8} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-widest text-[#006496]/50 leading-none mb-1">
              {label}
            </p>
            <p className="text-2xl font-black leading-tight" style={{ color: urgent ? "#ef4444" : "#1a3a4a" }}>
              {value}
            </p>
            {subLabel && (
              <p className="text-[11px] text-[#006496]/40 mt-0.5">{subLabel}</p>
            )}
          </div>
          {urgent && value > 0 && (
            <span className="flex h-2 w-2 mt-1 shrink-0">
              <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-red-400 opacity-75" />
              <span className="relative inline-flex rounded-full h-2 w-2 bg-red-500" />
            </span>
          )}
        </CardContent>
      </Card>
    </button>
  );
}

function LoadingCards() {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
      {Array.from({ length: 7 }).map((_, i) => (
        <Skeleton key={i} className="h-24 rounded-2xl" />
      ))}
    </div>
  );
}

export default function RecruitmentDashboard() {
  const { data, isLoading } = useGetRecruitmentDashboard({ refetchInterval: 60_000 } as any);
  const [modal, setModal] = useState<DetailModal>(null);

  const dept = data?.departmentAnalysis ?? [];
  const joinees = data?.recentJoineeList ?? [];
  const leaves = data?.recentLeavesList ?? [];

  return (
    <HrLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-black text-[#1a3a4a] tracking-tight">Recruitment Dashboard</h1>
          <p className="text-sm text-[#006496]/60 mt-0.5">
            Staff headcount, vacancies, new joinees, and recruitment activity at a glance.
          </p>
        </div>

        {/* KPI Cards */}
        {isLoading ? (
          <LoadingCards />
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            <StatCard
              label="Total Staff"
              value={data?.totalStaffEmployees ?? 0}
              icon={Users}
              color="#006496"
              subLabel="Active employees"
              onClick={() => setModal({ type: "staff" })}
            />
            <StatCard
              label="Departments"
              value={data?.totalDepartments ?? 0}
              icon={Building2}
              color="#0891b2"
              onClick={() => setModal({ type: "departments" })}
            />
            <StatCard
              label="Recent Leaves"
              value={data?.recentLeaves ?? 0}
              icon={CalendarOff}
              color="#7c3aed"
              subLabel="Last 30 days"
              onClick={() => setModal({ type: "leaves" })}
            />
            <StatCard
              label="New Joinees"
              value={data?.newJoinees ?? 0}
              icon={UserPlus}
              color="#059669"
              subLabel="Last 30 days"
              onClick={() => setModal({ type: "joinees" })}
            />
            <StatCard
              label="Open Roles"
              value={data?.openRoles ?? 0}
              icon={Briefcase}
              color="#d97706"
              onClick={() => setModal({ type: "openRoles" })}
            />
            <StatCard
              label="Pending Resignations"
              value={data?.pendingResignations ?? 0}
              icon={ClipboardList}
              color="#dc2626"
              urgent={(data?.pendingResignations ?? 0) > 0}
              onClick={() => setModal({ type: "resignations" })}
            />
            <StatCard
              label="Positions Needed"
              value={data?.positionsNeedingStaff ?? 0}
              icon={AlertTriangle}
              color="#ea580c"
              subLabel="Total vacancies"
              urgent={(data?.positionsNeedingStaff ?? 0) > 0}
              onClick={() => setModal({ type: "vacancies" })}
            />
          </div>
        )}

        {/* Department Headcount Table */}
        <div>
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="w-4 h-4 text-[#006496]" strokeWidth={1.8} />
            <h2 className="text-base font-bold text-[#1a3a4a]">Department Headcount</h2>
          </div>
          <Card
            className="rounded-2xl overflow-hidden"
            style={{
              background: "#ffffff",
              boxShadow: "6px 6px 14px rgba(0,100,150,0.08), -4px -4px 10px rgba(255,255,255,0.9)",
              border: "1px solid rgba(0,100,150,0.06)",
            }}
          >
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10 rounded-xl" />)}
              </div>
            ) : dept.length === 0 ? (
              <div className="p-8 text-center text-[#006496]/40 text-sm">No department data available.</div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow style={{ borderColor: "rgba(0,100,150,0.07)" }}>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Department</TableHead>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center">Current</TableHead>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center">Required</TableHead>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center">Vacancy</TableHead>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dept.map((d: DeptAnalysisItem) => (
                    <TableRow
                      key={d.departmentId}
                      style={{ borderColor: "rgba(0,100,150,0.05)" }}
                      className="hover:bg-[#006496]/[0.02]"
                    >
                      <TableCell className="font-semibold text-[#1a3a4a] text-sm">{d.departmentName}</TableCell>
                      <TableCell className="text-center text-sm text-[#1a3a4a]">{d.currentCount}</TableCell>
                      <TableCell className="text-center text-sm text-[#1a3a4a]">{d.requiredCount}</TableCell>
                      <TableCell className="text-center">
                        {d.vacancy > 0 ? (
                          <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-red-50 text-red-600 font-bold text-sm">
                            {d.vacancy}
                          </span>
                        ) : (
                          <CheckCircle2 className="w-4 h-4 text-emerald-500 mx-auto" strokeWidth={2} />
                        )}
                      </TableCell>
                      <TableCell>
                        {d.requiredCount === 0 ? (
                          <Badge variant="outline" className="text-[10px] text-[#006496]/50 border-[#006496]/20">Not set</Badge>
                        ) : d.vacancy > 0 ? (
                          <Badge className="text-[10px] bg-red-50 text-red-600 border-red-200 border">Needs Hiring</Badge>
                        ) : (
                          <Badge className="text-[10px] bg-emerald-50 text-emerald-700 border-emerald-200 border">Fully Staffed</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </Card>
        </div>

        {/* Recent Joinees */}
        {joinees.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-3">
              <UserPlus className="w-4 h-4 text-emerald-600" strokeWidth={1.8} />
              <h2 className="text-base font-bold text-[#1a3a4a]">New Joinees (Last 30 Days)</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {joinees.map((e: RecentJoineeItem) => (
                <Card
                  key={e.id}
                  className="rounded-2xl"
                  style={{
                    background: "#ffffff",
                    boxShadow: "4px 4px 10px rgba(0,100,150,0.07), -2px -2px 8px rgba(255,255,255,0.9)",
                    border: "1px solid rgba(5,150,105,0.12)",
                  }}
                >
                  <CardContent className="p-3.5 flex items-center gap-3">
                    <div
                      className="w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold text-white shrink-0"
                      style={{ background: "linear-gradient(135deg, #059669, #0891b2)" }}
                    >
                      {e.name.charAt(0)}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-bold text-[#1a3a4a] truncate">{e.name}</p>
                      <p className="text-[11px] text-[#006496]/50 truncate">
                        {e.designation ?? e.department ?? e.employeeCode}
                      </p>
                      <p className="text-[10px] text-emerald-600 font-medium mt-0.5">
                        Joined {e.joinDate ?? "—"}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Detail Modals ── */}

      {/* Department Analysis Modal */}
      <Dialog open={modal?.type === "staff" || modal?.type === "departments" || modal?.type === "vacancies"} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {modal?.type === "staff" && "All Active Staff Employees"}
              {modal?.type === "departments" && "Department Overview"}
              {modal?.type === "vacancies" && "Departments with Vacancies"}
            </DialogTitle>
          </DialogHeader>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Department</TableHead>
                <TableHead className="text-center">Current</TableHead>
                <TableHead className="text-center">Required</TableHead>
                <TableHead className="text-center">Vacancy</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {dept
                .filter((d) => modal?.type === "vacancies" ? d.vacancy > 0 : true)
                .map((d) => (
                  <TableRow key={d.departmentId}>
                    <TableCell className="font-medium">{d.departmentName}</TableCell>
                    <TableCell className="text-center">{d.currentCount}</TableCell>
                    <TableCell className="text-center">{d.requiredCount}</TableCell>
                    <TableCell className="text-center">
                      {d.vacancy > 0 ? (
                        <Badge className="bg-red-50 text-red-600 border-red-200 border">{d.vacancy} open</Badge>
                      ) : (
                        <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 border">Full</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </DialogContent>
      </Dialog>

      {/* New Joinees Modal */}
      <Dialog open={modal?.type === "joinees"} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>New Joinees — Last 30 Days ({joinees.length})</DialogTitle>
          </DialogHeader>
          {joinees.length === 0 ? (
            <p className="text-sm text-center text-[#006496]/40 py-6">No new joinees in the last 30 days.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Department</TableHead>
                  <TableHead>Join Date</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {joinees.map((e: RecentJoineeItem) => (
                  <TableRow key={e.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{e.name}</p>
                        <p className="text-[11px] text-[#006496]/50">{e.employeeCode}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{e.department ?? "—"}</TableCell>
                    <TableCell className="text-sm">{e.joinDate ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Recent Leaves Modal */}
      <Dialog open={modal?.type === "leaves"} onOpenChange={() => setModal(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Recent Leaves — Last 30 Days ({leaves.length})</DialogTitle>
          </DialogHeader>
          {leaves.length === 0 ? (
            <p className="text-sm text-center text-[#006496]/40 py-6">No leave requests in the last 30 days.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Employee</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {leaves.map((l: RecentLeaveItem) => (
                  <TableRow key={l.id}>
                    <TableCell>
                      <div>
                        <p className="font-medium text-sm">{l.employeeName}</p>
                        <p className="text-[11px] text-[#006496]/50">{l.department ?? l.employeeCode}</p>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm capitalize">{l.type}</TableCell>
                    <TableCell className="text-sm">{l.startDate} → {l.endDate}</TableCell>
                    <TableCell>
                      <Badge
                        className={
                          l.status === "approved"
                            ? "bg-emerald-50 text-emerald-700 border-emerald-200 border text-[10px]"
                            : l.status === "rejected"
                            ? "bg-red-50 text-red-600 border-red-200 border text-[10px]"
                            : "bg-amber-50 text-amber-700 border-amber-200 border text-[10px]"
                        }
                      >
                        {l.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DialogContent>
      </Dialog>

      {/* Open Roles / Resignations quick info modals */}
      <Dialog open={modal?.type === "openRoles"} onOpenChange={() => setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Open Job Roles</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[#006496]/60 py-2">
            There are currently <strong>{data?.openRoles ?? 0}</strong> open job postings.
            Go to the <em>Required Roles</em> section to manage department headcount and job vacancies.
          </p>
        </DialogContent>
      </Dialog>

      <Dialog open={modal?.type === "resignations"} onOpenChange={() => setModal(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pending Resignations</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[#006496]/60 py-2">
            There are <strong className="text-red-600">{data?.pendingResignations ?? 0}</strong> pending resignation requests awaiting review.
            Go to the <em>Resignations</em> section to approve or reject them.
          </p>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
