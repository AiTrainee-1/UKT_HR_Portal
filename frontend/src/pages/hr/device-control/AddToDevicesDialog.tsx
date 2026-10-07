import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
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
import { useToast } from "@/hooks/use-toast";
import { usePushDeviceUsers, type DeviceControlDevice, type PersonRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ConnectionChip } from "./parts";
import type { ChangeOutcome } from "./ResultDialog";
import { copyInput } from "./logic";

/** Put people who are already known (on another device, or only in the HRMS) onto more devices, with the details the
 *  devices already hold for them. The password is never copied: the page never learns it. */
export default function AddToDevicesDialog({
  people,
  devices,
  deviceId,
  onClose,
  onOutcome,
}: {
  people: PersonRow[];
  devices: DeviceControlDevice[];
  /** The device whose chip was clicked: the only one ticked to start with. */
  deviceId?: number | null;
  onClose: () => void;
  onOutcome: (outcome: ChangeOutcome) => void;
}) {
  const { toast } = useToast();
  const push = usePushDeviceUsers();
  const usable = (d: DeviceControlDevice) => d.isActive && d.connection.state === "connected";
  const missing = (d: DeviceControlDevice) => people.filter((p) => !p.presence.some((x) => x.deviceId === d.id)).length;
  const [chosen, setChosen] = useState<Set<number>>(() => {
    const ready = devices
      .filter((d) => usable(d) && people.some((p) => !p.presence.some((x) => x.deviceId === d.id)))
      .map((d) => d.id);
    return new Set(deviceId != null && ready.includes(deviceId) ? [deviceId] : ready);
  });
  const [busy, setBusy] = useState(false);
  const total = devices.filter((d) => chosen.has(d.id)).reduce((n, d) => n + missing(d), 0);

  const go = async () => {
    setBusy(true);
    try {
      const result = await push.mutateAsync({ deviceIds: [...chosen], users: people.map(copyInput) });
      onClose();
      onOutcome({ kind: "push", result });
    } catch (e) {
      toast({
        title: "Could not add them",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy(false);
    }
  };

  const heading =
    people.length === 1
      ? `Add ${people[0].name || people[0].userId} to more devices`
      : `Add ${people.length} people to more devices`;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-lg" data-testid="add-to-devices-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload size={18} /> {heading}
          </DialogTitle>
          <DialogDescription>
            Each person is written with the name, role and card the devices already hold for them (or their HRMS name).
            Anyone a device already has is left alone.
          </DialogDescription>
        </DialogHeader>

        <div className="divide-y rounded-xl border" data-testid="add-to-devices-list">
          {devices
            .filter((d) => d.isActive)
            .map((d) => {
              const need = missing(d);
              const ok = usable(d) && need > 0;
              return (
                <label
                  key={d.id}
                  className={cn(
                    "flex items-center gap-3 px-3 py-2 text-sm",
                    ok ? "cursor-pointer hover:bg-slate-50" : "opacity-60",
                  )}
                >
                  <Checkbox
                    checked={chosen.has(d.id)}
                    disabled={!ok}
                    onCheckedChange={(c) =>
                      setChosen((prev) => {
                        const next = new Set(prev);
                        if (c === true) next.add(d.id);
                        else next.delete(d.id);
                        return next;
                      })
                    }
                    data-testid={`add-device-${d.id}`}
                    aria-label={d.name}
                  />
                  <span className="min-w-0 flex-1 font-semibold text-slate-800">{d.name}</span>
                  <span className="text-xs text-slate-500">
                    {need === 0 ? "already has everyone" : `${need} to add`}
                  </span>
                  <ConnectionChip device={d} />
                </label>
              );
            })}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="button" onClick={go} disabled={busy || chosen.size === 0} data-testid="add-to-devices-confirm">
            {busy && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Add {total} {total === 1 ? "entry" : "entries"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
