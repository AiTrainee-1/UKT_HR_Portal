import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Gauge, Moon } from "lucide-react";
import {
  useUpdateWhatsAppControlSettings,
  whatsAppErrorMessage,
  type WhatsAppControlSettingsUpdate,
  type WhatsAppQueueLimit,
  type WhatsAppQuietHours,
} from "@/lib/api-client/custom-hooks";
import { Notice, Panel } from "./kit";
import { changedLimits, crossesMidnight, limitError, quietHoursChanged, quietHoursError } from "./logic";

const NO_QUIET_HOURS: WhatsAppQuietHours = { enabled: false, start: "21:00", end: "07:00" };

const draftOf = (limits: WhatsAppQueueLimit[]) => Object.fromEntries(limits.map((l) => [l.key, String(l.value)]));

/** The sending queue's limits and quiet hours: one form, one Save. */
export default function SendingLimits({
  limits,
  quietHours,
  locked = false,
}: {
  limits: WhatsAppQueueLimit[];
  quietHours: WhatsAppQuietHours | undefined;
  /** View only: everything shown, nothing editable. */
  locked?: boolean;
}) {
  const { toast } = useToast();
  const update = useUpdateWhatsAppControlSettings();
  const [draft, setDraft] = useState<Record<string, string>>(() => draftOf(limits));
  const [quiet, setQuiet] = useState<WhatsAppQuietHours>(quietHours ?? NO_QUIET_HOURS);
  const [serverError, setServerError] = useState<string | null>(null);

  // Start again from the saved values only when they really change (a save, or another HR user's), so a background
  // refresh never wipes what HR is typing.
  const savedKey = JSON.stringify([limits.map((l) => [l.key, l.value]), quietHours ?? null]);
  const [seenKey, setSeenKey] = useState(savedKey);
  if (seenKey !== savedKey) {
    setSeenKey(savedKey);
    setDraft(draftOf(limits));
    setQuiet(quietHours ?? NO_QUIET_HOURS);
  }

  const errors = Object.fromEntries(limits.map((l) => [l.key, limitError(l, draft[l.key])]));
  const quietError = quietHours ? quietHoursError(quiet) : null;
  const limitChanges = changedLimits(limits, draft);
  const quietDirty = Boolean(quietHours) && quietHoursChanged(quietHours, quiet);
  const dirty = Object.keys(limitChanges).length > 0 || quietDirty;
  const invalid = Object.values(errors).some(Boolean) || Boolean(quietError);

  const edit = (apply: () => void) => {
    setServerError(null);
    apply();
  };

  const save = () => {
    const body: WhatsAppControlSettingsUpdate = { ...limitChanges };
    if (quietDirty) body.quietHours = quiet;
    setServerError(null);
    update.mutate(body, {
      onSuccess: () =>
        toast({ title: "Sending limits saved", description: "The queue uses them from the next message." }),
      onError: (e) => setServerError(whatsAppErrorMessage(e, "Couldn't save the sending limits.")),
    });
  };

  const discard = () => {
    setServerError(null);
    setDraft(draftOf(limits));
    setQuiet(quietHours ?? NO_QUIET_HOURS);
  };

  return (
    <Panel
      title="Sending limits"
      icon={Gauge}
      testId="wa-sending-limits"
      description="Fewer, steadier messages keep the number's quality high and its Meta messaging limit growing. Every message except a sign-in code waits its turn in one queue and goes out within these limits; anything not sent the same day expires instead of going out late, and a failed message is never re-sent automatically."
    >
      <div className="space-y-4">
        {limits.length > 0 && (
          <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {limits.map((l) => {
              const error = errors[l.key];
              return (
                <div key={l.key} className="space-y-1.5">
                  <Label className="text-xs" htmlFor={`wa-limit-${l.key}`}>
                    {l.label}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`wa-limit-${l.key}`}
                      data-testid={`wa-limit-${l.key}`}
                      type="number"
                      inputMode="numeric"
                      min={l.min}
                      max={l.max}
                      step={1}
                      value={draft[l.key] ?? ""}
                      aria-invalid={Boolean(error)}
                      disabled={locked}
                      className={`w-28 ${error ? "border-red-400 focus-visible:ring-red-300" : ""}`}
                      onChange={(e) => edit(() => setDraft((prev) => ({ ...prev, [l.key]: e.target.value })))}
                    />
                    <span className="text-xs text-muted-foreground">{l.unit}</span>
                  </div>
                  {error ? (
                    <p className="text-[10px] text-red-600" data-testid={`wa-limit-error-${l.key}`}>
                      {error}
                    </p>
                  ) : (
                    <p className="text-[10px] text-muted-foreground">
                      {l.min}–{l.max} {l.unit}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {quietHours && (
          <div className="space-y-3 rounded-xl border bg-muted/40 p-3" data-testid="wa-quiet-hours">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-sm font-semibold">
                  <Moon size={13} className="text-indigo-500" /> Quiet hours
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Nothing automatic goes out between these times: messages raised then are held back, and anything that
                  can't go out the same day is never sent. Sign-in codes still go.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 pt-0.5">
                <span
                  className={`w-8 text-right text-xs font-bold ${quiet.enabled ? "text-emerald-600" : "text-muted-foreground"}`}
                >
                  {quiet.enabled ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={quiet.enabled}
                  onCheckedChange={(enabled) => edit(() => setQuiet((q) => ({ ...q, enabled })))}
                  disabled={locked}
                  aria-label="Quiet hours"
                  data-testid="wa-quiet-hours-switch"
                />
              </div>
            </div>
            <div className={`flex items-end gap-3 flex-wrap ${quiet.enabled ? "" : "opacity-60"}`}>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="wa-quiet-start">
                  From
                </Label>
                <Input
                  id="wa-quiet-start"
                  data-testid="wa-quiet-start"
                  type="time"
                  value={quiet.start}
                  disabled={locked}
                  className="w-32"
                  onChange={(e) => edit(() => setQuiet((q) => ({ ...q, start: e.target.value.slice(0, 5) })))}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs" htmlFor="wa-quiet-end">
                  Until
                </Label>
                <Input
                  id="wa-quiet-end"
                  data-testid="wa-quiet-end"
                  type="time"
                  value={quiet.end}
                  disabled={locked}
                  className="w-32"
                  onChange={(e) => edit(() => setQuiet((q) => ({ ...q, end: e.target.value.slice(0, 5) })))}
                />
              </div>
              {crossesMidnight(quiet) && <p className="pb-2 text-[11px] text-muted-foreground">Runs overnight.</p>}
            </div>
            {quietError && (
              <p className="text-[10px] text-red-600" data-testid="wa-quiet-hours-error">
                {quietError}
              </p>
            )}
          </div>
        )}

        {serverError && (
          <Notice tone="bad" role="alert" testId="wa-limits-error">
            {serverError}
          </Notice>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={save}
            disabled={locked || !dirty || invalid || update.isPending}
            data-testid="wa-save-limits"
          >
            {update.isPending ? "Saving…" : "Save sending limits"}
          </Button>
          {dirty && (
            <Button variant="ghost" size="sm" onClick={discard} disabled={update.isPending}>
              Undo changes
            </Button>
          )}
        </div>
      </div>
    </Panel>
  );
}
