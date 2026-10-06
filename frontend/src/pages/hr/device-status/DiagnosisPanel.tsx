import { Cloud, Cpu, KeyRound, Network, Plug, Router, Server, ShieldCheck, Timer, type LucideIcon } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeviceCheckHistory, type DeviceStatusRow, type LayerKey } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { LayerStateBadge, TonePill } from "./parts";
import { TONE_CLASSES, formatLatency, readoutRows, relativeTime } from "./logic";

const LAYER_ICON: Record<LayerKey, LucideIcon> = {
  device: Cpu,
  lan: Network,
  firewall: ShieldCheck,
  port: Plug,
  api: Cloud,
  railway: Server,
  ip_config: Router,
  timeout: Timer,
  auth: KeyRound,
};

function SectionTitle({ children }: { children: string }) {
  return <p className="mb-2 text-[11px] font-bold uppercase tracking-wide text-slate-400">{children}</p>;
}

/** The last checks of a device as little bars: height = how long the port took to answer, red = no answer. */
function CheckHistory({ deviceId, enabled }: { deviceId: number; enabled: boolean }) {
  const { data, isLoading } = useDeviceCheckHistory(deviceId, enabled);
  if (isLoading) return <Skeleton className="h-12 w-full" />;
  const checks = [...(data?.checks ?? [])].reverse();
  if (checks.length === 0) {
    return <p className="text-xs text-slate-500">No connection check has been run for this device yet.</p>;
  }
  const slowest = Math.max(50, ...checks.map((c) => c.latencyMs ?? 0));
  return (
    <div>
      <div className="flex h-14 items-end gap-1" data-testid="device-check-history">
        {checks.map((c) => {
          const ok = c.status === "reachable";
          const height = ok && c.latencyMs != null ? Math.max(8, (c.latencyMs / slowest) * 100) : 100;
          return (
            <span
              key={c.id}
              title={`${relativeTime(c.checkedAt)}: ${ok ? `reachable, ${formatLatency(c.latencyMs)}` : c.error || c.status}`}
              className={cn("w-2.5 rounded-sm", ok ? "bg-emerald-400" : "bg-red-300")}
              style={{ height: `${height}%` }}
            />
          );
        })}
      </div>
      <p className="mt-1 text-[11px] text-slate-500">
        Last {checks.length} check{checks.length === 1 ? "" : "s"}:{" "}
        {checks.filter((c) => c.status === "reachable").length} reachable
        {" · "}
        green bars show how long the device took to answer.
      </p>
    </div>
  );
}

export default function DiagnosisPanel({ device, open }: { device: DeviceStatusRow; open: boolean }) {
  const probe = device.pull.probe;
  const readout = readoutRows(probe?.status === "reachable" ? probe.detail : null);
  const reported = Object.entries(device.push.reportedConfig ?? {});

  return (
    <div
      className="space-y-5 border-t border-slate-100 bg-slate-50/50 p-4"
      data-testid={`device-diagnosis-${device.id}`}
    >
      <section>
        <SectionTitle>Why — layer by layer</SectionTitle>
        <div className="grid gap-2 md:grid-cols-2">
          {device.diagnosis.layers.map((layer) => {
            const Icon = LAYER_ICON[layer.key];
            return (
              <div
                key={layer.key}
                data-testid={`layer-${device.id}-${layer.key}`}
                data-state={layer.state}
                className={cn(
                  "rounded-xl border bg-white p-3",
                  layer.state === "problem"
                    ? "border-red-200"
                    : layer.state === "warn"
                      ? "border-amber-200"
                      : "border-slate-100",
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-2 text-[13px] font-bold text-slate-800">
                    <Icon size={14} className="text-slate-400" /> {layer.label}
                  </span>
                  <LayerStateBadge state={layer.state} />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-slate-600">{layer.finding}</p>
                {layer.action && layer.state !== "ok" && (
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-800">
                    <b>What to do: </b>
                    {layer.action}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section>
        <SectionTitle>What the last check tried</SectionTitle>
        {probe ? (
          <div data-testid={`device-steps-${device.id}`}>
            <p className="mb-2 text-xs text-slate-500">
              {relativeTime(probe.checkedAt)}
              {probe.checkedFrom ? ` from ${probe.checkedFrom}` : ""}
              {!device.reachIsFresh && " · too old to count as evidence now"}
            </p>
            <ol className="space-y-1.5">
              {probe.steps.map((s) => (
                <li key={s.key} className="flex items-center gap-2 text-xs">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      s.ok === true ? "bg-emerald-500" : s.ok === false ? "bg-red-500" : "bg-slate-300",
                    )}
                  />
                  <span className="font-semibold text-slate-700">{s.label}</span>
                  {s.ms != null && <span className="text-slate-400">{formatLatency(s.ms)}</span>}
                  {s.note && <span className="text-slate-500">· {s.note}</span>}
                </li>
              ))}
            </ol>
            {probe.error && probe.status !== "reachable" && (
              <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{probe.error}</p>
            )}
          </div>
        ) : (
          <p className="text-xs text-slate-500">
            No connection check has been run for this device yet. Press “Run check”.
          </p>
        )}
      </section>

      {readout.length > 0 && (
        <section>
          <SectionTitle>Settings read from the device</SectionTitle>
          <div className="grid gap-x-8 gap-y-1 md:grid-cols-2" data-testid={`device-readout-${device.id}`}>
            {readout.map((row) => (
              <div
                key={row.label}
                className="flex items-baseline justify-between gap-3 border-b border-slate-100 py-1 text-xs"
              >
                <span className="text-slate-500">{row.label}</span>
                <span className="text-right">
                  <span
                    className={cn(
                      "font-semibold",
                      row.tone === "muted" ? "text-slate-800" : TONE_CLASSES[row.tone].text,
                    )}
                  >
                    {row.value}
                  </span>
                  {row.note && (
                    <span
                      className={cn(
                        "block text-[11px]",
                        row.tone === "muted" ? "text-slate-400" : TONE_CLASSES[row.tone].text,
                      )}
                    >
                      {row.note}
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {reported.length > 0 && (
        <section>
          <SectionTitle>Reported by the device when it contacts the server</SectionTitle>
          <div className="flex flex-wrap gap-1.5">
            {reported.map(([key, value]) => (
              <TonePill key={key} tone="muted" className="font-medium">
                {key}: {value}
              </TonePill>
            ))}
          </div>
        </section>
      )}

      <section className="grid gap-5 md:grid-cols-2">
        <div>
          <SectionTitle>Recent connection checks</SectionTitle>
          <CheckHistory deviceId={device.id} enabled={open} />
        </div>
        <div>
          <SectionTitle>Pulling from the device</SectionTitle>
          <div className="space-y-1 text-xs text-slate-600">
            <p>
              Last successful pull: <b>{relativeTime(device.pull.lastSyncAt)}</b>
            </p>
            <p>
              Last time this server reached it: <b>{relativeTime(device.pull.lastReachableAt)}</b>
            </p>
            {device.pull.lastSyncError && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
                Last pull failed {relativeTime(device.pull.lastSyncErrorAt)}: {device.pull.lastSyncError}
              </p>
            )}
            {device.push.skippedIds > 0 && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-amber-800">
                {device.push.skippedIds} punching ID{device.push.skippedIds === 1 ? "" : "s"} on this device (
                {device.push.skippedPunches} punches) have no matching employee: see “Skipped” on the Attendance page.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
