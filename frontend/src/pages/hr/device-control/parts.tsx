import { useEffect, useState, type ReactNode } from "react";
import { Cloud, Loader2, ShieldCheck, ShieldAlert, WifiOff, Wifi, PowerOff } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import { fetchAuthedImageObjectUrl } from "@/lib/api-client/custom-hooks";
import type { DeviceControlDevice, PersonPresence, PersonRow } from "@/lib/api-client/custom-hooks";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { TONE_CLASSES, type Tone } from "../device-status/logic";
import { TonePill } from "../device-status/parts";
import { capacityLevel, formatCount, initials, isAdminRole, roleLabel, shortDeviceName } from "./logic";

// ── photos ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// An <img> cannot send the login header the photo endpoint needs, so a photo kept in the HRMS is fetched with it and
// shown from a blob URL. One fetch per photo per page visit; a saved photo drops its entry so the new one shows.
const photoCache = new Map<string, Promise<string>>();
const photoVersion = new Map<string, number>();
const photoListeners = new Set<() => void>();

/** A photo was just saved: drop what is held for it, tell every avatar on the page to fetch it again, and give the
 *  browser a different address so its own cache cannot hand back the old picture. */
export function forgetPhoto(url: string | null | undefined) {
  if (!url) return;
  const old = photoCache.get(url);
  photoCache.delete(url);
  photoVersion.set(url, (photoVersion.get(url) ?? 0) + 1);
  photoListeners.forEach((listener) => listener());
  // the avatars have moved on to the new one by now; the old blob can go
  old?.then(
    (blob) => setTimeout(() => URL.revokeObjectURL(blob), 10_000),
    () => undefined,
  );
}

const photoAddress = (url: string): string => {
  const version = photoVersion.get(url);
  return version ? `${url}${url.includes("?") ? "&" : "?"}v=${version}` : url;
};

function usePhotoSource(url: string | null | undefined): string | null {
  const { token } = useAuth();
  const [src, setSrc] = useState<string | null>(null);
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    const listener = () => setEpoch((n) => n + 1);
    photoListeners.add(listener);
    return () => {
      photoListeners.delete(listener);
    };
  }, []);
  useEffect(() => {
    let live = true;
    if (!url) {
      setSrc(null);
      return;
    }
    if (!url.startsWith("/api/")) {
      setSrc(url); // an external link or a photo captured a moment ago (a data: URL): shown as it is
      return;
    }
    let pending = photoCache.get(url);
    if (!pending) {
      pending = fetchAuthedImageObjectUrl(photoAddress(url), () => token);
      photoCache.set(url, pending);
      const mine = pending;
      mine.catch(() => {
        if (photoCache.get(url) === mine) photoCache.delete(url);
      });
    }
    pending.then(
      (blob) => live && setSrc(blob),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [url, token, epoch]);
  return src;
}

/** The person's HRMS photo when there is one, otherwise their initials in a tinted circle. */
export function PersonAvatar({
  name,
  photoUrl,
  size = 36,
  tone = "bg-slate-100 text-slate-600",
}: {
  name: string;
  photoUrl?: string | null;
  size?: number;
  tone?: string;
}) {
  const src = usePhotoSource(photoUrl);
  if (src) {
    return (
      <img
        src={src}
        alt=""
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
        data-testid="person-photo"
      />
    );
  }
  return (
    <div
      aria-hidden
      className={cn("flex shrink-0 items-center justify-center rounded-full text-xs font-bold", tone)}
      style={{ width: size, height: size }}
    >
      {initials(name)}
    </div>
  );
}

// ── chips ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export function ConnectionChip({ device, checking }: { device: DeviceControlDevice; checking?: boolean }) {
  if (checking) {
    return (
      <TonePill tone="busy">
        <Loader2 size={11} className="animate-spin" /> Checking…
      </TonePill>
    );
  }
  switch (device.connection.state) {
    case "connected":
      return (
        <TonePill tone="good">
          <Wifi size={11} /> Connected
        </TonePill>
      );
    case "disabled":
      return (
        <TonePill tone="muted">
          <PowerOff size={11} /> Switched off
        </TonePill>
      );
    case "disconnected":
      return (
        <TonePill tone="bad">
          <WifiOff size={11} /> Disconnected
        </TonePill>
      );
    default:
      return <TonePill tone="muted">Not checked</TonePill>;
  }
}

