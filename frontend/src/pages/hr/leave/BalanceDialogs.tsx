import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import EmployeeSearchSelect from "@/components/EmployeeSearchSelect";
import type { AllocateInput, LeaveTypeInput, LeaveTypeItem } from "./api";
import { type BalanceView } from "./logic";

/** Give an employee a leave type's days for a year, or change what they were given (`editing`). */
export function AllocateDialog({
  open,
  editing,
  employees,
  types,
  year,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  editing: BalanceView | null;
  employees: unknown[] | undefined;
  types: LeaveTypeItem[];
  year: number;
  saving: boolean;
  onClose: () => void;
  onSave: (input: AllocateInput) => void;
}) {
  const [employeeId, setEmployeeId] = useState("");
  const [leaveTypeId, setLeaveTypeId] = useState("");
  const [allocated, setAllocated] = useState("");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    if (editing) {
      setEmployeeId(String(editing.employeeId));
      setLeaveTypeId(String(editing.leaveTypeId));
      setAllocated(String(editing.allocated));
    } else {
      setEmployeeId("");
      setLeaveTypeId(types[0] ? String(types[0].id) : "");
      setAllocated(types[0] ? String(types[0].maxDaysPerYear) : "");
    }
    // the dialog opens on a type's default days; changing `types` while it is open must not reset what was typed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const pickType = (id: string) => {
    setLeaveTypeId(id);
    const t = types.find((x) => String(x.id) === id);
    if (t && !editing) setAllocated(String(t.maxDaysPerYear));
  };

  const save = () => {
    const days = Number(allocated);
    if (!employeeId || !leaveTypeId) return setProblem("Choose an employee and a leave type");
    if (allocated.trim() === "" || !Number.isFinite(days) || days < 0 || days > 366) {
      return setProblem("Days must be a number from 0 to 366");
    }
    setProblem(null);
    onSave({ employeeId: Number(employeeId), leaveTypeId: Number(leaveTypeId), year, allocated: days });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="allocate-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? "Edit Allocation" : "Add Allocation"}</DialogTitle>
          <DialogDescription>
            Days an employee may take of one leave type in {year}. Days already used stay used: what is left is the new
            allocation minus them.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label>Employee</Label>
            {editing ? (
              <p className="flex h-9 items-center rounded-md border bg-gray-50 px-3 text-sm font-medium text-gray-700">
                {editing.employeeName}{" "}
                <span className="ml-2 font-mono text-xs text-gray-400">{editing.employeeCode}</span>
              </p>
            ) : (
              <EmployeeSearchSelect
                employees={employees as any[] | undefined}
                value={employeeId}
                onChange={setEmployeeId}
                dataTestId="allocate-employee"
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Leave type</Label>
              <Select value={leaveTypeId} onValueChange={pickType} disabled={!!editing}>
                <SelectTrigger aria-label="Leave type" data-testid="allocate-type">
                  <SelectValue placeholder="Choose a type" />
                </SelectTrigger>
                <SelectContent>
                  {types.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="allocate-days">Days</Label>
              <Input
                id="allocate-days"
                type="number"
                min={0}
                max={366}
                step={0.5}
                value={allocated}
                onChange={(e) => setAllocated(e.target.value)}
                data-testid="allocate-days"
              />
            </div>
          </div>
          {problem && (
            <p className="text-sm text-red-600" role="alert" data-testid="allocate-problem">
              {problem}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={save} disabled={saving} data-testid="allocate-save">
              {saving ? "Saving…" : editing ? "Save Allocation" : "Add Allocation"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function LeaveTypeDialog({
  open,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: (input: LeaveTypeInput) => void;
}) {
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [days, setDays] = useState("12");
  const [paid, setPaid] = useState(true);
  const [carry, setCarry] = useState(false);
  const [carryDays, setCarryDays] = useState("0");
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setCode("");
      setDays("12");
      setPaid(true);
      setCarry(false);
      setCarryDays("0");
      setProblem(null);
    }
  }, [open]);

  const save = () => {
    const max = Number(days);
    const carryMax = Number(carryDays);
    if (!name.trim() || !code.trim()) return setProblem("Name and code are required");
    if (!Number.isInteger(max) || max < 0 || max > 366)
      return setProblem("Days per year must be a whole number from 0 to 366");
    if (carry && (!Number.isInteger(carryMax) || carryMax < 0))
      return setProblem("Carry-forward days must be a whole number");
    setProblem(null);
    onSave({
      name: name.trim(),
      code: code.trim().toUpperCase(),
      maxDaysPerYear: max,
      carryForward: carry,
      maxCarryForwardDays: carry ? carryMax : 0,
      isPaid: paid,
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="leave-type-dialog">
        <DialogHeader>
          <DialogTitle>Add Leave Type</DialogTitle>
          <DialogDescription>A kind of leave employees can be given days of each year.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="lt-name">Name</Label>
              <Input
                id="lt-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Earned Leave"
                data-testid="lt-name"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="lt-code">Code</Label>
              <Input
                id="lt-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="EL"
                maxLength={8}
                data-testid="lt-code"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="lt-days">Days per year</Label>
            <Input
              id="lt-days"
              type="number"
              min={0}
              max={366}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              data-testid="lt-days"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={paid}
              onChange={(e) => setPaid(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Paid leave
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={carry}
              onChange={(e) => setCarry(e.target.checked)}
              className="h-4 w-4 rounded border-gray-300"
            />
            Unused days carry forward
          </label>
          {carry && (
            <div className="space-y-1.5">
              <Label htmlFor="lt-carry">Most days carried forward</Label>
              <Input
                id="lt-carry"
                type="number"
                min={0}
                value={carryDays}
                onChange={(e) => setCarryDays(e.target.value)}
              />
            </div>
          )}
          {problem && (
            <p className="text-sm text-red-600" role="alert" data-testid="lt-problem">
              {problem}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={save} disabled={saving} data-testid="lt-save">
              {saving ? "Adding…" : "Add Leave Type"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
