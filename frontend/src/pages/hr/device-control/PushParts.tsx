import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Cable,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  History,
  Loader2,
  Search,
  Server,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useUserHistory,
  type ChangeContext,
  type DeviceControlDevice,
  type UserChangeKind,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { TONE_CLASSES, relativeTime } from "../device-status/logic";
import { changeLabel, changePeople, changeResultText, formatCount, isUsable, viaText } from "./logic";

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** "Direct" / "Site Connector · name", with its icon: how this server reaches the device (Settings -> Devices). */
export function ViaTag({ device, className }: { device: DeviceControlDevice; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 text-[11px] text-slate-500", className)}>
      {device.via ? <Cable size={11} /> : <Server size={11} />}
      <span className="truncate">{viaText(device)}</span>
    </span>
  );
}

const dotFor = (d: DeviceControlDevice) =>
  d.connection.state === "connected"
    ? TONE_CLASSES.good.dot
    : d.connection.state === "disabled"
      ? TONE_CLASSES.muted.dot
      : d.connection.state === "unknown"
        ? "bg-slate-300"
        : TONE_CLASSES.bad.dot;

const stateText = (d: DeviceControlDevice) =>
  d.connection.state === "connected"
    ? "Connected"
    : d.connection.state === "disabled"
      ? "Switched off"
      : d.connection.state === "unknown"
        ? "Not checked"
        : "Disconnected";

/**
 * The devices a Data Push sub-tab works on, as cards: connection, how this server reaches it (direct or through a Site
 * Connector, as chosen in Settings -> Devices), how many users it held when last read. `single` picks one (Edit Users'
 * device); otherwise any number, with "every reachable one" and "none".
 */
export function DeviceTargets({
  devices,
  chosen,
  onChange,
  single = false,
  canPick = isUsable,
  whyNot = "Not reachable now: check its connection on the Overview.",
  counts,
  note,
  testId,
}: {
  devices: DeviceControlDevice[];
  chosen: number[];
  onChange: (ids: number[]) => void;
  single?: boolean;
  /** Whether a device can be ticked (reachable, by default). */
  canPick?: (d: DeviceControlDevice) => boolean;
  whyNot?: string;
  /** People on each device in the stored lists, by id. */
  counts?: Record<string, number>;
  /** A line under each card (e.g. "12 to add"). */
  note?: (d: DeviceControlDevice) => string | null;
  testId: string;
}) {
  const shown = devices.filter((d) => d.isActive);
  const pickable = shown.filter(canPick).map((d) => d.id);
  const toggle = (id: number) => {
    if (single) onChange([id]);
    else onChange(chosen.includes(id) ? chosen.filter((x) => x !== id) : [...chosen, id]);
  };

  return (
    <div className="@container space-y-2" data-testid={testId}>
      {!single && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold text-slate-600">
            {chosen.length} of {shown.length} device{shown.length === 1 ? "" : "s"} chosen
          </span>
          <button
            type="button"
            className="rounded-lg px-2 py-1 font-semibold text-[#006496] hover:bg-sky-50 disabled:opacity-40"
            onClick={() => onChange(pickable)}
            disabled={pickable.length === 0}
            data-view-safe
            data-testid={`${testId}-all`}
          >
            Every reachable device ({pickable.length})
          </button>
          {chosen.length > 0 && (
            <button
              type="button"
              className="rounded-lg px-2 py-1 font-semibold text-slate-500 hover:bg-slate-100"
              onClick={() => onChange([])}
              data-view-safe
              data-testid={`${testId}-none`}
            >
              None
            </button>
          )}
        </div>
      )}
      <div className="grid grid-cols-1 gap-2 @md:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-4">
        {shown.map((d) => {
          const on = chosen.includes(d.id);
          const ok = canPick(d);
          const line = note?.(d);
          return (
            <button
              key={d.id}
              type="button"
              role={single ? "radio" : "checkbox"}
              aria-checked={on}
              disabled={!ok && !on}
              onClick={() => toggle(d.id)}
              title={ok ? d.name : whyNot}
              className={cn(
                "flex min-w-0 items-start gap-2.5 rounded-xl border bg-white px-3 py-2.5 text-left transition-colors",
                on ? "border-[#006496] ring-2 ring-sky-100" : "hover:border-slate-300",
                !ok && "cursor-not-allowed opacity-60",
              )}
              data-view-safe
              data-testid={`${testId}-${d.id}`}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center border-2",
                  single ? "rounded-full" : "rounded",
                  on ? "border-[#006496] bg-[#006496]" : "border-slate-300 bg-white",
                )}
              >
                {on && (
                  <span className={cn("bg-white", single ? "h-1.5 w-1.5 rounded-full" : "h-1.5 w-1.5 rounded-sm")} />
                )}
              </span>
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block truncate text-sm font-bold text-slate-800">{d.name}</span>
                <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dotFor(d))} />
                  {stateText(d)} · {formatCount(counts?.[String(d.id)] ?? d.capacity?.users)} users
                </span>
                <ViaTag device={d} className="flex" />
                <span className="block text-[11px] text-slate-400">
                  {d.usersRead.error ? (
                    <span className="text-red-600">list read failed</span>
                  ) : d.usersRead.at ? (
                    `list read ${relativeTime(d.usersRead.at)}`
                  ) : (
                    "list never read"
                  )}
                </span>
                {line && <span className="block text-[11px] font-semibold text-[#006496]">{line}</span>}
              </span>
            </button>
          );
        })}
      </div>
      {shown.length === 0 && <p className="text-xs text-slate-500">No device is switched on (Settings → Devices).</p>}
    </div>
  );
}

