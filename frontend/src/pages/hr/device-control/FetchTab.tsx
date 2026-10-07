import { useEffect, useMemo, useState } from "react";
import { CloudDownload, Eye, Loader2, ShieldCheck } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CircleLoader } from "@/components/ui/CircleLoader";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useFetchRun,
  useFetchRuns,
  useStartFetch,
  type DeviceControlDevice,
  type DeviceControlOverview,
  type FetchPreset,
  type FetchRange,
  type FetchRun,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { TonePill } from "../device-status/parts";
import { relativeTime } from "../device-status/logic";
import FetchResults from "./FetchResults";
import { CloudNotice, ConnectionChip } from "./parts";
import { FETCH_PRESETS, describeRun, isUsable, localDate, rangeProblem } from "./logic";

/** Data Fetch: pull punches off the devices by hand. Preview changes nothing; Fetch and update writes what is new. */
export default function FetchTab({
  overview,
  loading,
}: {
  overview: DeviceControlOverview | undefined;
  loading: boolean;
}) {
  const { toast } = useToast();
  const devices = useMemo(() => overview?.devices ?? [], [overview]);
  const enabled = devices.filter((d) => d.isActive);
  const start = useStartFetch();
  const history = useFetchRuns();

  const [selected, setSelected] = useState<Set<number> | null>(null);
  const [range, setRange] = useState<FetchRange>({ preset: "today" });
  const [runId, setRunId] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const run = useFetchRun(runId);

  // The devices ticked to start with: the one named in the address (from a device card), or every one that answers.
  useEffect(() => {
    if (selected !== null || devices.length === 0) return;
    const wanted = Number(new URLSearchParams(window.location.search).get("device"));
    const named = devices.find((d) => d.id === wanted && d.isActive);
    setSelected(new Set(named ? [named.id] : devices.filter(isUsable).map((d) => d.id)));
  }, [devices, selected]);

  // A run that is still going (this page was reloaded, or a colleague started it) is picked up and followed.
  useEffect(() => {
    if (runId == null) {
      const going = history.data?.runs.find((r) => r.status === "running");
      if (going) setRunId(going.id);
    }
  }, [history.data, runId]);

  const chosen = selected ?? new Set<number>();
  const problem = rangeProblem(range);
  const running = run.data?.status === "running" || start.isPending;
  const blocked = chosen.size === 0 || !!problem || running;

  const go = async (apply: boolean) => {
    try {
      const started = await start.mutateAsync({ deviceIds: [...chosen], range, apply });
      setRunId(started.id);
    } catch (e) {
      toast({
        title: apply ? "Could not start the fetch" : "Could not start the preview",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  if (loading) return <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />;

  if (enabled.length === 0) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="px-6 py-14 text-center text-sm text-muted-foreground" data-testid="fetch-no-devices">
          No biometric device is switched on. Add one in Settings → Devices.
        </CardContent>
      </Card>
    );
  }

  const toggle = (d: DeviceControlDevice, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev ?? []);
      if (on) next.add(d.id);
      else next.delete(d.id);
      return next;
    });

  const shownRun: FetchRun | undefined = run.data;
  const past = (history.data?.runs ?? []).filter((r) => r.id !== runId);

  return (
    <div className="space-y-5" data-testid="fetch-tab">
      <CloudNotice devices={devices} />

      <Card className="rounded-2xl">
        <CardContent className="space-y-5 p-5">
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-800">1. Which devices</h3>
              <div className="flex gap-1 text-xs font-semibold text-[#006496]">
                <button
                  type="button"
                  className="rounded px-2 py-1 hover:bg-slate-50"
                  onClick={() => setSelected(new Set(enabled.filter(isUsable).map((d) => d.id)))}
                  data-testid="fetch-select-connected"
                >
                  Connected ones
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 hover:bg-slate-50"
                  onClick={() => setSelected(new Set(enabled.map((d) => d.id)))}
                >
                  All
                </button>
                <button
                  type="button"
                  className="rounded px-2 py-1 hover:bg-slate-50"
                  onClick={() => setSelected(new Set())}
                >
                  None
                </button>
              </div>
            </div>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3" data-testid="fetch-devices-pick">
              {enabled.map((d) => (
                <label
                  key={d.id}
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors",
                    chosen.has(d.id) ? "border-[#006496] bg-[#006496]/5" : "hover:bg-slate-50",
                  )}
                >
                  <Checkbox
                    checked={chosen.has(d.id)}
                    onCheckedChange={(c) => toggle(d, c === true)}
                    data-testid={`fetch-pick-${d.id}`}
                    aria-label={d.name}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold text-slate-800">{d.name}</span>
                    <span className="block truncate text-xs text-slate-500">
                      {d.capacity?.records != null
                        ? `${d.capacity.records.toLocaleString("en-IN")} punches stored`
                        : d.host}
                    </span>
                  </span>
                  <ConnectionChip device={d} />
                </label>
              ))}
            </div>
          </section>

          <section className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-bold text-slate-800">2. Which dates</h3>
            <div className="flex flex-wrap gap-1.5" data-testid="fetch-presets">
              {FETCH_PRESETS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() =>
                    setRange(
                      p.value === "custom"
                        ? { preset: "custom", from: range.from ?? localDate(), to: range.to ?? localDate() }
                        : { preset: p.value as FetchPreset },
                    )
                  }
                  aria-pressed={range.preset === p.value}
                  data-testid={`fetch-preset-${p.value}`}
                  className={cn(
                    "rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors",
                    range.preset === p.value
                      ? "border-[#006496] bg-[#006496] text-white"
                      : "bg-white text-slate-600 hover:bg-slate-50",
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
            {range.preset === "custom" && (
              <div className="flex flex-wrap items-center gap-2" data-testid="fetch-custom">
                <Input
                  type="date"
                  value={range.from ?? ""}
                  max={range.to || undefined}
                  onChange={(e) => setRange({ ...range, from: e.target.value })}
                  className="w-44"
                  aria-label="From date"
                  data-testid="fetch-from"
                />
                <span className="text-xs text-slate-400">to</span>
                <Input
                  type="date"
                  value={range.to ?? ""}
                  min={range.from || undefined}
                  onChange={(e) => setRange({ ...range, to: e.target.value })}
                  className="w-44"
                  aria-label="To date"
                  data-testid="fetch-to"
                />
              </div>
            )}
            {problem && <p className="text-xs text-red-600">{problem}</p>}
            {range.preset === "all" && (
              <p className="text-xs text-amber-700">
                This reads the whole log on each device and can take a minute or two per device. The HRMS only adds
                punches it does not already have.
              </p>
            )}
            <p className="text-xs text-slate-400">
              Dates are as the devices record them. The device keeps its whole log; this picks the days you want from
              it.
            </p>
          </section>

          <section className="flex flex-wrap items-center gap-3 border-t pt-4">
            <Button
              variant="outline"
              className="gap-1.5"
              onClick={() => go(false)}
              disabled={blocked}
              aria-label="Run a preview of this fetch"
              data-testid="fetch-preview"
            >
              {start.isPending && !confirming ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
              Preview
            </Button>
            <Button
              className="gap-1.5"
              onClick={() => setConfirming(true)}
              disabled={blocked}
              data-testid="fetch-update"
            >
              <CloudDownload size={14} /> Fetch and update HRMS
            </Button>
            <p className="flex items-center gap-1.5 text-xs text-slate-500">
              <ShieldCheck size={13} className="text-emerald-600" />
              Existing punches are never changed or deleted. Preview changes nothing at all.
            </p>
          </section>
        </CardContent>
      </Card>

      {runId != null && run.isLoading && <CircleLoader texts={["UK Textiles", "Data Fetch", "Starting"]} />}
      {shownRun && <FetchResults run={shownRun} />}

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          <p className="border-b px-4 py-3 text-sm font-bold text-slate-800">Earlier fetches</p>
          {past.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-muted-foreground" data-testid="fetch-history-empty">
              Nothing has been fetched by hand yet.
            </p>
          ) : (
            <div className="divide-y" data-testid="fetch-history">
              {past.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setRunId(r.id)}
                  className="flex w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5 text-left text-sm hover:bg-slate-50"
                  data-view-safe
                  data-testid={`fetch-history-${r.id}`}
                >
                  <span className="w-24 shrink-0 text-xs text-slate-500" title={new Date(r.createdAt).toLocaleString()}>
                    {relativeTime(r.createdAt)}
                  </span>
                  <TonePill tone={r.mode === "update" ? "info" : "muted"}>
                    {r.mode === "update" ? "Update" : "Preview"}
                  </TonePill>
                  <span className="font-semibold text-slate-700">{r.rangeLabel}</span>
                  <span className="text-xs text-slate-500">
                    {r.deviceIds.length} device{r.deviceIds.length === 1 ? "" : "s"}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-xs",
                      r.status === "failed" ? "text-red-600" : "text-slate-500",
                    )}
                  >
                    {describeRun(r)}
                  </span>
                  <span className="text-xs text-slate-400">{r.startedBy}</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="fetch-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>
              Fetch from {chosen.size} device{chosen.size === 1 ? "" : "s"} and update the HRMS?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every punch on the devices for the chosen dates that the HRMS does not have yet is added, exactly as the
              Sync Biometric button adds them. Punches the HRMS already has are left as they are, and nothing is ever
              deleted. Run a preview first if you want to see what would be added.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false);
                void go(true);
              }}
              data-testid="fetch-confirm-yes"
            >
              Fetch and update
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
