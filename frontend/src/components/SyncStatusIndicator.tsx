import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useSyncStatusLive, type DeviceHealthRow } from "@/lib/api-client/custom-hooks";
import {
  Radio, AlertTriangle, CheckCircle2, Info, WifiOff, PowerOff, HelpCircle,
} from "lucide-react";

function relative(iso: string | null): string {
  if (!iso) return "never";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

const STATUS_META: Record<DeviceHealthRow["status"], {
  label: string; cls: string; icon: typeof Radio; hint: string;
}> = {
  live: {
    label: "Live", cls: "bg-green-50 text-green-700", icon: CheckCircle2,
    hint: "Sending data normally.",
  },
  silent: {
    label: "Silent", cls: "bg-red-50 text-red-600", icon: WifiOff,
    hint: "Enabled and known, but nothing received for a while — check power, network, and the device's Cloud Server setting.",
  },
  never: {
    label: "Never seen", cls: "bg-amber-50 text-amber-700", icon: HelpCircle,
    hint: "Configured here, but has never sent anything — its Cloud Server (ADMS) settings likely aren't pointed at this server yet.",
  },
  disabled: {
    label: "Disabled", cls: "bg-gray-100 text-gray-500", icon: PowerOff,
    hint: "Switched off in Settings → Devices, so it's excluded from problem counts.",
  },
};

/**
 * Replaces the old "Auto Sync" button. That one configured a schedule for
 * pulling FROM devices, which a cloud-hosted backend can't do at all. This
 * reports the thing that actually matters now: whether attendance is still
 * arriving, and which device has stopped sending if not.
 *
 * Two buttons share one poll -a live/blinking status, and an Errors button
 * that only appears when something is actually wrong.
 */
export function SyncStatusIndicator() {
  const { data, isLoading } = useSyncStatusLive();
  const [showDetail, setShowDetail] = useState(false);

  const isLive = data?.isLive ?? false;
  const problems = data?.problemCount ?? 0;

  return (
    <>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="outline"
          onClick={() => setShowDetail(true)}
          className={`clay-btn gap-2 h-9 px-3 rounded-xl border-0 ${
            isLoading ? "bg-slate-50 text-slate-500"
              : isLive ? "bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
              : "bg-red-50 text-red-600 hover:bg-red-100"
          }`}
          title={isLive ? "Attendance is arriving from the biometric device" : "No device has sent data recently"}
        >
          <span className="relative flex h-2 w-2">
            {isLive && (
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            )}
            <span
              className={`relative inline-flex rounded-full h-2 w-2 ${
                isLoading ? "bg-slate-400" : isLive ? "bg-emerald-500" : "bg-red-500"
              }`}
            />
          </span>
          <span className="flex flex-col items-start leading-none">
            <span className="text-[13px] font-semibold">
              {isLoading ? "Checking…" : isLive ? "Sync Live" : "Sync Offline"}
            </span>
            {data?.lastPunchAt && (
              <span className="text-[10px] font-normal opacity-70 mt-0.5">
                last punch {data.lastPunchAt.slice(11, 16)}
              </span>
            )}
          </span>
        </Button>

        {/* Only shown when something is actually wrong -a permanently visible
            "Errors (0)" button trains people to ignore it. */}
        {problems > 0 && (
          <Button
            variant="outline"
            onClick={() => setShowDetail(true)}
            className="clay-btn gap-1.5 h-9 px-3 rounded-xl border-0 bg-red-50 text-red-600 hover:bg-red-100 shrink-0"
          >
            <AlertTriangle size={14} />
            <span className="text-[13px] font-semibold">
              {problems} device{problems === 1 ? "" : "s"} down
            </span>
          </Button>
        )}
      </div>

      <Dialog open={showDetail} onOpenChange={(o) => !o && setShowDetail(false)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radio size={16} className={isLive ? "text-emerald-600" : "text-red-500"} />
              Biometric device status
            </DialogTitle>
          </DialogHeader>

          <div className="flex gap-2 items-start rounded-lg bg-slate-50 border p-2.5 text-[11px] leading-relaxed text-slate-600">
            <Info size={13} className="mt-0.5 shrink-0" />
            <span>
              Devices push attendance to this server as it happens. A device counts as{" "}
              <b>Silent</b> only after {data?.silentAfterHours ?? 6} hours with nothing received —
              long enough that a quiet lunch hour or an early shift end doesn't raise a false alarm.
            </span>
          </div>

          <div className="grid grid-cols-3 gap-2 text-center">
            <div className="rounded-xl bg-emerald-50 text-emerald-800 p-3">
              <p className="text-2xl font-black">{data?.liveCount ?? "—"}</p>
              <p className="text-[11px] font-medium opacity-70">Live</p>
            </div>
            <div className="rounded-xl bg-red-50 text-red-700 p-3">
              <p className="text-2xl font-black">{problems}</p>
              <p className="text-[11px] font-medium opacity-70">Not reporting</p>
            </div>
            <div className="rounded-xl bg-slate-100 text-slate-700 p-3">
              <p className="text-2xl font-black">{data?.punchesToday ?? "—"}</p>
              <p className="text-[11px] font-medium opacity-70">Punches today</p>
            </div>
          </div>

          <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
            {(data?.devices ?? []).map((d) => {
              const meta = STATUS_META[d.status];
              const Icon = meta.icon;
              return (
                <div key={d.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-bold text-sm">{d.name}</span>
                        <span className={`flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded ${meta.cls}`}>
                          <Icon size={10} /> {meta.label}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-1">
                        {d.host || "no host set"}
                        {d.serialNumber && ` · ${d.serialNumber}`}
                      </p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-[11px] text-muted-foreground">last data</p>
                      <p className="text-xs font-semibold">{relative(d.lastPushAt)}</p>
                    </div>
                  </div>
                  {d.status !== "live" && (
                    <p className="text-[11px] text-muted-foreground mt-2 pt-2 border-t">{meta.hint}</p>
                  )}
                </div>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
