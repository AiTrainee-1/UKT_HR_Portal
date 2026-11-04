import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Check, Loader2, Send, X } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import type { HodChannel } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { CHANNEL_LABEL, planCounts, type PlanRow } from "./logic";
import { CHANNEL_ICON } from "./parts";

const CHANNELS: HodChannel[] = ["whatsapp", "email", "push"];

/**
 * "Send now", confirmed: every HoD with something pending, with what each will get on which channel (or why a channel will
 * not reach them), each one tickable. Nothing is sent until the button at the bottom is pressed.
 */
export default function SendNowDialog({
  open,
  plan,
  loading,
  sending,
  templateUnsaved,
  onClose,
  onConfirm,
}: {
  open: boolean;
  plan: PlanRow[];
  /** The HoDs are still being read. */
  loading: boolean;
  sending: boolean;
  /** The message on screen is not saved: the saved one is what goes. */
  templateUnsaved: boolean;
  onClose: () => void;
  onConfirm: (managerIds: number[]) => void;
}) {
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const ids = useMemo(() => plan.map((p) => p.managerId), [plan]);
  // every HoD ticked each time the dialog opens
  useEffect(() => {
    if (open) setPicked(new Set(ids));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const chosen = plan.filter((p) => picked.has(p.managerId));
  const counts = planCounts(chosen);
  const nobody = chosen.length === 0;
  const unreachableAll = !nobody && counts.unreachable === chosen.length;

  const toggle = (id: number, on: boolean) =>
    setPicked((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !sending && onClose()}>
      <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col" data-testid="notify-send-dialog">
        <DialogHeader>
          <DialogTitle>Send the reminder now?</DialogTitle>
          <DialogDescription>
            Each HoD below gets their own message with what is waiting for them, on the channels shown. HoDs with
            nothing pending are left out.
          </DialogDescription>
        </DialogHeader>

        {templateUnsaved && (
          <p
            className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2 text-xs text-amber-800"
            data-testid="notify-send-unsaved"
          >
            <AlertTriangle size={13} className="mt-0.5 shrink-0" aria-hidden />
            Your message changes are not saved: the saved message is the one that goes. Save first to send the new one.
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading ? (
            <div className="space-y-2" aria-busy>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : plan.length === 0 ? (
            <p
              className="rounded-xl bg-slate-50 px-3 py-8 text-center text-sm text-gray-500"
              data-testid="notify-send-nobody"
            >
              No HoD has anything pending right now: there is nobody to remind.
            </p>
          ) : (
            <>
              <div className="mb-2 flex items-center justify-between text-xs text-gray-500">
                <span>
                  {chosen.length} of {plan.length} HoD{plan.length === 1 ? "" : "s"} ticked
                </span>
                <span className="flex gap-3">
                  <button
                    type="button"
                    className="font-semibold text-blue-600 hover:underline"
                    onClick={() => setPicked(new Set(ids))}
                  >
                    Tick all
                  </button>
                  <button
                    type="button"
                    className="font-semibold text-blue-600 hover:underline"
                    onClick={() => setPicked(new Set())}
                  >
                    Untick all
                  </button>
                </span>
              </div>
              <ul className="space-y-1.5" data-testid="notify-send-list">
                {plan.map((p) => {
                  const id = `notify-send-${p.managerId}`;
                  const on = picked.has(p.managerId);
                  return (
                    <li
                      key={p.managerId}
                      className={cn(
                        "flex items-start gap-3 rounded-xl border px-3 py-2.5",
                        on ? "border-slate-200 bg-white" : "border-slate-100 bg-slate-50 opacity-70",
                      )}
                      data-testid={id}
                    >
                      <Checkbox
                        id={id}
                        checked={on}
                        onCheckedChange={(v) => toggle(p.managerId, v === true)}
                        className="mt-1"
                      />
                      <div className="min-w-0 flex-1">
                        <label htmlFor={id} className="block cursor-pointer text-sm font-bold text-gray-900">
                          {p.name} <span className="font-medium text-amber-700">· {p.pending} pending</span>
                        </label>
                        <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={`Channels for ${p.name}`}>
                          {CHANNELS.map((c) => {
                            const cell = p[c];
                            const Icon = CHANNEL_ICON[c];
                            return (
                              <li
                                key={c}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold",
                                  cell.goes
                                    ? "border-green-200 bg-green-50 text-green-800"
                                    : "border-slate-200 bg-slate-50 text-slate-500",
                                )}
                                data-testid={`${id}-${c}`}
                                data-goes={cell.goes ? "true" : "false"}
                              >
                                <Icon size={11} aria-hidden />
                                {cell.goes ? <Check size={11} aria-hidden /> : <X size={11} aria-hidden />}
                                {cell.goes ? CHANNEL_LABEL[c] : `${CHANNEL_LABEL[c]}: ${cell.note}`}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>

        {!loading && plan.length > 0 && (
          <p className="text-xs text-gray-600" data-testid="notify-send-counts">
            {CHANNELS.map((c) => `${CHANNEL_LABEL[c]} to ${counts[c]}`).join(" · ")}
            {counts.unreachable > 0 && (
              <span className="font-semibold text-amber-700">
                {" "}
                · {counts.unreachable} HoD{counts.unreachable === 1 ? "" : "s"} cannot be reached on any channel
              </span>
            )}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" onClick={onClose} disabled={sending}>
            Cancel
          </Button>
          <Button
            onClick={() => onConfirm(chosen.map((p) => p.managerId))}
            disabled={sending || loading || nobody || unreachableAll}
            className="gap-1.5"
            data-testid="notify-send-confirm"
          >
            {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            {nobody ? "Send" : `Send to ${chosen.length} HoD${chosen.length === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
