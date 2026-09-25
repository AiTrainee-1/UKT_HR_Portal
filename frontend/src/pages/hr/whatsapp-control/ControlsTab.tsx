import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { AlertTriangle, Info } from "lucide-react";
import {
  useUpdateWhatsAppControlSettings,
  useWhatsAppControlSettings,
  type WhatsAppFeature,
} from "@/lib/api-client/custom-hooks";

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

export default function ControlsTab() {
  const { toast } = useToast();
  const { data, isLoading } = useWhatsAppControlSettings();
  const update = useUpdateWhatsAppControlSettings();
  const [timings, setTimings] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setTimings(Object.fromEntries(data.timings.map((t) => [t.key, String(t.value)])));
  }, [data]);

  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;

  const toggle = (feature: WhatsAppFeature, enabled: boolean) =>
    update.mutate(
      { [feature.key]: enabled },
      {
        onSuccess: () => toast({ title: `WhatsApp – ${feature.label}: ${enabled ? "ON" : "OFF"}` }),
        onError: (e) =>
          toast({ title: "Couldn't change that setting", description: (e as Error).message, variant: "destructive" }),
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
          ON. Changes take effect within a few minutes; no restart is needed.
        </span>
      </div>

      {data.groups.map((group) => {
        const rows = data.features.filter((f) => f.group === group.key);
        if (rows.length === 0) return null;
        return (
          <Card key={group.key} className="border-0 shadow-sm">
            <CardHeader className="pb-1">
              <CardTitle className="text-sm font-bold">{group.title}</CardTitle>
              <p className="text-xs text-gray-500">{group.blurb}</p>
            </CardHeader>
            <CardContent className="divide-y">
              {rows.map((feature) => (
                <FeatureRow
                  key={feature.key}
                  feature={feature}
                  disabled={update.isPending}
                  onToggle={(enabled) => toggle(feature, enabled)}
                />
              ))}
            </CardContent>
          </Card>
        );
      })}

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
    </div>
  );
}
