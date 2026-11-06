import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Info, Power, PowerOff } from "lucide-react";
import {
  useUpdateWhatsAppControlSettings,
  useWhatsAppControlSettings,
  whatsAppErrorMessage,
  type WhatsAppFeature,
} from "@/lib/api-client/custom-hooks";
import { featureSections } from "./logic";
import SendingLimits from "./SendingLimits";
import { ConfirmDialog } from "./shared";

function FeatureRow({
  feature,
  disabled,
  onToggle,
}: {
  feature: WhatsAppFeature;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-800">WhatsApp – {feature.label}</p>
        <p className="text-xs text-gray-500 mt-0.5">{feature.description}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0 pt-0.5">
        <span className={`text-xs font-bold w-8 text-right ${feature.enabled ? "text-emerald-600" : "text-gray-400"}`}>
          {feature.enabled ? "ON" : "OFF"}
        </span>
        <Switch
          checked={feature.enabled}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-label={`WhatsApp ${feature.label}`}
          data-testid={`toggle-${feature.key}`}
        />
      </div>
    </div>
  );
}

/** The master switch. It never flips straight away: HR confirms first, both ways. */
function EngineSwitch({
  on,
  disabled,
  onRequest,
}: {
  on: boolean;
  disabled: boolean;
  onRequest: (next: boolean) => void;
}) {
  const Icon = on ? Power : PowerOff;
  return (
    <div
      data-testid="wa-engine"
      data-state={on ? "on" : "off"}
      className={`rounded-2xl border-2 p-4 flex items-start justify-between gap-4 ${
        on ? "border-emerald-200 bg-emerald-50/60" : "border-red-200 bg-red-50"
      }`}
    >
      <div className="flex items-start gap-3 min-w-0">
        <div className={`rounded-xl p-2 ${on ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700"}`}>
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <p className="text-base font-black text-gray-900">WhatsApp engine</p>
          <p className={`text-xs mt-0.5 ${on ? "text-emerald-900/80" : "text-red-800"}`}>
            {on
              ? "ON: messages go out one at a time through the sending queue, within the sending limits below."
              : "OFF: nothing is sent by WhatsApp, not even login codes. Password login (and SMS codes, where set up) keep working."}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0 pt-1">
        <span className={`text-sm font-black w-9 text-right ${on ? "text-emerald-600" : "text-red-600"}`}>
          {on ? "ON" : "OFF"}
        </span>
        <Switch
          checked={on}
          disabled={disabled}
          onCheckedChange={onRequest}
          aria-label="WhatsApp engine"
          data-testid="wa-engine-switch"
        />
      </div>
    </div>
  );
}

