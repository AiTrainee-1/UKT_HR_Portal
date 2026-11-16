import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useAssignSpecialShift,
  useListEmployeesLite,
  type SpecialProductionShift,
} from "@/lib/api-client/custom-hooks";

/**
 * Put production workers on a special shift from a date (optionally up to a last day). A worker whose earlier special
 * shift is still running moves over (it ends the day before); the server refuses one who already has a special shift
 * starting on or after the date, and says who.
 */
export default function SpecialAssignDialog({
  open,
  onClose,
  shift,
  today,
}: {
  open: boolean;
  onClose: () => void;
  shift: SpecialProductionShift;
  today: string;
}) {
  const { toast } = useToast();
  const assign = useAssignSpecialShift();
  const { data: employees = [], isLoading } = useListEmployeesLite({ status: "active", employmentType: "production" });
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [from, setFrom] = useState(today);
  const [until, setUntil] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onItNow = useMemo(
    () => new Set(shift.assignments.filter((a) => a.state !== "ended").map((a) => a.employeeId)),
    [shift.assignments],
  );
  const production = employees.filter((e) => (e.employmentType ?? "staff") === "production");
  const shown = production.filter((e) => {
    const q = query.trim().toLowerCase();
    return (
      !q ||
      `${e.firstName} ${e.lastName ?? ""}`.toLowerCase().includes(q) ||
      e.employeeCode.toLowerCase().includes(q) ||
      (e.departmentName ?? "").toLowerCase().includes(q)
    );
  });
  const toggle = (id: number) =>
    setPicked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allShown = shown.length > 0 && shown.every((e) => picked.has(e.id));

  const submit = async () => {
    if (picked.size === 0) {
      setError("Choose at least one worker.");
      return;
    }
    if (!from) {
      setError("Choose the start date.");
      return;
    }
    if (until && until < from) {
      setError("The last day cannot be before the start date.");
      return;
    }
    try {
      const res = await assign.mutateAsync({
        id: shift.id,
        employeeIds: [...picked],
        effectiveFrom: from,
        effectiveTo: until || null,
      });
      toast({ title: `${res.assigned ?? picked.size} worker(s) put on ${shift.label}` });
      res.warnings?.forEach((w) => toast({ title: "Note", description: w }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Nobody was put on the shift.");
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto" data-testid="special-assign-dialog">
        <DialogHeader>
          <DialogTitle>Put workers on {shift.label}</DialogTitle>
          <DialogDescription>
            From the start date they are judged and paid by {shift.label} on its days; on other days, and after the last
            day, by the default production shifts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs font-semibold text-gray-700">
              From
              <Input
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
                data-testid="special-assign-from"
              />
            </label>
            <label className="space-y-1 text-xs font-semibold text-gray-700">
              Last day (optional)
              <Input
                type="date"
                value={until}
                min={from}
                onChange={(e) => setUntil(e.target.value)}
                data-testid="special-assign-until"
              />
            </label>
          </div>

          <div className="relative">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search production workers by name, code or department"
              className="pl-8"
              data-testid="special-assign-search"
            />
          </div>

          <div className="flex items-center justify-between text-xs text-gray-600">
            <label className="flex items-center gap-2">
              <Checkbox
                checked={allShown}
                onCheckedChange={() =>
                  setPicked((cur) => {
                    const next = new Set(cur);
                    if (allShown) shown.forEach((e) => next.delete(e.id));
                    else shown.forEach((e) => next.add(e.id));
                    return next;
                  })
                }
                aria-label="Choose every worker listed"
              />
              Every worker listed ({shown.length})
            </label>
            <span data-testid="special-assign-count">
              <b>{picked.size}</b> chosen
            </span>
          </div>

          <ul
            className="max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-100"
            data-testid="special-assign-list"
          >
            {isLoading ? (
              <li className="px-3 py-4 text-center text-xs text-gray-400">Loading the production workers…</li>
            ) : shown.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-gray-400">No production worker matches.</li>
            ) : (
              shown.map((e) => (
                <li key={e.id}>
                  <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-xs hover:bg-slate-50">
                    <Checkbox
                      checked={picked.has(e.id)}
                      onCheckedChange={() => toggle(e.id)}
                      data-testid={`special-assign-pick-${e.id}`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-semibold text-gray-900">
                        {e.firstName} {e.lastName ?? ""}{" "}
                        <span className="font-mono text-[11px] font-normal text-gray-500">{e.employeeCode}</span>
                      </span>
                      <span className="block truncate text-[11px] text-gray-500">
                        {e.departmentName ?? "No department"}
                      </span>
                    </span>
                    {onItNow.has(e.id) && (
                      <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-semibold text-violet-700">
                        on it
                      </span>
                    )}
                  </label>
                </li>
              ))
            )}
          </ul>

          {error && (
            <p
              className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700"
              data-testid="special-assign-error"
            >
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={assign.isPending} data-testid="special-assign-save">
            {assign.isPending ? "Saving…" : `Put ${picked.size || ""} on ${shift.label}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
