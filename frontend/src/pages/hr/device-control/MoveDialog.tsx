import { useState } from "react";
import { ArrowRightLeft, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  useDeleteDeviceUsers,
  usePushDeviceUsers,
  type DeviceControlDevice,
  type PersonRow,
} from "@/lib/api-client/custom-hooks";
import { DeviceTargets, OperationStatus } from "./PushParts";
import type { ChangeOutcome } from "./ResultDialog";
import { copyInput, isUnreachable, movedSafely, shortDeviceName } from "./logic";

/**
 * Data Push -> Edit Users -> Move (owner 2026-11-17: "transfer an employee to another device"). Two steps, both kept in
 * the history as a move: the people are put on the new devices (with what the old one holds for them), and only those
 * every new device then confirms having are taken off the old one. Nobody can end up on no device. Their employee
 * record is never touched.
 */
export default function MoveDialog({
  people,
  source,
  devices,
  onClose,
  onOutcome,
}: {
  people: PersonRow[];
  source: DeviceControlDevice;
  devices: DeviceControlDevice[];
  onClose: () => void;
  onOutcome: (outcome: ChangeOutcome) => void;
}) {
  const { toast } = useToast();
  const push = usePushDeviceUsers();
  const remove = useDeleteDeviceUsers();
  const [targets, setTargets] = useState<number[]>([]);
  const [busy, setBusy] = useState<"" | "adding" | "removing">("");
  const others = devices.filter((d) => d.id !== source.id);
  const chosen = devices.filter((d) => targets.includes(d.id));
  // the record the old device holds is what the new ones get
  const fromSource = (p: PersonRow): PersonRow => ({
    ...p,
    presence: [...p.presence].sort((a, b) => Number(b.deviceId === source.id) - Number(a.deviceId === source.id)),
  });

  const go = async () => {
    try {
      setBusy("adding");
      const ids = people.map((p) => p.userId);
      const added = await push.mutateAsync({
        deviceIds: targets,
        users: people.map((p) => copyInput(fromSource(p))),
        context: "transfer",
      });
      const safe = movedSafely(added, ids, targets);
      const extra: string[] = [];
      if (safe.length > 0 && !isUnreachable(source)) {
        setBusy("removing");
        const removed = await remove.mutateAsync({
          userIds: safe,
          deviceIds: [source.id],
          markInactive: false,
          context: "transfer",
        });
        const gone = removed.results.find((r) => r.deviceId === source.id);
        if (gone?.ok) extra.push(`Taken off ${source.name}: ${gone.deleted.length} of ${safe.length}.`);
        else extra.push(`Could not take them off ${source.name}: ${gone?.error ?? "no answer"}. They are on both now.`);
      } else if (safe.length > 0) {
        extra.push(`${source.name} cannot be reached now, so they stay on it too. Delete them there later.`);
      }
      const kept = ids.length - safe.length;
      if (kept > 0)
        extra.push(
          `${kept} ${kept === 1 ? "person stays" : "people stay"} on ${source.name}: not every new device took them.`,
        );
      onClose();
      onOutcome({ kind: "push", result: added, extra });
    } catch (e) {
      toast({
        title: "Could not move them",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusy("");
    }
  };

  const who = people.length === 1 ? people[0].name || people[0].userId : `${people.length} people`;

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-3xl overflow-y-auto" data-testid="move-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft size={18} /> Move {who} from {shortDeviceName(source.name)}
          </DialogTitle>
          <DialogDescription>
            They are put on the devices you choose with what {source.name} holds for them, then taken off {source.name}.
            Their face or finger enrolment does not travel: they enrol again on the new device.
          </DialogDescription>
        </DialogHeader>

        {busy ? (
          <OperationStatus
            devices={busy === "adding" ? chosen : [source]}
            waiting={busy === "adding" ? push.waiting : remove.waiting}
            label={busy === "adding" ? "Putting them on the new devices…" : `Taking them off ${source.name}…`}
          />
        ) : (
          <DeviceTargets
            devices={others}
            chosen={targets}
            onChange={setTargets}
            note={(d) => {
              const there = people.filter((p) => p.presence.some((x) => x.deviceId === d.id)).length;
              if (there === 0) return null;
              return there === people.length ? "already has them" : `already has ${there} of ${people.length}`;
            }}
            testId="move-targets"
          />
        )}

        <p className="flex items-start gap-1.5 text-xs text-slate-500">
          <ShieldCheck size={13} className="mt-0.5 shrink-0 text-emerald-600" />
          Someone is only taken off {source.name} once every new device has them. Their HRMS record and attendance are
          not touched.
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={!!busy}>
            Cancel
          </Button>
          <Button type="button" onClick={go} disabled={!!busy || targets.length === 0} data-testid="move-confirm">
            Move to {targets.length} device{targets.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
