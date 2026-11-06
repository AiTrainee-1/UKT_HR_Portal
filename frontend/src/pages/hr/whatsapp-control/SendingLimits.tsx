import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Moon } from "lucide-react";
import {
  useUpdateWhatsAppControlSettings,
  whatsAppErrorMessage,
  type WhatsAppControlSettingsUpdate,
  type WhatsAppQueueLimit,
  type WhatsAppQuietHours,
} from "@/lib/api-client/custom-hooks";
import { changedLimits, crossesMidnight, limitError, quietHoursChanged, quietHoursError } from "./logic";

const NO_QUIET_HOURS: WhatsAppQuietHours = { enabled: false, start: "21:00", end: "07:00" };

const draftOf = (limits: WhatsAppQueueLimit[]) => Object.fromEntries(limits.map((l) => [l.key, String(l.value)]));

/** The sending queue's limits and quiet hours: one form, one Save. */
export default function SendingLimits({
  limits,
  quietHours,
}: {
  limits: WhatsAppQueueLimit[];
  quietHours: WhatsAppQuietHours | undefined;
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
    <Card className="border-0 shadow-sm" data-testid="wa-sending-limits">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-bold">Sending limits</CardTitle>
        <p className="text-xs text-gray-500">
          Fewer, slower messages keep the company's WhatsApp number from being restricted. Every message except a
          one-time login code waits its turn in one queue and goes out within these limits; anything not sent the same
          day expires instead of going out late, and a failed message is never re-sent automatically.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
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
                      className={`w-28 ${error ? "border-red-400 focus-visible:ring-red-300" : ""}`}
                      onChange={(e) => edit(() => setDraft((prev) => ({ ...prev, [l.key]: e.target.value })))}
                    />
                    <span className="text-xs text-gray-500">{l.unit}</span>
                  </div>
                  {error ? (
                    <p className="text-[10px] text-red-600" data-testid={`wa-limit-error-${l.key}`}>
                      {error}
                    </p>
                  ) : (
                    <p className="text-[10px] text-gray-400">
                      {l.min}–{l.max} {l.unit}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {quietHours && (
          <div className="rounded-xl border p-3 space-y-3" data-testid="wa-quiet-hours">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                  <Moon size={13} className="text-indigo-500" /> Quiet hours
                </p>
                <p className="text-xs text-gray-500 mt-0.5">
                  Nothing automatic goes out between these times: messages raised then are held back, and anything that
                  can't go out the same day is never sent. One-time login codes still go.
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0 pt-0.5">
                <span
                  className={`text-xs font-bold w-8 text-right ${quiet.enabled ? "text-emerald-600" : "text-gray-400"}`}
                >
                  {quiet.enabled ? "ON" : "OFF"}
                </span>
                <Switch
                  checked={quiet.enabled}
                  onCheckedChange={(enabled) => edit(() => setQuiet((q) => ({ ...q, enabled })))}
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
                  className="w-32"
                  onChange={(e) => edit(() => setQuiet((q) => ({ ...q, end: e.target.value.slice(0, 5) })))}
                />
              </div>
              {crossesMidnight(quiet) && <p className="text-[11px] text-gray-400 pb-2">Runs overnight.</p>}
            </div>
            {quietError && (
              <p className="text-[10px] text-red-600" data-testid="wa-quiet-hours-error">
                {quietError}
              </p>
            )}
          </div>
        )}

        {serverError && (
          <div
            role="alert"
            data-testid="wa-limits-error"
            className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{serverError}</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={save}
            disabled={!dirty || invalid || update.isPending}
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
      </CardContent>
    </Card>
  );
}
