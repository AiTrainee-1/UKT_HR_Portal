import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DeleteResult, DeviceChangeEntry, PushResult } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { TONE_CLASSES, type Tone } from "../device-status/logic";
import { summarizeDelete, summarizePush } from "./logic";

export type ChangeOutcome =
  { kind: "push"; result: PushResult; extra?: string[] } | { kind: "delete"; result: DeleteResult; extra?: string[] };

const TONE_ICON: Record<string, typeof Info> = { good: CheckCircle2, warn: AlertTriangle, bad: XCircle, muted: Info };

function deviceLine(e: DeviceChangeEntry): { text: string; tone: Tone } {
  if (!e.ok) return { text: e.error ?? "Could not be reached.", tone: "bad" };
  const parts: string[] = [];
  if (e.added.length) parts.push(`${e.added.length} added`);
  if (e.updated.length) parts.push(`${e.updated.length} changed`);
  if (e.deleted.length) parts.push(`${e.deleted.length} deleted`);
  if (e.skipped.length) parts.push(`${e.skipped.length} left alone`);
  if (e.failed.length) parts.push(`${e.failed.length} failed`);
  return { text: parts.join(" · ") || "Nothing to do", tone: e.failed.length ? "warn" : "good" };
}

/** What happened on each device after an add, a change or a delete, in plain words. */
export default function ResultDialog({ outcome, onClose }: { outcome: ChangeOutcome | null; onClose: () => void }) {
  const summary = outcome
    ? outcome.kind === "push"
      ? summarizePush(outcome.result)
      : summarizeDelete(outcome.result)
    : null;
  const entries = outcome?.result.results ?? [];
  const Icon = TONE_ICON[summary?.tone ?? "muted"];
  const addedSomething =
    outcome?.kind === "push" && outcome.result.mode === "create" && outcome.result.summary.added > 0;

  return (
    <Dialog open={outcome !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-xl" data-testid="change-result">
        <DialogHeader>
          <DialogTitle className="flex items-start gap-2.5 text-base">
            {summary && <Icon size={20} className={cn("mt-0.5 shrink-0", TONE_CLASSES[summary.tone].text)} />}
            <span data-testid="change-result-title">{summary?.title}</span>
          </DialogTitle>
          <DialogDescription className="sr-only">The result on each device.</DialogDescription>
        </DialogHeader>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto">
          {entries.length > 0 && (
            <div className="divide-y rounded-xl border">
              {entries.map((e) => {
                const line = deviceLine(e);
                return (
                  <div
                    key={e.deviceId}
                    className="flex items-start justify-between gap-3 px-3 py-2 text-sm"
                    data-testid={`change-result-${e.deviceId}`}
                  >
                    <span className="font-semibold text-slate-800">{e.deviceName}</span>
                    <span className={cn("text-right text-xs", TONE_CLASSES[line.tone].text)}>{line.text}</span>
                  </div>
                );
              })}
            </div>
          )}

          {summary && summary.lines.length > 0 && (
            <ul
              className="space-y-1 rounded-xl bg-amber-50 p-3 text-xs leading-snug text-amber-900"
              data-testid="change-result-notes"
            >
              {summary.lines.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}

          {outcome?.extra && outcome.extra.length > 0 && (
            <ul className="space-y-1 rounded-xl bg-slate-50 p-3 text-xs leading-snug text-slate-700">
              {outcome.extra.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}

          {outcome?.kind === "delete" && outcome.result.inactive.some((i) => i.changed) && (
            <div
              className="rounded-xl bg-emerald-50 p-3 text-xs leading-snug text-emerald-900"
              data-testid="change-result-inactive"
            >
              <p className="font-semibold">Made Inactive in the HRMS (their records are kept):</p>
              <p className="mt-0.5">
                {outcome.result.inactive
                  .filter((i) => i.changed)
                  .map((i) => `${i.name} (${i.userId})`)
                  .join(", ")}
              </p>
            </div>
          )}

          {addedSomething && (
            <p className="rounded-xl bg-sky-50 p-3 text-xs leading-snug text-sky-900">
              <b>Next:</b> these terminals take their face enrolment on the device itself. Ask the person to enrol their
              face there (from the Users section of the device's menu) before they first punch.
            </p>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose} data-testid="change-result-close">
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
