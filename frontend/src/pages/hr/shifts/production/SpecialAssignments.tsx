import { useState } from "react";
import { CalendarX2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/ui/status-badge";
import { useToast } from "@/hooks/use-toast";
import {
  useEndSpecialAssignment,
  useRemoveSpecialAssignment,
  type SpecialShiftAssignment,
} from "@/lib/api-client/custom-hooks";
import { Gate } from "@/lib/tab-access";
import { cn } from "@/lib/utils";

const STATE: Record<SpecialShiftAssignment["state"], { label: string; tone: "success" | "info" | "neutral" }> = {
  active: { label: "On it now", tone: "success" },
  upcoming: { label: "Starts later", tone: "info" },
  ended: { label: "Ended", tone: "neutral" },
};

const dmy = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};

const message = (e: unknown) => (e instanceof Error ? e.message : undefined);

/**
 * Who is (or was, or will be) on a special production shift, with the two things HR does (owner 2026-11-16): End (the
 * worker is on it up to and including a last day, the default shifts from the day after, the days worked so far stay on
 * the special shift) and Remove (takes the worker off it altogether: one not started yet goes at once; one that has
 * started is confirmed first, since every day it covered is worked out again with the default shifts). The answers
 * carry warnings about days worked out again.
 */
export default function SpecialAssignments({
  rows,
  today,
  showShift = false,
  shiftNames = {},
  testId,
}: {
  rows: SpecialShiftAssignment[];
  today: string;
  /** Add a column with the special shift's name (the Assignments tab lists every special shift together). */
  showShift?: boolean;
  shiftNames?: Record<number, string>;
  testId: string;
}) {
  const { toast } = useToast();
  const end = useEndSpecialAssignment();
  const remove = useRemoveSpecialAssignment();
  const [ending, setEnding] = useState<SpecialShiftAssignment | null>(null);
  const [removing, setRemoving] = useState<SpecialShiftAssignment | null>(null);
  const [lastDay, setLastDay] = useState(today);

  const warn = (warnings?: string[]) => warnings?.forEach((w) => toast({ title: "Note", description: w }));

  const confirmEnd = async () => {
    if (!ending) return;
    try {
      const res = await end.mutateAsync({ id: ending.id, lastDay });
      toast({ title: `${ending.employeeName} ends on ${dmy(lastDay)}` });
      warn(res.warnings);
      setEnding(null);
    } catch (e) {
      toast({ title: "Not ended", description: message(e), variant: "destructive" });
    }
  };

  const doRemove = async (a: SpecialShiftAssignment, force = false) => {
    try {
      const res = await remove.mutateAsync({ id: a.id, force });
      toast({ title: `${a.employeeName} taken off the special shift` });
      warn(res.warnings);
      setRemoving(null);
    } catch (e) {
      toast({ title: "Not removed", description: message(e), variant: "destructive" });
    }
  };
  // not started: nothing was paid by it yet, so it goes at once; started: confirmed first
  const askRemove = (a: SpecialShiftAssignment) => (a.state === "upcoming" ? void doRemove(a) : setRemoving(a));
  const workedTo = (a: SpecialShiftAssignment) => (a.effectiveTo && a.effectiveTo < today ? a.effectiveTo : today);

  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`${testId}-empty`}>
        Nobody is on it yet.
      </p>
    );
  }

  return (
    <>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-100" data-testid={testId}>
        {rows.map((a) => {
          const s = STATE[a.state];
          return (
            <li
              key={a.id}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-1 px-2.5 py-2 text-xs",
                a.state === "ended" && "opacity-70",
              )}
              data-testid={`${testId}-row-${a.id}`}
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-gray-900">
                  {a.employeeName}{" "}
                  <span className="font-mono text-[11px] font-normal text-gray-500">{a.employeeCode}</span>
                </p>
                <p className="text-[11px] text-gray-500">
                  {showShift && shiftNames[a.groupId] ? `${shiftNames[a.groupId]} · ` : ""}
                  {a.department ? `${a.department} · ` : ""}
                  {dmy(a.effectiveFrom)} → {a.effectiveTo ? dmy(a.effectiveTo) : "until further notice"}
                </p>
              </div>
              <StatusBadge tone={s.tone} className="text-[11px] sm:text-[10px]">
                {s.label}
              </StatusBadge>
              <Gate k="shifts.production_special">
                <div className="flex items-center gap-1">
                  {a.state !== "ended" && a.state !== "upcoming" && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1 px-2 text-[11px]"
                      onClick={() => {
                        setLastDay(today < a.effectiveFrom ? a.effectiveFrom : today);
                        setEnding(a);
                      }}
                      data-testid={`${testId}-end-${a.id}`}
                    >
                      <CalendarX2 size={12} /> End
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 gap-1 px-2 text-[11px] text-red-600 hover:text-red-700"
                    onClick={() => askRemove(a)}
                    disabled={remove.isPending}
                    data-testid={`${testId}-remove-${a.id}`}
                  >
                    <Trash2 size={12} /> Remove
                  </Button>
                </div>
              </Gate>
            </li>
          );
        })}
      </ul>

      <Dialog open={!!removing} onOpenChange={(o) => !o && setRemoving(null)}>
        <DialogContent className="max-w-md" data-testid="special-remove-dialog">
          <DialogHeader>
            <DialogTitle>Take {removing?.employeeName} off the special shift?</DialogTitle>
            <DialogDescription>
              {removing
                ? `They have been on it since ${dmy(removing.effectiveFrom)}. Their days from ${dmy(removing.effectiveFrom)} to ${dmy(workedTo(removing))} are then worked out again with the default production shifts. A production payroll already generated for those days needs Generate again; a Paid one never changes.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          {removing?.state === "active" && (
            <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">
              To keep the days already worked on the special shift, use <b>End</b> instead: they leave it from a day you
              choose.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              className="bg-red-600 hover:bg-red-700"
              onClick={() => removing && void doRemove(removing, true)}
              disabled={remove.isPending}
              data-testid="special-remove-confirm"
            >
              Remove {removing?.employeeName}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!ending} onOpenChange={(o) => !o && setEnding(null)}>
        <DialogContent className="max-w-sm" data-testid="special-end-dialog">
          <DialogHeader>
            <DialogTitle>End {ending?.employeeName}&apos;s special shift</DialogTitle>
            <DialogDescription>
              They stay on it up to and including the last day, and are back on the default production shifts from the
              day after.
            </DialogDescription>
          </DialogHeader>
          <label className="space-y-1 text-xs font-semibold text-gray-700">
            Last day on it
            <Input
              type="date"
              value={lastDay}
              min={ending?.effectiveFrom}
              onChange={(e) => setLastDay(e.target.value)}
              data-testid="special-end-date"
            />
          </label>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEnding(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => void confirmEnd()}
              disabled={!lastDay || end.isPending}
              data-testid="special-end-confirm"
            >
              End on {lastDay ? dmy(lastDay) : "…"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
