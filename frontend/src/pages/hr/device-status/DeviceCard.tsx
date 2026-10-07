import { useState } from "react";
import { AlertTriangle, ChevronDown, Fingerprint, Info, Loader2, Radio, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { DeviceStatusRow, DeviceStatusServer } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import DiagnosisPanel from "./DiagnosisPanel";
import { ReachChip, StatusChip, Tile, TonePill } from "./parts";
import { STATUS_TONE, TONE_CLASSES, describeDelay, formatLatency, pingSummary, relativeTime } from "./logic";

/** One device: its state at a glance, the reason in a sentence, and the layer-by-layer diagnosis one click away. */
export default function DeviceCard({
  device,
  server,
  slowMs,
  pinging,
  busy,
  onCheck,
  defaultOpen = false,
}: {
  device: DeviceStatusRow;
  server: DeviceStatusServer;
  slowMs: number;
  pinging: boolean;
  busy: boolean;
  onCheck: (id: number) => void;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const tone = STATUS_TONE[device.status];
  const probe = device.pull.probe;
  // From the cloud a private address cannot be pinged at all, so no answer is expected, not a fault.
  const ping = pingSummary(probe, server.deployment === "railway" && device.privateAddress && !server.canReachLan);
  const delay = describeDelay(device.push.delay);
  const more = device.diagnosis.problems.filter((k) => k !== device.diagnosis.headlineLayer).length;
  const disabled = device.status === "disabled";
  const punch = device.push.lastPunch;

  return (
    <article
      className={cn("clay-card overflow-hidden rounded-2xl ring-1", TONE_CLASSES[pinging ? "busy" : tone].ring)}
      data-testid={`device-card-${device.id}`}
      data-status={device.status}
      data-reach={device.reach}
    >
      <div className="space-y-3 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3">
            <div className={cn("rounded-xl p-2.5", TONE_CLASSES[pinging ? "busy" : tone].chip)}>
              <Fingerprint size={20} />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-base font-black text-slate-900" data-testid={`device-name-${device.id}`}>
                  {device.name}
                </h3>
                <StatusChip status={device.status} label={device.statusLabel} pinging={pinging} />
                {!disabled && <ReachChip reach={device.reach} label={device.reachLabel} />}
                {device.neverConnected && !disabled && <TonePill tone="muted">Never connected</TonePill>}
              </div>
              <p className="mt-1 text-xs text-slate-500">
                {device.host || "no host set"}:{device.port}
                {device.serialNumber ? ` · ${device.serialNumber}` : " · serial not known yet"} · {device.deviceType}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={busy}
              onClick={() => onCheck(device.id)}
              data-testid={`device-check-${device.id}`}
            >
              {pinging ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Run check
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={open}
              aria-label={open ? `Hide diagnosis of ${device.name}` : `Show diagnosis of ${device.name}`}
              onClick={() => setOpen((v) => !v)}
              data-testid={`device-toggle-${device.id}`}
              className="gap-1 text-slate-600"
            >
              Diagnosis
              <ChevronDown size={14} className={cn("transition-transform", open && "rotate-180")} />
            </Button>
          </div>
        </div>

        {!disabled && (
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Tile
              label="Last heard from it"
              value={relativeTime(device.push.lastContactAt)}
              sub={device.push.remoteIp ? `from ${device.push.remoteIp}` : "no contact recorded"}
              tone={device.status === "connected" ? "good" : device.push.lastContactAt ? "bad" : "muted"}
              testId={`device-lastheard-${device.id}`}
            />
            <Tile
              label="Last attendance data"
              value={device.push.lastDataAt ? relativeTime(device.push.lastDataAt) : "none yet"}
              sub={
                punch
                  ? `newest punch ${punch.date === server.serverTimeIst.slice(0, 10) ? "" : `${punch.date} `}${punch.time ?? ""}`
                  : "no punch received"
              }
            />
            <Tile
              label="Ping / response"
              value={ping.value}
              sub={ping.sub}
              tone={ping.tone}
              testId={`device-ping-${device.id}`}
            />
            <Tile
              label="Punches today"
              value={device.push.punchesToday}
              sub={delay.label}
              tone={device.push.delay ? delay.tone : "muted"}
            />
          </div>
        )}

        <div
          className={cn(
            "flex items-start gap-2.5 rounded-xl px-3.5 py-2.5 text-[13px] leading-relaxed",
            disabled
              ? "bg-slate-50 text-slate-600"
              : device.status === "connected"
                ? "bg-emerald-50/70 text-emerald-900"
                : device.status === "error"
                  ? "bg-amber-50 text-amber-900"
                  : "bg-red-50/70 text-red-900",
          )}
          data-testid={`device-headline-${device.id}`}
        >
          {device.status === "connected" ? (
            <Radio size={15} className="mt-0.5 shrink-0" />
          ) : device.status === "error" ? (
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
          ) : (
            <Info size={15} className="mt-0.5 shrink-0" />
          )}
          <div>
            <p className="font-semibold">{device.headline}</p>
            {device.action && !disabled && (
              <p className="mt-0.5 opacity-90">
                <b>What to do: </b>
                {device.action}
              </p>
            )}
            {more > 0 && (
              <button
                type="button"
                className="mt-1 text-xs font-semibold underline underline-offset-2"
                onClick={() => setOpen(true)}
              >
                and {more} more problem{more === 1 ? "" : "s"} in the diagnosis
              </button>
            )}
          </div>
        </div>

        {device.errors.length > 0 && (
          <div className="space-y-1.5" data-testid={`device-errors-${device.id}`}>
            {device.errors.map((e) => (
              <div
                key={`${e.source}-${e.at}`}
                className="rounded-xl border border-amber-200 bg-white px-3.5 py-2 text-xs text-amber-900"
              >
                <b>
                  {e.source === "push" ? "Receiving attendance" : e.source === "check" ? "Connection check" : "Pull"}{" "}
                  error
                </b>
                <span className="text-amber-700"> · {relativeTime(e.at)}</span>
                <p className="mt-0.5 break-words">{e.message}</p>
              </div>
            ))}
          </div>
        )}

        {probe && probe.latencyMs != null && probe.latencyMs > slowMs && (
          <p className="text-xs font-medium text-amber-700">
            Slow connection: {formatLatency(probe.latencyMs)} to accept a connection.
          </p>
        )}
      </div>

      {open && <DiagnosisPanel device={device} open={open} />}
    </article>
  );
}
