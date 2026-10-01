import { useState } from "react";
import { AlertCircle, UserMinus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client/custom-fetch";
import { useEndShiftAssignments, useUpdateShiftAssignment, type ShiftAssignment } from "@/lib/api-client/custom-hooks";
import { addDaysIso, latestStart, pluralize, prettyDate, todayIso } from "./shift-logic";

/** Take people off their shift from a chosen last day. The days up to and including it keep the shift, so what has
 *  already been recorded (attendance, payroll) is untouched; from the next day they have no shift until reassigned. */
export function RemoveFromShiftDialog({
  people,
  onClose,
  onDone,
}: {
  people: ShiftAssignment[];
  onClose: () => void;
  onDone?: () => void;
}) {
  const { toast } = useToast();
  const end = useEndShiftAssignments();
  const today = todayIso();
  const [lastDay, setLastDay] = useState(today);

  // A shift that has already begun cannot be ended before the day it began (one not begun yet is simply cancelled).
  const started = people.filter((p) => p.effectiveFrom <= today);
  const earliest = latestStart(started);
  const tooEarly = !!lastDay && !!earliest && lastDay < earliest;
  const names = people.slice(0, 3).map((p) => p.employeeName);
  const who = people.length <= 3 ? names.join(", ") : `${names.join(", ")} and ${people.length - 3} more`;

  const submit = async () => {
    try {
      const res = await end.mutateAsync({ assignmentIds: people.map((p) => p.id), lastDay });
      toast({
        title: `${pluralize(res.ended + res.cancelled, "employee")} taken off their shift`,
        description: res.ended ? `They keep it up to and including ${prettyDate(res.lastDay)}.` : undefined,
      });
      onDone?.();
      onClose();
    } catch (e) {
      toast({
        title: "Could not take them off the shift",
        description: e instanceof ApiError || e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={people.length > 0} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="remove-shift-dialog">
        <DialogHeader className="items-center text-center sm:items-start sm:text-left">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-red-50 text-red-600">
              <UserMinus size={19} />
            </span>
            <DialogTitle>Take {pluralize(people.length, "employee")} off their shift?</DialogTitle>
          </div>
          <DialogDescription className="pt-1 text-sm">{who}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <label htmlFor="last-day" className="block text-sm font-semibold text-gray-800">
            Last day on this shift
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="last-day"
              type="date"
              value={lastDay}
              onChange={(e) => setLastDay(e.target.value)}
              className="h-9 w-44"
              aria-invalid={tooEarly}
              data-testid="last-day"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs"
              onClick={() => setLastDay(addDaysIso(today, -1))}
            >
              Yesterday
            </Button>
            <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setLastDay(today)}>
              Today
            </Button>
          </div>
          {tooEarly ? (
            <p className="flex items-start gap-1 text-xs font-medium text-red-600" role="alert">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              Someone here has been on their shift since {prettyDate(earliest)}. The last day cannot be before that.
            </p>
          ) : (
            lastDay && (
              <p className="text-xs text-muted-foreground">
                They keep the shift up to and including {prettyDate(lastDay)}. From {prettyDate(addDaysIso(lastDay, 1))}{" "}
                they are on no shift until you assign one. Attendance and payroll already recorded do not change.
              </p>
            )
          )}
        </div>

        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={() => void submit()}
            disabled={end.isPending || !lastDay || tooEarly}
            data-testid="remove-shift-confirm"
          >
            {end.isPending ? "Removing…" : "Remove from shift"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Change one person's own hours on their shift (a custom start / end, Saturday off) without touching the shift. */
export function EditScheduleDialog({ person, onClose }: { person: ShiftAssignment; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const update = useUpdateShiftAssignment();
  const [start, setStart] = useState(person.customStartTime ?? "");
  const [endTime, setEndTime] = useState(person.customEndTime ?? "");
  const [saturdayOff, setSaturdayOff] = useState(person.saturdayOff);
  const [serverError, setServerError] = useState<string | null>(null);

  const effStart = start || person.startTime || "";
  const effEnd = endTime || person.endTime || "";
  const wrong = (!!start || !!endTime) && !!effStart && !!effEnd && effEnd <= effStart;
  const staff = person.shiftType !== "production";

  const submit = async () => {
    setServerError(null);
    try {
      await update.mutateAsync({
        id: person.id,
        data: {
          customStartTime: start || null,
          customEndTime: endTime || null,
          saturdayOff: staff ? saturdayOff : false,
        },
      });
    } catch (e) {
      const fields =
        e instanceof ApiError
          ? ((e.data as { fieldErrors?: Record<string, string> } | null)?.fieldErrors ?? null)
          : null;
      setServerError(fields ? Object.values(fields)[0] : e instanceof Error ? e.message : "Could not save");
      return;
    }
    await queryClient.invalidateQueries({ queryKey: ["/api/shift-assignments"] });
    toast({ title: `${person.employeeName}'s schedule updated` });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="edit-schedule-dialog">
        <DialogHeader>
          <DialogTitle>Schedule for {person.employeeName}</DialogTitle>
          <DialogDescription className="text-xs">
            {person.shiftName} runs {person.startTime}–{person.endTime}. Leave a field blank to use that.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="es-start" className="mb-1 block text-xs font-semibold text-gray-700">
                Custom start
              </label>
              <Input
                id="es-start"
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                data-testid="es-start"
              />
            </div>
            <div>
              <label htmlFor="es-end" className="mb-1 block text-xs font-semibold text-gray-700">
                Custom end
              </label>
              <Input
                id="es-end"
                type="time"
                value={endTime}
                onChange={(e) => setEndTime(e.target.value)}
                aria-invalid={wrong}
                data-testid="es-end"
              />
            </div>
          </div>
          {staff && (
            <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2.5">
              <span>
                <span className="block text-sm font-semibold text-gray-900">Saturday off</span>
                <span className="block text-xs text-muted-foreground">Monday to Friday only</span>
              </span>
              <Switch
                checked={saturdayOff}
                onCheckedChange={setSaturdayOff}
                aria-label="Saturday off"
                data-testid="es-saturday"
              />
            </label>
          )}
          {(wrong || serverError) && (
            <p className="flex items-start gap-1 text-xs font-medium text-red-600" role="alert">
              <AlertCircle size={12} className="mt-0.5 shrink-0" />
              {wrong ? "A shift cannot end before it starts. Overnight shifts are not supported." : serverError}
            </p>
          )}
        </div>
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={update.isPending || wrong} data-testid="es-save">
            {update.isPending ? "Saving…" : "Save schedule"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
