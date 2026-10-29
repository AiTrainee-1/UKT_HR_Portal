import { useEffect, useState } from "react";
import { CalendarCheck, Loader2 } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { usePunchDayStatus, useSetPunchDayStatus, type PunchDayStatusValue } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatusChip, todayISO } from "./parts";

type Choice = "present" | "half_shift" | "absent" | "auto";

const CHOICES: { value: Choice; label: string; hint: string; tone: string }[] = [
  { value: "present", label: "Present", hint: "1 shift", tone: "border-green-300 bg-green-50 text-green-800" },
  { value: "half_shift", label: "Half Day", hint: "0.5 shift", tone: "border-amber-300 bg-amber-50 text-amber-800" },
  { value: "absent", label: "Absent", hint: "0 shift", tone: "border-red-300 bg-red-50 text-red-800" },
];

/**
 * Set one employee's day as Present, Half Day or Absent, straight from Punch View. It is applied at once as HR's own decision
 * (payroll reads it first and the automatic calculation leaves it alone) and is written to the History with the status it
 * replaced. "Back to automatic" hands the day back to the punches.
 */
export default function DayStatusDialog({
  open,
  onClose,
  initialCode = "",
  initialDate = "",
}: {
  open: boolean;
  onClose: () => void;
  initialCode?: string;
  initialDate?: string;
}) {
  const { toast } = useToast();
  const save = useSetPunchDayStatus();
  const [code, setCode] = useState(initialCode);
  const [date, setDate] = useState(initialDate || todayISO());
  const [choice, setChoice] = useState<Choice | null>(null);
  const [note, setNote] = useState("");

  // a fresh form each time it opens
  useEffect(() => {
    if (open) {
      setCode(initialCode);
      setDate(initialDate || todayISO());
      setChoice(null);
      setNote("");
    }
  }, [open, initialCode, initialDate]);

  const day = usePunchDayStatus(code, date);
  const found = day.data && !day.isError ? day.data : null;
  const reasonNeeded = choice !== null && choice !== "auto";
  const reasonOk = !reasonNeeded || note.trim().length >= 3;
  const same = !!found && choice !== null && choice !== "auto" && found.status === choice && found.source === "manual";
  const canSave = !!found && choice !== null && reasonOk && !same && !save.isPending;

  const submit = async () => {
    if (!found || choice === null) return;
    try {
      await save.mutateAsync({ code: found.code, date, status: choice, note: note.trim() });
      toast({
        title:
          choice === "auto"
            ? `${found.name}: ${date} is back to automatic`
            : `${found.name}: ${date} set to ${CHOICES.find((c) => c.value === choice)?.label}`,
      });
      onClose();
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !save.isPending && onClose()}>
      <DialogContent className="max-w-lg" data-testid="day-status-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CalendarCheck size={18} /> Set a day&apos;s status
          </DialogTitle>
          <DialogDescription>
            Present, Half Day or Absent for one employee and day. It applies at once, replaces what the punches say for
            that day, and is kept in the History. If an employee forgot to punch, they can also ask for it through
            Missing Punch.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="ds-code">Employee Code</Label>
              <Input
                id="ds-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g. 188"
                data-testid="day-status-code"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ds-date">Date</Label>
              <Input
                id="ds-date"
                type="date"
                max={todayISO()}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                data-testid="day-status-date"
              />
            </div>
          </div>

          {code.trim() && day.isFetching && !found && (
            <p className="flex items-center gap-2 text-xs text-slate-500">
              <Loader2 size={13} className="animate-spin" /> Looking…
            </p>
          )}
          {code.trim() && day.isError && (
            <p className="text-xs text-red-600" data-testid="day-status-error">
              {(day.error as Error)?.message || "That employee or day was not found."}
            </p>
          )}

          {found && (
            <div className="space-y-4" data-testid="day-status-found">
              <div className="rounded-xl border bg-slate-50/70 p-3 text-sm">
                <p className="font-bold text-slate-900">
                  {found.name} <span className="font-mono text-xs font-normal text-slate-500">{found.code}</span>
                </p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                  <span>{found.date}</span>
                  <StatusChip status={found.status} source={found.source} />
                  <span>
                    {found.punchCount} punch{found.punchCount === 1 ? "" : "es"}
                    {found.firstPunch ? ` · ${found.firstPunch} to ${found.lastPunch ?? "?"}` : ""}
                  </span>
                </p>
                {found.source === "manual" && (
                  <p className="mt-1 text-[11px] text-slate-500">
                    Set by hand{found.overrideBy ? ` by ${found.overrideBy}` : ""}
                    {found.overrideNote ? `: “${found.overrideNote}”` : ""}
                  </p>
                )}
              </div>

              <div className="space-y-1.5">
                <Label>Set the day as</Label>
                <div className="grid grid-cols-3 gap-2" role="group" aria-label="Status">
                  {CHOICES.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      aria-pressed={choice === c.value}
                      onClick={() => setChoice(c.value)}
                      data-testid={`day-status-${c.value}`}
                      className={cn(
                        "rounded-xl border px-3 py-2 text-left text-sm font-semibold transition",
                        choice === c.value
                          ? `${c.tone} ring-2 ring-offset-1 ring-current`
                          : "bg-white hover:bg-slate-50",
                      )}
                    >
                      {c.label}
                      <span className="block text-[11px] font-normal opacity-70">{c.hint}</span>
                    </button>
                  ))}
                </div>
                {found.source === "manual" && (
                  <button
                    type="button"
                    aria-pressed={choice === "auto"}
                    onClick={() => setChoice("auto")}
                    data-testid="day-status-auto"
                    className={cn(
                      "mt-1 rounded-lg border px-3 py-1.5 text-xs font-semibold",
                      choice === "auto"
                        ? "border-indigo-300 bg-indigo-50 text-indigo-800"
                        : "bg-white hover:bg-slate-50",
                    )}
                  >
                    Back to automatic (what the punches say)
                  </button>
                )}
              </div>

              {reasonNeeded && (
                <div className="space-y-1.5">
                  <Label htmlFor="ds-note">Reason</Label>
                  <Textarea
                    id="ds-note"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={2}
                    placeholder="A few words: why this day is being set by hand"
                    data-testid="day-status-note"
                  />
                  {!reasonOk && <p className="text-[11px] text-slate-500">The reason is kept in the History.</p>}
                </div>
              )}
              {same && <p className="text-xs text-slate-500">This day is already set to that by hand.</p>}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={!canSave} data-testid="day-status-save">
            {save.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type { PunchDayStatusValue };