export function PushChip({ state }: { state: DeviceControlDevice["push"]["state"] }) {
  const map: Record<typeof state, { tone: Tone; label: string }> = {
    live: { tone: "good", label: "Sending to server" },
    silent: { tone: "warn", label: "Silent to server" },
    never: { tone: "muted", label: "Never sent to server" },
    disabled: { tone: "muted", label: "Switched off" },
  };
  return <TonePill tone={map[state].tone}>{map[state].label}</TonePill>;
}

export function RolePill({ privilege }: { privilege: number }) {
  const admin = isAdminRole(privilege);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold",
        admin ? "bg-violet-50 text-violet-700" : "bg-slate-100 text-slate-600",
      )}
    >
      {admin ? <ShieldAlert size={11} /> : <ShieldCheck size={11} />}
      {roleLabel(privilege)}
    </span>
  );
}

// ── capacity ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A labelled bar: how much of a device's memory is used. Turns amber from 80% and red from 95%. */
export function CapacityBar({
  label,
  used,
  cap,
  testId,
  note,
}: {
  label: string;
  used: number | undefined;
  cap: number | undefined;
  testId?: string;
  note?: ReactNode;
}) {
  const level = capacityLevel(used, cap);
  return (
    <div data-testid={testId}>
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="font-semibold text-slate-600">{label}</span>
        <span className={cn("font-bold tabular-nums", level ? TONE_CLASSES[level.tone].text : "text-slate-400")}>
          {formatCount(used)}
          {cap ? <span className="font-medium text-slate-400"> / {formatCount(cap)}</span> : null}
        </span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" role="presentation">
        <div
          className={cn("h-full rounded-full transition-all", level ? TONE_CLASSES[level.tone].dot : "bg-slate-300")}
          style={{ width: `${level?.percent ?? 0}%` }}
        />
      </div>
      {note && <p className="mt-1 text-[11px] text-slate-500">{note}</p>}
    </div>
  );
}

// ── who is on which device ─────────────────────────────────────────────────────────────────────────────────────────

/** One chip per device: filled where the person is, faint where they are not. The tooltip says what that device holds. */
export function DevicePresence({
  person,
  devices,
  onPick,
}: {
  person: PersonRow;
  devices: { id: number; name: string }[];
  onPick?: (device: { id: number; name: string }, presence: PersonPresence | undefined) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1" data-testid={`presence-${person.userId}`}>
      {devices.map((d) => {
        const on = person.presence.find((p) => p.deviceId === d.id);
        return (
          <Tooltip key={d.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => onPick?.(d, on)}
                aria-label={on ? `${d.name}: on this device` : `${d.name}: not on this device`}
                data-testid={`presence-${person.userId}-${d.id}`}
                data-on={on ? "true" : "false"}
                className={cn(
                  "rounded-md px-1.5 py-0.5 text-[10px] font-bold leading-4 transition-colors",
                  on
                    ? isAdminRole(on.privilege)
                      ? "bg-violet-600 text-white"
                      : "bg-[#006496] text-white"
                    : "border border-dashed border-slate-200 text-slate-300 hover:border-slate-300 hover:text-slate-400",
                )}
              >
                {shortDeviceName(d.name)}
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {on ? (
                <span>
                  {d.name}: {on.name || "(no name)"} · {on.role}
                  {on.card ? ` · card ${on.card}` : ""}
                  {on.hasPassword ? " · has a password" : ""}
                </span>
              ) : (
                <span>Not on {d.name}</span>
              )}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** A short line of text with a leading icon, for the small facts on a device card. */
export function Fact({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-slate-500">
      <span className="text-slate-400">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </p>
  );
}

/** Shown on a cloud-hosted server: it cannot open a session with a device on the factory network, and says what to do. */
export function CloudNotice({ devices }: { devices: DeviceControlDevice[] }) {
  const blind = devices.filter((d) => d.isActive && d.connection.code === "cloud");
  if (blind.length === 0) return null;
  return (
    <div
      className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950"
      data-testid="cloud-notice"
    >
      <Cloud size={18} className="mt-0.5 shrink-0 text-sky-600" />
      <div className="space-y-1">
        <p className="font-bold">This server runs in the cloud, so it cannot reach the devices</p>
        <p className="text-xs leading-relaxed text-sky-900/80">
          Fetching punches and managing users opens a direct connection to each device, and the devices sit on the
          factory network (192.168.x.x). Install a Site Connector on a computer at the factory (see the Site connectors
          tab) and choose it for each device under Settings → Devices → Connect via, or have the firewall forward each
          device&apos;s port to this server. Punches themselves still reach this server on their own: see Biometric
          Device Status.
        </p>
      </div>
    </div>
  );
}
