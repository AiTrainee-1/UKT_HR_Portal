import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useListBranches } from "@/lib/api-client";
import type { HolidayInput } from "./api";
import { dateOnly, type HolidayRow } from "./logic";

const EVERY_BRANCH = "none";

type Draft = {
  name: string;
  date: string;
  holidayType: string;
  description: string;
  isRecurring: boolean;
  branch: string;
};

const blank = (): Draft => ({
  name: "",
  date: "",
  holidayType: "national",
  description: "",
  isRecurring: false,
  branch: EVERY_BRANCH,
});

const fromHoliday = (h: HolidayRow): Draft => ({
  name: h.name,
  date: dateOnly(h.date) ?? "",
  holidayType: h.holidayType,
  description: h.description ?? "",
  isRecurring: h.isRecurring,
  branch: h.branchId != null ? String(h.branchId) : EVERY_BRANCH,
});

/** Add a holiday, or change one (`holiday` set). */
export default function HolidayDialog({
  open,
  holiday,
  saving,
  onClose,
  onSave,
}: {
  open: boolean;
  holiday: HolidayRow | null;
  saving: boolean;
  onClose: () => void;
  onSave: (input: HolidayInput) => void;
}) {
  const [draft, setDraft] = useState<Draft>(blank());
  const [problem, setProblem] = useState<string | null>(null);
  const branches = useListBranches();

  useEffect(() => {
    if (open) {
      setDraft(holiday ? fromHoliday(holiday) : blank());
      setProblem(null);
    }
  }, [open, holiday]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    if (!draft.name.trim() || !draft.date) {
      setProblem("Name and date are required");
      return;
    }
    onSave({
      name: draft.name.trim(),
      date: draft.date,
      holidayType: draft.holidayType,
      description: draft.description.trim(),
      isRecurring: draft.isRecurring,
      branchId: draft.branch === EVERY_BRANCH ? null : Number(draft.branch),
    });
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="holiday-dialog">
        <DialogHeader>
          <DialogTitle>{holiday ? "Edit Holiday" : "Add Holiday"}</DialogTitle>
          <DialogDescription>
            A holiday is a paid day off in attendance and payroll for the branch it applies to.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="holiday-name">Holiday Name</Label>
            <Input
              id="holiday-name"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Pongal"
              data-testid="holiday-name"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="holiday-date">Date</Label>
              <Input
                id="holiday-date"
                type="date"
                value={draft.date}
                onChange={(e) => set({ date: e.target.value })}
                data-testid="holiday-date"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={draft.holidayType} onValueChange={(holidayType) => set({ holidayType })}>
                <SelectTrigger aria-label="Holiday type" data-testid="holiday-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="national">National</SelectItem>
                  <SelectItem value="regional">Regional</SelectItem>
                  <SelectItem value="company">Company</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Applies to</Label>
            <Select value={draft.branch} onValueChange={(branch) => set({ branch })}>
              <SelectTrigger aria-label="Branch the holiday applies to" data-testid="holiday-branch">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={EVERY_BRANCH}>Every branch</SelectItem>
                {(branches.data ?? []).map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="holiday-description">Description (optional)</Label>
            <Input
              id="holiday-description"
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Brief description"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input
              type="checkbox"
              checked={draft.isRecurring}
              onChange={(e) => set({ isRecurring: e.target.checked })}
              className="h-4 w-4 rounded border-gray-300"
              data-testid="holiday-recurring"
            />
            Repeats every year
          </label>
          {problem && (
            <p className="text-sm text-red-600" role="alert" data-testid="holiday-problem">
              {problem}
            </p>
          )}
          <div className="flex gap-3 pt-2">
            <Button variant="outline" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={save} disabled={saving} data-testid="holiday-save">
              {saving ? "Saving…" : holiday ? "Save Holiday" : "Add Holiday"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
