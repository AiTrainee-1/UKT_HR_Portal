import { useMemo, useState } from "react";
import {
  ArrowRight,
  Award,
  Building2,
  CalendarDays,
  Info,
  Loader2,
  TrendingUp,
  TriangleAlert,
  UserSearch,
} from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { useToast } from "@/hooks/use-toast";
import { useCreatePromotion } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { formatDate, tenureLabel } from "../career/dates";
import { Chip, EmptyState, PersonCell } from "../career/parts";
import {
  checkPromotion,
  employeeTimeline,
  fullName,
  lastPromotionDates,
  monthsInRole,
  type PromoEmployee,
  type PromotionRecord,
} from "./logic";
import Timeline from "./Timeline";

type Designation = { id: number; title: string; departmentName?: string | null };
type Department = { id: number; name: string };

const KEEP = "keep";

type Props = {
  employees: PromoEmployee[];
  loading: boolean;
  designations: Designation[];
  departments: Department[];
  promotions: PromotionRecord[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  onDeleteRequest: (record: PromotionRecord) => void;
  today: string;
};

export default function PromoteTab({
  employees,
  loading,
  designations,
  departments,
  promotions,
  selectedId,
  onSelect,
  onDeleteRequest,
  today,
}: Props) {
  const employee = useMemo(() => employees.find((e) => e.id === selectedId) ?? null, [employees, selectedId]);
  const records = useMemo(() => promotions.filter((p) => p.employeeId === selectedId), [promotions, selectedId]);

  return (
    <div className="space-y-4 pt-3">
      <Card className="rounded-2xl">
        <CardContent className="flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:gap-4">
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-700 sm:w-44">
            <UserSearch size={16} className="text-gray-400" /> Employee to promote
          </div>
          <div className="max-w-md flex-1">
            <EmployeeSearchSelect
              employees={employees}
              value={selectedId ? String(selectedId) : ""}
              onChange={(v) => onSelect(v ? Number(v) : null)}
              placeholder={loading ? "Loading employees…" : "Search by employee code or name…"}
              dataTestId="promotion-employee-select"
            />
          </div>
        </CardContent>
      </Card>

      {!employee ? (
        <Card className="rounded-2xl">
          <CardContent className="p-0">
            <EmptyState
              testId="promote-empty"
              icon={Award}
              tone="bg-emerald-50 text-emerald-600"
              title="Pick an employee to promote"
              text="Search by code or name. You will see their current position, their promotion history and a before / after of the change."
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-4 lg:grid-cols-5">
          <div className="space-y-4 lg:col-span-2">
            <PositionCard employee={employee} records={records} today={today} />
            <Card className="rounded-2xl">
              <CardContent className="space-y-3 p-4">
                <p className="text-xs font-bold uppercase tracking-wider text-gray-400">
                  Career history ({records.length} promotion{records.length === 1 ? "" : "s"})
                </p>
                {records.length === 0 && (
                  <p className="text-xs text-gray-500" data-testid="no-previous-promotions">
                    No promotions on record yet.
                  </p>
                )}
                <Timeline entries={employeeTimeline(employee, records)} onDelete={onDeleteRequest} />
              </CardContent>
            </Card>
          </div>
          <PromoteForm
            key={employee.id}
            employee={employee}
            designations={designations}
            departments={departments}
            lastPromotion={lastPromotionDates(records).get(employee.id) ?? null}
            today={today}
          />
        </div>
      )}
    </div>
  );
}

function PositionCard({
  employee,
  records,
  today,
}: {
  employee: PromoEmployee;
  records: PromotionRecord[];
  today: string;
}) {
  const last = lastPromotionDates(records).get(employee.id) ?? null;
  const months = monthsInRole(employee.joinDate, last, today);
  return (
    <Card className="rounded-2xl" data-testid="current-position">
      <CardContent className="space-y-3 p-4">
        <p className="text-xs font-bold uppercase tracking-wider text-gray-400">Current position</p>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <PersonCell name={fullName(employee)} code={employee.employeeCode} photoUrl={employee.photoUrl} size={44} />
          </div>
          {employee.employmentType && (
            <Chip className="border-blue-200 bg-blue-50 capitalize text-blue-700">{employee.employmentType}</Chip>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <Fact label="Designation" value={employee.designationTitle} />
          <Fact label="Department" value={employee.departmentName} />
          <Fact label="Branch" value={employee.branchName} />
          <Fact label="Joined" value={employee.joinDate ? formatDate(employee.joinDate) : null} />
        </dl>
        {months != null && (
          <p
            className="flex items-center gap-1.5 rounded-lg bg-gray-50 px-3 py-2 text-xs text-gray-600"
            data-testid="time-in-role"
          >
            <CalendarDays size={13} className="text-gray-400" />
            {tenureLabel(months)} in this position
            <span className="text-gray-400">
              ({last ? `since the ${formatDate(last)} promotion` : "since joining"})
            </span>
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function Fact({ label, value }: { label: string; value?: string | null }) {
  return (
    <div className="rounded-lg border bg-white p-2.5">
      <dt className="mb-0.5 text-gray-400">{label}</dt>
      <dd className="font-bold text-gray-800">{value || "-"}</dd>
    </div>
  );
}

function PromoteForm({
  employee,
  designations,
  departments,
  lastPromotion,
  today,
}: {
  employee: PromoEmployee;
  designations: Designation[];
  departments: Department[];
  lastPromotion: string | null;
  today: string;
}) {
  const { toast } = useToast();
  const createMutation = useCreatePromotion();
  const [newDesignationId, setNewDesignationId] = useState("");
  const [newDepartmentId, setNewDepartmentId] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(today);
  const [notes, setNotes] = useState("");
  const [confirming, setConfirming] = useState(false);

  const check = checkPromotion(employee, { newDesignationId, newDepartmentId, effectiveDate }, today, lastPromotion);
  const chosenDesignation = designations.find((d) => String(d.id) === newDesignationId);
  const chosenDepartment = departments.find((d) => String(d.id) === newDepartmentId);
  const sortedDesignations = useMemo(
    () => [...designations].sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" })),
    [designations],
  );
  const sortedDepartments = useMemo(
    () => [...departments].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })),
    [departments],
  );
  const untouched = newDesignationId === "" && newDepartmentId === "";

  const submit = async () => {
    setConfirming(false);
    try {
      await createMutation.mutateAsync({
        employeeId: employee.id,
        newDepartmentId: newDepartmentId ? Number(newDepartmentId) : undefined,
        newDesignationId: newDesignationId ? Number(newDesignationId) : undefined,
        effectiveDate,
        notes: notes || undefined,
      });
      toast({ title: `${employee.firstName} promoted successfully` });
      setNewDesignationId("");
      setNewDepartmentId("");
      setEffectiveDate(today);
      setNotes("");
    } catch (err: unknown) {
      toast({ title: err instanceof Error ? err.message : "Promotion failed", variant: "destructive" });
    }
  };

  return (
    <Card className="rounded-2xl border-2 border-emerald-100 bg-emerald-50/20 lg:col-span-3" data-testid="promote-form">
      <CardContent className="space-y-4 p-4">
        <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-emerald-700">
          <TrendingUp size={13} /> Promote to
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="promo-designation" className="text-xs">
              New designation
            </Label>
            <Select value={newDesignationId || KEEP} onValueChange={(v) => setNewDesignationId(v === KEEP ? "" : v)}>
              <SelectTrigger id="promo-designation" className="h-10 bg-white" data-testid="promo-designation">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>Keep current ({employee.designationTitle ?? "none"})</SelectItem>
                {sortedDesignations.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.title}
                    {d.departmentName ? ` (${d.departmentName})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="promo-department" className="text-xs">
              New department
            </Label>
            <Select value={newDepartmentId || KEEP} onValueChange={(v) => setNewDepartmentId(v === KEEP ? "" : v)}>
              <SelectTrigger id="promo-department" className="h-10 bg-white" data-testid="promo-department">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={KEEP}>Keep current ({employee.departmentName ?? "none"})</SelectItem>
                {sortedDepartments.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="promo-date" className="text-xs">
              Effective date
            </Label>
            <Input
              id="promo-date"
              type="date"
              className="h-10 bg-white"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              data-testid="promo-date"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="promo-notes" className="text-xs">
              Notes (optional)
            </Label>
            <Input
              id="promo-notes"
              className="h-10 bg-white"
              placeholder="Reason / remarks"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="promo-notes"
            />
          </div>
        </div>

        {/* before / after */}
        <div className="grid items-stretch gap-2 sm:grid-cols-[1fr_auto_1fr]" data-testid="before-after">
          <Position
            title="Now"
            designation={employee.designationTitle}
            department={employee.departmentName}
            tone="bg-white"
          />
          <div className="flex items-center justify-center text-emerald-500">
            <ArrowRight size={18} className="rotate-90 sm:rotate-0" />
          </div>
          <Position
            title="After promotion"
            designation={chosenDesignation ? chosenDesignation.title : employee.designationTitle}
            department={chosenDepartment ? chosenDepartment.name : employee.departmentName}
            designationChanged={check.designationChanges}
            departmentChanged={check.departmentChanges}
            tone="bg-emerald-50"
          />
        </div>

        {/* what is wrong / worth a look */}
        {!untouched && check.errors.length > 0 && (
          <ul className="space-y-1 text-xs text-red-600" role="alert" data-testid="promo-errors">
            {check.errors.map((m) => (
              <li key={m} className="flex items-start gap-1.5">
                <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {m}
              </li>
            ))}
          </ul>
        )}
        {check.errors.length === 0 &&
          check.warnings.map((m) => (
            <p key={m} className="flex items-start gap-1.5 text-xs text-amber-700" data-testid="promo-warning">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" /> {m}
            </p>
          ))}

        <Button
          className="w-full gap-2 bg-emerald-600 hover:bg-emerald-700"
          onClick={() => setConfirming(true)}
          disabled={createMutation.isPending || check.errors.length > 0}
          data-testid="promote-submit"
        >
          {createMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Award size={14} />}
          {createMutation.isPending ? "Promoting…" : "Promote employee"}
        </Button>
        <p className="flex items-start gap-1.5 text-[11px] text-emerald-800/70">
          <Info size={12} className="mt-0.5 shrink-0" />
          The employee's profile is updated immediately and the previous designation and department are stored in the
          promotion history. A promotion does not change the salary: use Increment for that.
        </p>
      </CardContent>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="promote-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Promote {fullName(employee)}?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm">
                <p>
                  {chosenDesignation && (
                    <>
                      Designation: <b>{employee.designationTitle ?? "none"}</b> to <b>{chosenDesignation.title}</b>
                      .{" "}
                    </>
                  )}
                  {chosenDepartment && (
                    <>
                      Department: <b>{employee.departmentName ?? "none"}</b> to <b>{chosenDepartment.name}</b>.
                    </>
                  )}
                </p>
                <p>Effective {formatDate(effectiveDate)}. Their profile changes straight away.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="promote-confirm-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={submit}
              className="bg-emerald-600 hover:bg-emerald-700"
              data-testid="promote-confirm-yes"
            >
              Promote
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function Position({
  title,
  designation,
  department,
  designationChanged,
  departmentChanged,
  tone,
}: {
  title: string;
  designation?: string | null;
  department?: string | null;
  designationChanged?: boolean;
  departmentChanged?: boolean;
  tone: string;
}) {
  const row = (icon: React.ReactNode, label: string, value?: string | null, changed?: boolean) => (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm",
        changed ? "bg-emerald-100 font-bold text-emerald-900" : "text-gray-700",
      )}
    >
      <span className="text-gray-400">{icon}</span>
      <span className="sr-only">{label}:</span>
      <span className="truncate">{value || "-"}</span>
      {changed && <Chip className="ml-auto border-emerald-300 bg-white text-emerald-700">new</Chip>}
    </div>
  );
  return (
    <div className={cn("space-y-1 rounded-xl border p-2.5", tone)}>
      <p className="px-2.5 text-[10px] font-bold uppercase tracking-wider text-gray-400">{title}</p>
      {row(<Award size={13} />, "Designation", designation, designationChanged)}
      {row(<Building2 size={13} />, "Department", department, departmentChanged)}
    </div>
  );
}
