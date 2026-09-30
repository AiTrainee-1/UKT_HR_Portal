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
  useGmailControlSettings,
  useUpdateGmailControlSettings,
  type GmailFeature,
} from "@/lib/api-client/custom-hooks";

function FeatureRow({
  feature,
  disabled,
  onToggle,
}: {
  feature: GmailFeature;
  disabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-gray-800">Gmail – {feature.label}</p>
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
          aria-label={`Gmail ${feature.label}`}
          data-testid={`toggle-${feature.key}`}
        />
      </div>
    </div>
  );
}

export default function ControlsTab() {
  const { toast } = useToast();
  const { data, isLoading } = useGmailControlSettings();
  const update = useUpdateGmailControlSettings();
  const [limits, setLimits] = useState<Record<string, string>>({});

  useEffect(() => {
    if (data) setLimits(Object.fromEntries(data.timings.map((t) => [t.key, String(t.value)])));
  }, [data]);

  if (isLoading || !data) return <Skeleton className="h-96 rounded-2xl" />;

  const toggle = (feature: GmailFeature, enabled: boolean) =>
    update.mutate(
      { [feature.key]: enabled },
      {
        onSuccess: () => toast({ title: `Gmail – ${feature.label}: ${enabled ? "ON" : "OFF"}` }),
        onError: (e) =>
          toast({ title: "Couldn't change that setting", description: (e as Error).message, variant: "destructive" }),
      },
    );

  const limitsChanged = data.timings.some((t) => String(t.value) !== limits[t.key]);
  const saveLimits = () =>
    update.mutate(Object.fromEntries(data.timings.map((t) => [t.key, Number(limits[t.key])])), {
      onSuccess: () => toast({ title: "Limit saved", description: "Applies to the next email." }),
      onError: (e) =>
        toast({ title: "Couldn't save the limit", description: (e as Error).message, variant: "destructive" }),
    });

  const { gmailLimits } = data.config;

  return (
    <div className="space-y-4">
      {!data.config.configured && (
        <div className="flex items-start gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-800">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>
            {data.config.sendingBlockedReason ?? "Email isn't set up on this server."} These switches have no effect
            until it is (see the Configuration tab).
          </span>
        </div>
      )}
      <div className="flex items-start gap-2 rounded-xl border border-blue-100 bg-blue-50 p-3 text-xs text-blue-800">
        <Info size={14} className="mt-0.5 shrink-0" />
        <span>
          Every switch starts <b>ON</b> — these emails were already going out before this page existed. An email is sent
          only when its own switch (Message Text tab), its module's switch and the master switch are all on. A
          switched-off email isn't lost: it shows on the Messages tab as "Not sent" with the reason. Changes take effect
          on the next email; no restart is needed.
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
          <CardTitle className="text-sm font-bold">Sending limit</CardTitle>
          <p className="text-xs text-gray-500">
            Gmail stops a regular account at about {gmailLimits.regular} emails a day (Google Workspace about{" "}
            {gmailLimits.workspace.toLocaleString("en-IN")}), and a stopped account can't send salary slips or letters
            either. Set a limit a little under yours; once it is reached the rest are held back as "Not sent" until
            tomorrow. A bulk salary-slip run respects it too.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid sm:grid-cols-2 gap-4">
            {data.timings.map((t) => (
              <div key={t.key} className="space-y-1.5">
                <Label className="text-xs" htmlFor={`limit-${t.key}`}>
                  {t.label}
                </Label>
                <Input
                  id={`limit-${t.key}`}
                  type="number"
                  min={t.min}
                  max={t.max}
                  value={limits[t.key] ?? ""}
                  onChange={(e) => setLimits((prev) => ({ ...prev, [t.key]: e.target.value }))}
                />
                <p className="text-[10px] text-gray-400">
                  {t.min}–{t.max}. Sent today: {data.config.sentToday}
                </p>
              </div>
            ))}
          </div>
          <Button size="sm" onClick={saveLimits} disabled={!limitsChanged || update.isPending}>
            {update.isPending ? "Saving…" : "Save limit"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
