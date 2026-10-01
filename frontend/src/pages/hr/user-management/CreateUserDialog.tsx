import { useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { ArrowRight, Info, UserCheck } from "lucide-react";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useListEmployees } from "@/lib/api-client";
import { useCreateDepartmentManager } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ApprovalPermissionPicker } from "./ApprovalPermissionPicker";
import { allPermissions, enabledCount, type PermKey, type PermissionValues } from "./approval-permissions";

function Section({ n, title, hint, children }: { n: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-xs font-black text-white">
          {n}
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-bold leading-6 text-gray-900">{title}</h3>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
      <div className="sm:pl-8">{children}</div>
    </section>
  );
}

/** Add a Department User: pick the employee, choose what they may approve, optionally jump straight to assigning their
 *  departments. Employees who already are a department user are not offered (the server would refuse them). */
export default function CreateUserDialog({
  open,
  onClose,
  takenEmployeeIds,
}: {
  open: boolean;
  onClose: () => void;
  /** Employees who already are a department user. */
  takenEmployeeIds: number[];
}) {
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const [employeeId, setEmployeeId] = useState("");
  const [values, setValues] = useState<PermissionValues>(() => allPermissions(true));
  const [notes, setNotes] = useState("");

  const { data: employees } = useListEmployees({ status: "active" });
  const createMutation = useCreateDepartmentManager();

  const candidates = useMemo(() => {
    const taken = new Set(takenEmployeeIds);
    return (employees ?? []).filter((e) => !taken.has(e.id));
  }, [employees, takenEmployeeIds]);
  const chosen = candidates.find((e) => String(e.id) === employeeId);

  const reset = () => {
    setEmployeeId("");
    setNotes("");
    setValues(allPermissions(true));
  };

  const close = () => {
    reset();
    onClose();
  };

  const toggle = (key: PermKey) => setValues((v) => ({ ...v, [key]: !v[key] }));

  const submit = async (thenAssign: boolean) => {
    if (!chosen) {
      toast({ title: "Please select an employee", variant: "destructive" });
      return;
    }
    try {
      const created = await createMutation.mutateAsync({
        employeeCode: chosen.employeeCode!,
        ...values,
        notes: notes.trim() || undefined,
      });
      toast({ title: `${chosen.firstName} ${chosen.lastName} added as department user` });
      close();
      if (thenAssign) navigate(`/hr/user-management/${created.id}`);
    } catch (e: unknown) {
      toast({
        title: "Failed to create user",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  const nothingOn = enabledCount(values) === 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent
        className="flex max-h-[92vh] w-[calc(100%-1.5rem)] max-w-2xl flex-col gap-0 overflow-hidden p-0"
        data-testid="create-user-dialog"
      >
        <DialogHeader className="border-b bg-gradient-to-br from-blue-50 via-white to-indigo-50/60 px-5 py-4 pr-14 sm:px-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-sm">
              <UserCheck size={19} />
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-lg font-black">Add Department User</DialogTitle>
              <DialogDescription className="text-xs">
                A Department Head approves the requests of their team from the mobile app.
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-5 py-5 sm:px-6">
          <Section n={1} title="Who is the department head?" hint="Search by employee code or name.">
            <div className="space-y-2">
              <EmployeeSearchSelect
                employees={candidates}
                value={employeeId}
                onChange={setEmployeeId}
                placeholder="Search by employee code or name…"
              />
              {chosen && (
                <div
                  className="flex items-center gap-3 rounded-xl border bg-gray-50/70 p-2.5"
                  data-testid="chosen-employee"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 text-sm font-black text-white">
                    {chosen.firstName.charAt(0)}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-gray-900">
                      {chosen.firstName} {chosen.lastName}
                      <span className="ml-2 font-mono text-[11px] font-normal text-gray-400">
                        {chosen.employeeCode}
                      </span>
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {[chosen.designationTitle, chosen.departmentName].filter(Boolean).join(" · ") ||
                        "No designation or department"}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Section>

          <Section
            n={2}
            title="What can they approve?"
            hint="Switch off any kind of request this person should not decide. You can change this later."
          >
            <ApprovalPermissionPicker
              values={values}
              onToggle={toggle}
              onSetAll={(on) => setValues(allPermissions(on))}
            />
            {nothingOn && (
              <p className="mt-3 flex items-start gap-1.5 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <Info size={13} className="mt-0.5 shrink-0" />
                Every permission is off, so this person will not be able to decide any request.
              </p>
            )}
          </Section>

          <Section n={3} title="Notes" hint="Optional. Only HR sees it.">
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Covers the Cutting section"
              maxLength={200}
            />
          </Section>
        </div>

        <div
          className={cn(
            "flex flex-col-reverse gap-2 border-t bg-gray-50/80 px-5 py-3 sm:flex-row sm:items-center sm:justify-end sm:px-6",
          )}
        >
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => submit(false)}
            disabled={createMutation.isPending || !chosen}
            data-testid="create-user-only"
          >
            {createMutation.isPending ? "Adding…" : "Add User"}
          </Button>
          <Button
            className="gap-1.5"
            onClick={() => submit(true)}
            disabled={createMutation.isPending || !chosen}
            data-testid="create-user-and-assign"
          >
            Add &amp; choose departments <ArrowRight size={14} />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
