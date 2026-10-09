import { useMemo, useState } from "react";
import { AlertTriangle, Loader2, ShieldAlert, Trash2 } from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { permissionLevel, useAuth } from "@/contexts/AuthContext";
import { useDeleteDeviceUsers, type DeviceControlDevice, type PersonRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ConnectionChip } from "./parts";
import type { ChangeOutcome } from "./ResultDialog";
import { deleteImpact, isUnreachable, shortDeviceName } from "./logic";

const SHOWN = 6;

/** Delete people from devices, and (when asked) make their employees Inactive in the HRMS: never delete them there. */
export default function DeleteDialog({
  people,
  devices,
  onClose,
  onOutcome,
}: {
  people: PersonRow[];
  devices: DeviceControlDevice[];
  onClose: () => void;
  onOutcome: (outcome: ChangeOutcome) => void;
}) {
  const { toast } = useToast();
  const { user } = useAuth();
  const remove = useDeleteDeviceUsers();
  const canEditEmployees = permissionLevel(user, "employees") === "edit";

  // The devices these people are on, with how many of them each holds.
  const holding = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of people) for (const x of p.presence) counts.set(x.deviceId, (counts.get(x.deviceId) ?? 0) + 1);
    return devices.filter((d) => counts.has(d.id)).map((d) => ({ device: d, count: counts.get(d.id) ?? 0 }));
  }, [people, devices]);
  const [chosen, setChosen] = useState<Set<number>>(() => new Set(holding.map((h) => h.device.id)));
  const allChosen = chosen.size === holding.length;
  // Someone is made Inactive only where a device really removed them, so the preview leaves out devices that are down.
  const reachable = useMemo(() => devices.filter((d) => !isUnreachable(d)).map((d) => d.id), [devices]);
  const impact = useMemo(
    () => deleteImpact(people, allChosen ? null : [...chosen], reachable),
    [people, chosen, allChosen, reachable],
  );
  const [markInactive, setMarkInactive] = useState(
    () => canEditEmployees && people.some((p) => p.employee?.status === "active"),
  );
  const [busy, setBusy] = useState(false);
  const waiting = busy ? remove.waiting : "";

  const unreachable = holding.filter((h) => chosen.has(h.device.id) && isUnreachable(h.device));
  const makesInactive = markInactive && canEditEmployees ? impact.employees : [];

  const confirm = async () => {
    setBusy(true);
    try {
      const result = await remove.mutateAsync({
        userIds: people.map((p) => p.userId),
        deviceIds: allChosen ? undefined : [...chosen],
        markInactive: markInactive && canEditEmployees,
      });
      onClose();
      onOutcome({ kind: "delete", result });
    } catch (e) {
      toast({
        title: "Could not delete",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const heading =
    people.length === 1
      ? `Delete ${people[0].name || people[0].userId} from the devices?`
      : `Delete ${people.length} people from the devices?`;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto" data-testid="delete-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-red-700">
            <Trash2 size={18} /> {heading}
          </DialogTitle>
          <DialogDescription>
            They are removed from the devices you tick below, along with their enrolment on those devices. Their
            attendance already in the HRMS is not touched.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="divide-y rounded-xl border text-sm" data-testid="delete-people">
            {people.slice(0, SHOWN).map((p) => (
              <div key={p.userId} className="flex items-center justify-between gap-3 px-3 py-2">
                <span className="min-w-0 truncate font-semibold text-slate-800">{p.name || p.userId}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {p.userId} · on {p.deviceCount} device{p.deviceCount === 1 ? "" : "s"}
                </span>
              </div>
            ))}
            {people.length > SHOWN && (
              <p className="px-3 py-2 text-xs text-slate-500">and {people.length - SHOWN} more</p>
            )}
          </div>

          <section className="space-y-2">
            <h4 className="text-sm font-bold text-slate-800">Delete from</h4>
            <div className="divide-y rounded-xl border" data-testid="delete-devices">
              {holding.map(({ device, count }) => (
                <label
                  key={device.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-slate-50"
                >
                  <Checkbox
                    checked={chosen.has(device.id)}
                    onCheckedChange={(c) =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (c === true) next.add(device.id);
                        else next.delete(device.id);
                        return next;
                      })
                    }
                    data-testid={`delete-device-${device.id}`}
                    aria-label={device.name}
                  />
                  <span className="min-w-0 flex-1 font-semibold text-slate-800">{device.name}</span>
                  <span className="text-xs text-slate-500">
                    {count} of {people.length}
                  </span>
                  <ConnectionChip device={device} />
                </label>
              ))}
              {holding.length === 0 && (
                <p className="p-3 text-xs text-slate-500">None of these people is on a device.</p>
              )}
            </div>
            {unreachable.length > 0 && (
              <p className="flex items-start gap-1.5 text-xs text-amber-800">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {unreachable.map((h) => shortDeviceName(h.device.name)).join(", ")} cannot be reached right now, so
                nothing will be deleted there.
              </p>
            )}
          </section>

          {impact.admins.length > 0 && (
            <p
              className="flex items-start gap-1.5 rounded-lg bg-violet-50 p-2.5 text-xs leading-snug text-violet-900"
              data-testid="delete-admins"
            >
              <ShieldAlert size={13} className="mt-0.5 shrink-0" />
              <span>
                {impact.admins.map((a) => `${a.person.name || a.person.userId} (${a.role})`).join(", ")} can open the
                device menu. Make sure someone else is left who can.
              </span>
            </p>
          )}

          <section className="space-y-2 rounded-xl border bg-slate-50/70 p-3">
            <div className="flex items-start gap-3">
              <Switch
                checked={markInactive && canEditEmployees}
                onCheckedChange={setMarkInactive}
                disabled={!canEditEmployees}
                id="delete-inactive"
                data-testid="delete-mark-inactive"
              />
              <label htmlFor="delete-inactive" className="min-w-0 flex-1 cursor-pointer">
                <span className="block text-sm font-bold text-slate-800">
                  Also make the employee Inactive in the HRMS
                </span>
                <span className="mt-0.5 block text-xs leading-snug text-slate-500">
                  The employee is never deleted from the HRMS. Their record, history and Employee Code stay, so if they
                  join again you can find their earlier record.
                </span>
              </label>
            </div>
            {!canEditEmployees && (
              <p className="text-xs text-amber-800">
                Your role cannot edit employees, so they would be left as they are.
              </p>
            )}
            {markInactive && canEditEmployees && (
              <p
                className={cn("text-xs leading-snug", makesInactive.length ? "text-slate-700" : "text-slate-500")}
                data-testid="delete-inactive-summary"
              >
                {makesInactive.length > 0
                  ? `${makesInactive.length} ${makesInactive.length === 1 ? "employee" : "employees"} will become Inactive: ${makesInactive
                      .slice(0, 4)
                      .map((p) => p.employee!.name)
                      .join(", ")}${makesInactive.length > 4 ? ` and ${makesInactive.length - 4} more` : ""}.`
                  : "None of these people is an active employee, so nothing changes in the HRMS."}
              </p>
            )}
            {markInactive && canEditEmployees && impact.stayingElsewhere.length > 0 && (
              <p className="flex items-start gap-1.5 text-xs leading-snug text-amber-800">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                {impact.stayingElsewhere.length} of them {impact.stayingElsewhere.length === 1 ? "stays" : "stay"} on a
                device you did not tick, where they could still punch.
              </p>
            )}
          </section>
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {waiting && (
            <p className="mr-auto text-xs text-slate-500" role="status" data-testid="op-waiting">
              {waiting}
            </p>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-red-600 text-white hover:bg-red-700"
            onClick={confirm}
            disabled={busy || chosen.size === 0}
            data-testid="delete-confirm"
          >
            {busy && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Delete from {chosen.size} device{chosen.size === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