export default function ControlsTab() {
  const { toast } = useToast();
  const { data, isLoading } = useWhatsAppControlSettings();
  const update = useUpdateWhatsAppControlSettings();
  const [timings, setTimings] = useState<Record<string, string>>({});
  /** The engine state HR asked for, waiting for their confirmation (kept while the dialog animates closed). */
  const [engineAsk, setEngineAsk] = useState({ open: false, target: true });
  const closeEngineAsk = () => setEngineAsk((ask) => ({ ...ask, open: false }));

  useEffect(() => {
    if (data) setTimings(Object.fromEntries(data.timings.map((t) => [t.key, String(t.value)])));
  }, [data]);

  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;

  // A server older than the engine switch has no master switch: everything below is live.
  const engineOn = data.engineEnabled !== false;
  const sections = featureSections(data.groups, data.features);

  const toggle = (feature: WhatsAppFeature, enabled: boolean) =>
    update.mutate(
      { [feature.key]: enabled },
      {
        onSuccess: () => toast({ title: `WhatsApp – ${feature.label}: ${enabled ? "ON" : "OFF"}` }),
        onError: (e) =>
          toast({ title: "Couldn't change that setting", description: (e as Error).message, variant: "destructive" }),
      },
    );

  const setEngine = (next: boolean) =>
    update.mutate(
      { engineEnabled: next },
      {
        onSuccess: () => {
          closeEngineAsk();
          toast({
            title: `WhatsApp engine: ${next ? "ON" : "OFF"}`,
            description: next ? "Messages go out through the sending queue again." : "Nothing is sent by WhatsApp now.",
          });
        },
        onError: (e) => {
          closeEngineAsk();
          toast({
            title: "Couldn't change the WhatsApp engine",
            description: whatsAppErrorMessage(e, "Try again."),
            variant: "destructive",
          });
        },
      },
    );

  const timingsChanged = data.timings.some((t) => String(t.value) !== timings[t.key]);
  const saveTimings = () =>
    update.mutate(Object.fromEntries(data.timings.map((t) => [t.key, Number(timings[t.key])])), {
      onSuccess: () => toast({ title: "Timings saved", description: "Applies from the next check." }),
      onError: (e) =>
        toast({ title: "Couldn't save timings", description: (e as Error).message, variant: "destructive" }),
    });

  return (
    <div className="space-y-4">
      <EngineSwitch
        on={engineOn}
        disabled={update.isPending}
        onRequest={(target) => setEngineAsk({ open: true, target })}
      />

      {!data.config.configured && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            WhatsApp isn't configured on this server, so these switches have no effect until it is (see the
            Configuration tab).
          </span>
        </div>
      )}
      <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          The attendance alerts and punch reminders start <b>OFF</b> — turning one ON begins messaging real employees,
          so try it on a quiet day first and watch the Messages tab. Approval, visitor, gate and document messages start
          ON. Every message type can be switched on its own below. Changes take effect within a few minutes; no restart
          is needed.
        </span>
      </div>

      {!engineOn && (
        <div
          data-testid="wa-engine-off-note"
          className="flex items-start gap-2 rounded-xl border border-gray-200 bg-gray-50 p-3 text-xs text-gray-700"
        >
          <PowerOff size={14} className="mt-0.5 shrink-0" />
          <span>
            The WhatsApp engine is <b>OFF</b>, so none of the switches below send anything until it is turned back on.
            You can still set them now; they apply once the engine is ON.
          </span>
        </div>
      )}

      {sections.map(({ group, general, perType }) => (
        <Card
          key={group.key}
          className={`border-0 shadow-sm transition-opacity ${engineOn ? "" : "opacity-60"}`}
          data-testid={`wa-feature-group-${group.key}`}
          data-inactive={engineOn ? undefined : "true"}
        >
          <CardHeader className="pb-1">
            <CardTitle className="text-sm font-bold">{group.title}</CardTitle>
            {group.blurb && <p className="text-xs text-gray-500">{group.blurb}</p>}
          </CardHeader>
          <CardContent className="divide-y">
            {general.map((feature) => (
              <FeatureRow
                key={feature.key}
                feature={feature}
                disabled={update.isPending}
                onToggle={(enabled) => toggle(feature, enabled)}
              />
            ))}
            {perType.length > 0 && (
              <div>
                {general.length > 0 && (
                  <p className="pt-3 text-[10px] font-bold uppercase tracking-wide text-gray-400">Each message type</p>
                )}
                <div className="divide-y">
                  {perType.map((feature) => (
                    <FeatureRow
                      key={feature.key}
                      feature={feature}
                      disabled={update.isPending}
                      onToggle={(enabled) => toggle(feature, enabled)}
                    />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}

      {((data.queueLimits?.length ?? 0) > 0 || data.quietHours) && (
        <SendingLimits limits={data.queueLimits ?? []} quietHours={data.quietHours} />
      )}

      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-bold">Timing</CardTitle>
          <p className="text-xs text-gray-500">The shift's own grace period always applies first; these add to it.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-4">
            {data.timings.map((t) => (
              <div key={t.key} className="space-y-1.5">
                <Label className="text-xs" htmlFor={`timing-${t.key}`}>
                  {t.label}
                </Label>
                <Input
                  id={`timing-${t.key}`}
                  type="number"
                  min={t.min}
                  max={t.max}
                  value={timings[t.key] ?? ""}
                  onChange={(e) => setTimings((prev) => ({ ...prev, [t.key]: e.target.value }))}
                />
                <p className="text-[10px] text-gray-400">
                  {t.min}–{t.max}
                </p>
              </div>
            ))}
          </div>
          <Button size="sm" onClick={saveTimings} disabled={!timingsChanged || update.isPending}>
            {update.isPending ? "Saving…" : "Save timings"}
          </Button>
        </CardContent>
      </Card>

      <ConfirmDialog
        open={engineAsk.open}
        title={engineAsk.target ? "Turn the WhatsApp engine ON?" : "Turn the WhatsApp engine OFF?"}
        confirmLabel={engineAsk.target ? "Turn ON" : "Turn OFF"}
        destructive={!engineAsk.target}
        pending={update.isPending}
        onConfirm={() => setEngine(engineAsk.target)}
        onCancel={closeEngineAsk}
        testId="wa-engine-confirm"
      >
        {engineAsk.target ? (
          <>
            <p>
              WhatsApp messages start going out again, one at a time through the sending queue and within the sending
              limits.
            </p>
            <p>Message types switched OFF below stay off.</p>
          </>
        ) : (
          <>
            <p>
              No WhatsApp message will be sent from the HRMS: attendance alerts, approvals, documents, visitor and gate
              messages all stop.
            </p>
            <p>
              <b>One-time login codes will not go by WhatsApp either.</b> Employees can still sign in with their
              password, or with an SMS code where SMS is set up.
            </p>
          </>
        )}
      </ConfirmDialog>
    </div>
  );
}
