import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Link2, Loader2, Search, Unlink2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useDeviceLinks,
  useSetEmployeeDeviceLinks,
  type DeviceControlDevice,
  type DeviceControlOverview,
  type DeviceLinkRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { TonePill } from "../device-status/parts";
import { ConnectionChip, PersonAvatar } from "./parts";

const useDebounced = <T,>(value: T, ms = 300): T => {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
};

function EmployeeLinks({ row, devices }: { row: DeviceLinkRow; devices: DeviceControlDevice[] }) {
  const { toast } = useToast();
  const save = useSetEmployeeDeviceLinks();
  const [busyId, setBusyId] = useState<number | "all" | null>(null);
  const known = new Set(devices.map((d) => d.id));
  // only devices that still exist count (a device removed from Settings has nothing to link)
  const unlinked = row.unlinked.filter((id) => known.has(id));
  const linkedCount = devices.length - unlinked.length;
  const allLinked = unlinked.length === 0;

  const apply = async (next: number[], busy: number | "all", message: string) => {
    setBusyId(busy);
    try {
      await save.mutateAsync({ employeeId: row.employeeId, unlinkedDeviceIds: next });
      toast({ title: message });
    } catch (e) {
      toast({
        title: "Could not save",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const toggle = (d: DeviceControlDevice, linked: boolean) => {
    const next = linked ? unlinked.filter((id) => id !== d.id) : [...unlinked, d.id];
    void apply(next, d.id, linked ? `${d.name} is linked to ${row.name}` : `${d.name} is unlinked from ${row.name}`);
  };

  return (
    <Card className="overflow-hidden rounded-2xl" data-testid={`link-card-${row.code}`}>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <PersonAvatar name={row.name} size={40} tone="bg-blue-50 text-blue-700" />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-x-2 font-bold text-slate-900">
              <span className="truncate">{row.name}</span>
              {row.status !== "active" && <span className="text-[11px] font-medium text-red-500">Inactive</span>}
            </p>
            <p className="truncate text-xs text-slate-500">
              <span className="font-mono">{row.code}</span>
              {row.department ? ` · ${row.department}` : ""}
              {row.branch ? ` · ${row.branch}` : ""}
            </p>
          </div>
          <TonePill tone={allLinked ? "good" : linkedCount === 0 ? "bad" : "warn"}>
            <span data-testid={`link-summary-${row.code}`}>
              {allLinked
                ? `All ${devices.length} devices linked`
                : `${linkedCount} of ${devices.length} devices linked`}
            </span>
          </TonePill>
          {!allLinked && (
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-xs"
              disabled={save.isPending}
              onClick={() => void apply([], "all", `Every device is linked to ${row.name}`)}
              data-testid={`link-all-${row.code}`}
            >
              {busyId === "all" ? <Loader2 size={13} className="animate-spin" /> : <Link2 size={13} />}
              Link all
            </Button>
          )}
        </div>

        {linkedCount === 0 && devices.length > 0 && (
          <p
            className="flex items-start gap-2 rounded-lg bg-red-50 p-2.5 text-xs text-red-800"
            data-testid={`link-none-${row.code}`}
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            No device is linked: no punch from any device will be recorded for {row.name}.
          </p>
        )}

        <div className="divide-y rounded-xl border">
          {devices.map((d) => {
            const linked = !unlinked.includes(d.id);
            const holds = row.onDevices.includes(d.id);
            return (
              <label
                key={d.id}
                className={cn("flex cursor-pointer items-center gap-3 px-3 py-2.5 text-sm hover:bg-slate-50")}
              >
                <Switch
                  checked={linked}
                  disabled={save.isPending}
                  onCheckedChange={(c) => toggle(d, c === true)}
                  aria-label={`${d.name} linked to ${row.name}`}
                  data-testid={`link-${row.code}-${d.id}`}
                />
                <span className="min-w-0 flex-1">
                  <span className={cn("font-semibold", linked ? "text-slate-800" : "text-slate-400 line-through")}>
                    {d.name}
                  </span>
                  {holds && (
                    <span className="ml-2 text-[11px] text-slate-400" title="A user with this code is on the device">
                      has this code
                    </span>
                  )}
                </span>
                {busyId === d.id ? (
                  <Loader2 size={14} className="animate-spin text-slate-400" />
                ) : (
                  <span
                    className={cn("text-xs font-semibold", linked ? "text-emerald-700" : "text-amber-700")}
                    data-testid={`link-state-${row.code}-${d.id}`}
                  >
                    {linked ? "Linked" : "Unlinked"}
                  </span>
                )}
                {!d.isActive ? (
                  <span className="text-xs text-slate-400">switched off</span>
                ) : (
                  <ConnectionChip device={d} />
                )}
              </label>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Link / Unlink: which biometric devices give an employee's punches. Every device is linked to every employee by default
 * (and a device added later too); unlink a device from an employee and the punches carrying that employee's code from that
 * device are ignored. For two people who share an Employee Code on devices in different units.
 */
export default function LinkTab({
  overview,
  loading,
}: {
  overview: DeviceControlOverview | undefined;
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const links = useDeviceLinks(search);
  const devices = overview?.devices ?? [];
  const items = links.data?.items ?? [];
  const showingRestricted = !search;

  return (
    <div className="space-y-4" data-testid="link-tab">
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-blue-50 p-2 text-blue-700">
              <Unlink2 size={18} />
            </div>
            <div className="text-sm text-slate-600">
              <p className="font-bold text-slate-900">Link or unlink devices for an employee</p>
              <p className="mt-0.5 text-xs leading-snug">
                Every device is linked to every employee: their attendance is matched by Employee Code across all the
                devices, and a device you add later is linked too. Unlink a device from an employee and punches with
                their code from that device are ignored from now on, so a different person with the same code in another
                unit cannot get punches written onto them. Punches already recorded are never changed.
              </p>
            </div>
          </div>
          <div className="relative">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search an employee by Employee Code or name"
              className="pl-9 pr-9"
              aria-label="Search employees"
              data-testid="link-search"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded p-1 text-slate-400 hover:text-slate-700"
              >
                <X size={14} />
              </button>
            )}
          </div>
        </CardContent>
      </Card>

      {loading || (links.isLoading && !links.data) ? (
        <div className="space-y-3">
          <Skeleton className="h-40 rounded-2xl" />
        </div>
      ) : links.isError ? (
        <Card className="rounded-2xl ring-1 ring-red-200">
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm text-red-700">
            <span>The employees could not be loaded: {(links.error as Error)?.message ?? "no answer"}.</span>
            <Button size="sm" variant="outline" onClick={() => links.refetch()}>
              Try again
            </Button>
          </CardContent>
        </Card>
      ) : devices.length === 0 ? (
        <Card className="rounded-2xl">
          <CardContent className="p-6 text-center text-sm text-slate-500" data-testid="link-no-devices">
            No device is set up yet. Add one in Settings → Devices; it is linked to every employee from the start.
          </CardContent>
        </Card>
      ) : (
        <>
          {showingRestricted && (
            <p className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500" data-testid="link-heading">
              {items.length > 0
                ? `Employees with a device unlinked (${items.length})`
                : "Search for an employee above to link or unlink their devices."}
            </p>
          )}
          {items.length === 0 ? (
            <Card className="rounded-2xl">
              <CardContent
                className="flex flex-col items-center gap-2 p-8 text-center text-sm text-slate-500"
                data-testid="link-empty"
              >
                <CheckCircle2 size={24} className={showingRestricted ? "text-emerald-500" : "text-slate-300"} />
                {showingRestricted ? "Every employee is linked to every device." : `No employee matches “${search}”.`}
              </CardContent>
            </Card>
          ) : (
            items.map((row) => <EmployeeLinks key={row.employeeId} row={row} devices={devices} />)
          )}
        </>
      )}
    </div>
  );
}