/** While a change runs: the devices it is going to, and what is being waited for (a Site Connector picks a job up
 *  within seconds and answers when every device has); the result dialog then shows each device's outcome. */
export function OperationStatus({
  devices,
  waiting,
  label,
}: {
  devices: DeviceControlDevice[];
  waiting: string;
  label: string;
}) {
  return (
    <div className="space-y-2 rounded-xl border border-sky-200 bg-sky-50 p-3" role="status" data-testid="op-status">
      <p className="flex items-center gap-2 text-sm font-semibold text-sky-950">
        <Loader2 size={14} className="animate-spin" /> {label}
      </p>
      <ul className="grid gap-1 sm:grid-cols-2">
        {devices.map((d) => (
          <li key={d.id} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-1.5 text-xs">
            <Loader2 size={12} className="shrink-0 animate-spin text-sky-600" />
            <span className="min-w-0 flex-1 truncate font-semibold text-slate-800">{d.name}</span>
            <ViaTag device={d} />
          </li>
        ))}
      </ul>
      {waiting && <p className="text-xs text-sky-900">{waiting}</p>}
    </div>
  );
}

const STATUS = {
  done: { icon: CheckCircle2, text: "Done", cls: "bg-emerald-50 text-emerald-700" },
  partial: { icon: AlertTriangle, text: "Partly done", cls: "bg-amber-50 text-amber-700" },
  failed: { icon: XCircle, text: "Failed", cls: "bg-red-50 text-red-600" },
} as const;

const when = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * The history of user changes on the devices (owner 2026-11-17): what was done, for whom, on which devices and with
 * what result on each, by whom, and whether it went through a Site Connector. Kept by the server for direct devices and
 * connector devices alike.
 */
export function UserHistory({
  title,
  kind = "",
  contexts = [],
  testId,
}: {
  title: string;
  kind?: UserChangeKind | "";
  contexts?: ChangeContext[];
  testId: string;
}) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search]);
  const q = useUserHistory(kind, search, page, contexts);
  const data = q.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <Card className="overflow-hidden rounded-2xl" data-testid={testId}>
      <CardContent className="p-0">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <p className="flex items-center gap-1.5 text-sm font-bold text-slate-800">
            <History size={14} /> {title} {data ? `(${data.total.toLocaleString("en-IN")})` : ""}
          </p>
          <div className="relative w-full sm:w-64">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="User ID, name or device"
              className="h-8 pl-8 text-xs"
              aria-label="Search the history"
              data-testid={`${testId}-search`}
            />
          </div>
        </div>
        {q.isLoading && !data ? (
          <div className="p-4">
            <Skeleton className="h-24 rounded-xl" />
          </div>
        ) : !data || data.rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-slate-500" data-testid={`${testId}-empty`}>
            {search ? "Nothing in the history matches." : "Nothing has been done here yet."}
          </p>
        ) : (
          <ul className="divide-y" data-testid={`${testId}-rows`}>
            {data.rows.map((c) => {
              const s = STATUS[c.status];
              const Icon = s.icon;
              return (
                <li key={c.id} className="space-y-1.5 px-4 py-3" data-testid={`${testId}-row-${c.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold",
                        s.cls,
                      )}
                    >
                      <Icon size={11} /> {s.text}
                    </span>
                    <span className="text-sm font-bold text-slate-800">{changeLabel(c)}</span>
                    <span className="min-w-0 truncate text-sm text-slate-700">{changePeople(c)}</span>
                    <span className="ml-auto whitespace-nowrap text-[11px] text-slate-400">
                      {when(c.at)}
                      {c.requestedBy ? ` · ${c.requestedBy}` : ""}
                      {c.viaConnector ? " · through a Site Connector" : ""}
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {c.results.map((r, i) => (
                      <span
                        key={`${r.deviceName}-${i}`}
                        className={cn(
                          "inline-flex items-center gap-1 rounded-lg border px-2 py-0.5 text-[11px]",
                          r.ok && !r.failed
                            ? "border-slate-200 text-slate-600"
                            : r.ok
                              ? "border-amber-200 bg-amber-50 text-amber-800"
                              : "border-red-200 bg-red-50 text-red-700",
                        )}
                      >
                        <b className="font-semibold">{r.deviceName}</b> {changeResultText(r)}
                      </span>
                    ))}
                    {c.rejected > 0 && (
                      <span className="rounded-lg border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-800">
                        {c.rejected} refused before sending
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {data && pages > 1 && (
          <div className="flex items-center justify-end gap-2 border-t px-4 py-2 text-xs text-slate-500">
            Page {page} of {pages}
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
              aria-label="Previous page"
              data-view-safe
            >
              <ChevronLeft size={14} />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
              aria-label="Next page"
              data-view-safe
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
