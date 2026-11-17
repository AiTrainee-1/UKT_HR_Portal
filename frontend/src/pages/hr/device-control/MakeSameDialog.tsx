import { useMemo, useState, type ReactNode } from "react";
import { CreditCard, Equal, IdCard, Loader2 } from "lucide-react";
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
import { useUpdateDeviceUsers, type DeviceControlDevice, type PersonRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { RolePill } from "./parts";
import type { ChangeOutcome } from "./ResultDialog";
import { deviceNameFor, makeSamePlan, presenceVariants, shortDeviceName, type PresenceVariant } from "./logic";

/**
 * Users in Device -> Make the same (owner 2026-11-17: "compare and manage consistency"). Pick the record that is right
 * (one a device holds: its name, role and card go to the devices holding something else) or the HRMS name, and only the
 * devices that differ are changed. Fingerprints, faces and passwords are not touched.
 */
export default function MakeSameDialog({
  person,
  devices,
  onClose,
  onOutcome,
}: {
  person: PersonRow;
  devices: DeviceControlDevice[];
  onClose: () => void;
  onOutcome: (outcome: ChangeOutcome) => void;
}) {
  const { toast } = useToast();
  const update = useUpdateDeviceUsers();
  const variants = useMemo(() => presenceVariants(person), [person]);
  const [source, setSource] = useState<PresenceVariant | "hrms">(() => variants[0] ?? "hrms");
  const plan = makeSamePlan(person, source);
  const nameOf = (id: number) => devices.find((d) => d.id === id)?.name ?? `#${id}`;

  const go = async () => {
    if (!plan) return;
    try {
      const result = await update.mutateAsync({ deviceIds: plan.deviceIds, users: [plan.input], context: "make_same" });
      onClose();
      onOutcome({ kind: "push", result });
    } catch (e) {
      toast({
        title: "Could not change them",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const option = (key: string, on: boolean, pick: () => void, body: ReactNode) => (
    <button
      key={key}
      type="button"
      role="radio"
      aria-checked={on}
      onClick={pick}
      className={cn(
        "flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
        on ? "border-[#006496] ring-2 ring-sky-100" : "hover:border-slate-300",
      )}
      data-view-safe
      data-testid={`make-same-${key}`}
    >
      <span
        aria-hidden
        className={cn(
          "mt-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2",
          on ? "border-[#006496]" : "border-slate-300",
        )}
      >
        {on && <span className="h-1.5 w-1.5 rounded-full bg-[#006496]" />}
      </span>
      <span className="min-w-0 flex-1 space-y-1">{body}</span>
    </button>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && !update.isPending && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto" data-testid="make-same-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Equal size={18} /> Make {person.employee?.name ?? person.name ?? person.userId} the same everywhere
          </DialogTitle>
          <DialogDescription>
            Choose what is right. Only the devices holding something else are changed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2" role="radiogroup" aria-label="What is right">
          {variants.map((v) =>
            option(
              v.key,
              source !== "hrms" && source.key === v.key,
              () => setSource(v),
              <>
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-slate-900">“{v.name || "(no name)"}”</span>
                  <RolePill privilege={v.privilege} />
                  {v.card ? (
                    <span className="inline-flex items-center gap-0.5 text-xs text-slate-500">
                      <CreditCard size={11} /> {v.card}
                    </span>
                  ) : (
                    <span className="text-xs text-slate-400">no card</span>
                  )}
                </span>
                <span className="block text-xs text-slate-500">
                  as on {v.deviceIds.map((id) => shortDeviceName(nameOf(id))).join(", ")}
                </span>
              </>,
            ),
          )}
          {person.employee &&
            option(
              "hrms",
              source === "hrms",
              () => setSource("hrms"),
              <>
                <span className="flex items-center gap-2 font-semibold text-slate-900">
                  <IdCard size={14} /> The HRMS name: “{deviceNameFor(person.employee.name)}”
                </span>
                <span className="block text-xs text-slate-500">Role and card stay as each device has them.</span>
              </>,
            )}
        </div>

        <p
          className={cn(
            "rounded-xl p-3 text-xs leading-snug",
            plan ? "bg-sky-50 text-sky-950" : "bg-slate-50 text-slate-600",
          )}
          data-testid="make-same-plan"
        >
          {plan
            ? `Changes ${plan.deviceIds.map((id) => nameOf(id)).join(", ")}.`
            : "Every device already holds this: nothing to change."}
        </p>

        <DialogFooter className="gap-2 sm:gap-2">
          {update.isPending && update.waiting && (
            <p className="mr-auto text-xs text-slate-500" role="status">
              {update.waiting}
            </p>
          )}
          <Button type="button" variant="ghost" onClick={onClose} disabled={update.isPending}>
            Cancel
          </Button>
          <Button type="button" onClick={go} disabled={!plan || update.isPending} data-testid="make-same-confirm">
            {update.isPending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            Change {plan?.deviceIds.length ?? 0} device{plan?.deviceIds.length === 1 ? "" : "s"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
