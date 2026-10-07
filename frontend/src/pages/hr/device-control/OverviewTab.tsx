import { useLocation } from "wouter";
import {
  AlertTriangle,
  ArrowRight,
  Clock,
  CloudDownload,
  Cpu,
  Fingerprint,
  Loader2,
  Network,
  RefreshCw,
  Users,
  UsersRound,
  Wifi,
  WifiOff,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CircleLoader } from "@/components/ui/CircleLoader";
import type { DeviceControlDevice, DeviceControlOverview } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatCard } from "../account-management/parts";
import { TONE_CLASSES, describeClock, formatLatency, relativeTime } from "../device-status/logic";
import { CapacityBar, CloudNotice, ConnectionChip, Fact, PushChip } from "./parts";
import { connectionAdvice, deviceAlerts, fetchLink, formatCount, pushLink } from "./logic";

function DeviceCard({
  d,
  onRead,
  reading,
}: {
  d: DeviceControlDevice;
  onRead: (id: number) => void;
  reading: boolean;
}) {
  const [, navigate] = useLocation();
  const alerts = deviceAlerts(d);
  const advice = connectionAdvice(d);
  const cap = d.capacity;
  const users = cap?.users;
  const faces = cap?.faces;
  const down = d.isActive && d.connection.state === "disconnected";
  const connected = d.connection.state === "connected";
  const clock = describeClock(d.clockSkewSeconds ?? undefined);

  return (
    <article
      className={cn(
        "clay-card space-y-3.5 rounded-2xl p-4 ring-1",
        down ? TONE_CLASSES.bad.ring : connected ? TONE_CLASSES.good.ring : "ring-slate-200",
      )}
      data-testid={`dc-device-${d.id}`}
      data-state={d.connection.state}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-base font-black text-slate-900">
            <Fingerprint size={18} className="shrink-0 text-[#006496]" />
            <span className="truncate" data-testid={`dc-device-${d.id}-name`}>
              {d.name}
            </span>
          </h3>
          <p className="mt-0.5 truncate text-xs text-slate-500">
            {d.host}:{d.port}
            {d.serialNumber ? ` · ${d.serialNumber}` : ""}
            {cap?.platform ? ` · ${cap.platform}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1" data-testid={`dc-device-${d.id}-status`}>
          <ConnectionChip device={d} />
          <PushChip state={d.push.state} />
        </div>
      </div>

      {down && (
        <div
          className="rounded-xl bg-red-50/70 p-2.5 text-xs leading-relaxed text-red-900"
          data-testid={`dc-device-${d.id}-reason`}
        >
          <p className="font-semibold">{d.connection.reason}</p>
          {advice && (
            <p className="mt-1 opacity-90">
              <b>What to do: </b>
              {advice}
            </p>
          )}
        </div>
      )}

      {cap && (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          <CapacityBar label="Users" used={users} cap={cap.usersCap} testId={`dc-device-${d.id}-users`} />
          <CapacityBar
            label="Attendance log"
            used={cap.records}
            cap={cap.recordsCap}
            testId={`dc-device-${d.id}-records`}
          />
          {faces != null && (
            <p className="text-[11px] text-slate-500 sm:col-span-2" data-testid={`dc-device-${d.id}-faces`}>
              <b className="text-slate-700">{formatCount(faces)}</b> faces enrolled for {formatCount(users)} users
              {cap.firmware ? ` · firmware ${cap.firmware.replace(/^Ver\s*/i, "")}` : ""}
            </p>
          )}
        </div>
      )}

      <div className="space-y-1">
        <Fact icon={<Users size={12} />}>
          Users read {d.usersRead.error ? <span className="text-red-600">failed</span> : relativeTime(d.usersRead.at)}
        </Fact>
        {connected && <Fact icon={<Zap size={12} />}>Answered in {formatLatency(d.connection.latencyMs)}</Fact>}
        {clock && <Fact icon={<Clock size={12} />}>Device clock {clock}</Fact>}
        <Fact icon={<Network size={12} />}>Last heard by the server {relativeTime(d.push.lastContactAt)}</Fact>
      </div>

      {alerts.length > 0 && (
        <ul className="space-y-1" data-testid={`dc-device-${d.id}-alerts`}>
          {alerts.map((a) => (
            <li
              key={a.key}
              className={cn(
                "flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-[11px] leading-snug",
                TONE_CLASSES[a.tone].chip,
              )}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              {a.text}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => navigate(fetchLink(d.id))}
          disabled={!d.isActive}
          data-testid={`dc-device-${d.id}-fetch`}
        >
          <CloudDownload size={13} /> Fetch punches
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5"
          onClick={() => navigate(pushLink({ devices: [d.id] }))}
          disabled={!d.isActive}
          data-testid={`dc-device-${d.id}-manage`}
        >
          <UsersRound size={13} /> Manage users
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1.5"
          onClick={() => onRead(d.id)}
          disabled={!d.isActive || reading}
          aria-label={`Update the user list of ${d.name} from the device`}
          data-testid={`dc-device-${d.id}-read`}
        >
          {reading ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Read users
        </Button>
      </div>
    </article>
  );
}

/** Device Control's front page: how many devices there are, how many this server can reach, and each one's health. */
export default function OverviewTab({
  overview,
  loading,
  error,
  readingId,
  onRead,
}: {
  overview: DeviceControlOverview | undefined;
  loading: boolean;
  error: Error | null;
  readingId: number | null;
  onRead: (id: number) => void;
}) {
  const [, navigate] = useLocation();
  if (loading) return <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />;
  if (error || !overview) {
    return (
      <Card className="rounded-2xl ring-1 ring-red-200">
        <CardContent className="p-4 text-sm text-red-700" data-testid="dc-error">
          The devices could not be loaded: {error?.message ?? "the server did not answer"}.
        </CardContent>
      </Card>
    );
  }
  const { summary, devices } = overview;

  if (devices.length === 0) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="dc-empty">
          <div className="rounded-2xl bg-blue-50 p-4 text-blue-600">
            <Fingerprint size={26} />
          </div>
          <p className="font-bold text-gray-900">No biometric devices are configured yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Add each punching machine in Settings → Devices (its IP address, port and serial number), then come back
            here.
          </p>
          <Button size="sm" onClick={() => navigate("/hr/settings")}>
            Open Settings → Devices
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-5" data-testid="dc-overview">
      <CloudNotice devices={devices} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6 [&>*]:h-full [&>button>div]:h-full">
        <StatCard
          testId="dc-stat-configured"
          label="Devices configured"
          value={summary.configured}
          sub={`${summary.enabled} switched on${summary.disabled ? ` · ${summary.disabled} off` : ""}`}
          icon={Fingerprint}
          tone="bg-slate-100 text-slate-800"
        />
        <StatCard
          testId="dc-stat-connected"
          label="Connected"
          value={summary.connected}
          sub="this server can reach them now"
          icon={Wifi}
          tone="bg-green-50 text-green-800"
        />
        <StatCard
          testId="dc-stat-disconnected"
          label="Disconnected"
          value={summary.disconnected}
          sub={summary.disconnected ? "see the reason on each device" : "none"}
          icon={WifiOff}
          tone={summary.disconnected ? "bg-red-50 text-red-800" : "bg-slate-50 text-slate-500"}
        />
        <StatCard
          testId="dc-stat-pushing"
          label="Sending to the server"
          value={summary.sendingToServer}
          sub="devices pushing punches on their own"
          icon={Cpu}
          tone="bg-sky-50 text-sky-800"
        />
        <StatCard
          testId="dc-stat-people"
          label="People on devices"
          value={summary.peopleOnDevices.toLocaleString("en-IN")}
          sub={`${summary.linked.toLocaleString("en-IN")} are in the HRMS`}
          icon={Users}
          tone="bg-blue-50 text-blue-800"
        />
        <button
          type="button"
          className="block rounded-2xl text-left transition-all hover:-translate-y-0.5"
          onClick={() => navigate(pushLink({ link: "device_only" }))}
          data-view-safe
          data-testid="dc-stat-device-only"
        >
          <StatCard
            label="Not in the HRMS"
            value={summary.deviceOnly.toLocaleString("en-IN")}
            sub="on a device, no employee"
            icon={Users}
            tone="bg-amber-50 text-amber-800"
          />
        </button>
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        {[
          {
            key: "fetch",
            icon: CloudDownload,
            title: "Data Fetch",
            text: "Pull punches off the devices by hand and update the HRMS. Preview first: nothing changes until you say so.",
            go: fetchLink(),
          },
          {
            key: "push",
            icon: UsersRound,
            title: "Data Push",
            text: "See everyone on every device, who they are in the HRMS, and add, change or delete users from here.",
            go: pushLink({}),
          },
        ].map(({ key, icon: Icon, title, text, go }) => (
          <button
            key={key}
            type="button"
            onClick={() => navigate(go)}
            className="clay-card group flex items-start gap-4 rounded-2xl p-5 text-left transition-all hover:-translate-y-0.5"
            data-view-safe
            data-testid={`dc-go-${key}`}
          >
            <span className="rounded-xl bg-[#006496]/10 p-3 text-[#006496]">
              <Icon size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-base font-black text-slate-900">
                {title}
                <ArrowRight size={15} className="text-slate-400 transition-transform group-hover:translate-x-0.5" />
              </span>
              <span className="mt-1 block text-sm leading-snug text-slate-500">{text}</span>
            </span>
          </button>
        ))}
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        {devices.map((d) => (
          <DeviceCard key={d.id} d={d} onRead={onRead} reading={readingId === d.id} />
        ))}
      </div>
    </div>
  );
}
