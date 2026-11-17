import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Search, Upload, UserPlus, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CircleLoader } from "@/components/ui/CircleLoader";
import DataPagination from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useDevicePeople,
  usePushDeviceUsers,
  type DeviceControlDevice,
  type EmploymentType,
  type PersonRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { PersonAvatar } from "./parts";
import { DeviceTargets, OperationStatus, UserHistory, useDebounced } from "./PushParts";
import ResultDialog, { type ChangeOutcome } from "./ResultDialog";
import { EmploymentFilter } from "./SubTabs";
import UserDialog from "./UserDialog";
import { copyInput, isUsable, missingFrom, shortDeviceName } from "./logic";

const MAX_PEOPLE = 200; // what the server takes in one change

/**
 * Data Push -> Add Users (owner 2026-11-17): choose the devices (one, several or every reachable one), then either
 * create a user by hand or pick the active employees those devices do not have yet, and push them. Each device answers
 * for itself (direct, or through its Site Connector) and the result shows every device's outcome; the change is kept
 * in the history below.
 */
export default function AddUsersView({ devices }: { devices: DeviceControlDevice[] }) {
  const { toast } = useToast();
  const [targets, setTargets] = useState<number[]>(() => devices.filter(isUsable).map((d) => d.id));
  const [kind, setKind] = useState<EmploymentType | "">("");
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [onNoDevice, setOnNoDevice] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selection, setSelection] = useState<Map<string, PersonRow>>(new Map());
  const [creating, setCreating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const push = usePushDeviceUsers();
  useEffect(() => setPage(1), [search, kind, onNoDevice, targets]);

  const people = useDevicePeople(
    {
      search,
      link: onNoDevice ? "hrms_only" : "active",
      devices: targets,
      deviceMode: "missing",
      employmentType: kind,
      sort: "code",
      page,
      pageSize,
    },
    targets.length > 0,
  );
  const rows = useMemo(() => (people.data?.items ?? []).filter((p) => !p.restricted), [people.data]);
  const chosenDevices = devices.filter((d) => targets.includes(d.id));
  const picked = [...selection.values()];
  const entries = picked.reduce((n, p) => n + missingFrom(p, targets).length, 0);

  const toggle = (p: PersonRow, on: boolean) =>
    setSelection((prev) => {
      const next = new Map(prev);
      if (on && next.size >= MAX_PEOPLE) {
        toast({ title: `Choose at most ${MAX_PEOPLE} people at a time`, variant: "destructive" });
        return prev;
      }
      if (on) next.set(p.userId, p);
      else next.delete(p.userId);
      return next;
    });
  const allOnPage = rows.length > 0 && rows.every((r) => selection.has(r.userId));
  const togglePage = (on: boolean) =>
    setSelection((prev) => {
      const next = new Map(prev);
      for (const r of rows) {
        if (on && next.size < MAX_PEOPLE) next.set(r.userId, r);
        if (!on) next.delete(r.userId);
      }
      return next;
    });

  const go = async () => {
    try {
      const result = await push.mutateAsync({ deviceIds: targets, users: picked.map(copyInput), context: "add" });
      setSelection(new Map());
      setConfirming(false);
      setOutcome({ kind: "push", result });
    } catch (e) {
      toast({
        title: "Could not add them",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4" data-testid="push-add">
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-800">1. Devices to add to</h3>
              <p className="text-xs text-slate-500">
                Each device is reached the way Settings → Devices says (direct or through its Site Connector).
              </p>
            </div>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setCreating(true)}
              disabled={targets.length === 0}
              data-testid="push-add-create"
            >
              <UserPlus size={14} /> Create a user by hand
            </Button>
          </div>
          <DeviceTargets
            devices={devices}
            chosen={targets}
            onChange={(ids) => {
              setTargets(ids);
              setConfirming(false);
            }}
            counts={people.data?.facets.perDevice}
            testId="push-add-devices"
          />
        </CardContent>
      </Card>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          <div className="space-y-3 border-b p-4">
            <div>
              <h3 className="text-sm font-bold text-slate-800">2. Employees not on them yet</h3>
              <p className="text-xs text-slate-500">
                Active employees missing from at least one chosen device. They are written with the name, role and card
                another device already holds for them, or their HRMS name. A device that already has someone leaves them
                alone.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative min-w-[14rem] flex-1">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by Employee Code, name or department"
                  className="pl-8"
                  data-testid="push-add-search"
                />
              </div>
              <EmploymentFilter value={kind} onChange={setKind} testId="push-add-kind" />
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <Switch
                  checked={onNoDevice}
                  onCheckedChange={setOnNoDevice}
                  data-testid="push-add-none"
                  data-view-safe
                />
                Only those on no device at all
              </label>
            </div>
          </div>

          {targets.length === 0 ? (
            <p className="px-4 py-10 text-center text-sm text-slate-500" data-testid="push-add-pick-devices">
              Choose at least one device above.
            </p>
          ) : people.isLoading ? (
            <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />
          ) : people.isError ? (
            <div className="flex flex-col items-center gap-3 px-6 py-10 text-center text-sm text-red-700">
              <p>The list could not be loaded: {(people.error as Error)?.message}</p>
              <Button size="sm" variant="outline" onClick={() => people.refetch()}>
                Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-6 py-12 text-center" data-testid="push-add-empty">
              <CheckCircle2 size={24} className="text-emerald-600" />
              <p className="font-bold text-slate-900">
                {search || kind ? "No one matches" : "Every active employee is on these devices"}
              </p>
              <p className="max-w-sm text-xs text-slate-500">
                This is from the user lists as the devices were last read. Read them again on the Overview sub-tab if
                someone was added on the device itself.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="push-add-table">
                <thead className="bg-slate-50 text-left text-xs text-slate-500">
                  <tr>
                    <th className="w-10 px-4 py-2">
                      <Checkbox
                        checked={allOnPage}
                        onCheckedChange={(c) => togglePage(c === true)}
                        aria-label="Choose everyone on this page"
                        data-testid="push-add-page"
                      />
                    </th>
                    <th className="px-2 py-2 font-semibold">Employee</th>
                    <th className="px-2 py-2 font-semibold">Kind</th>
                    <th className="px-2 py-2 font-semibold">Missing from</th>
                    <th className="px-2 py-2 font-semibold">Already on</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {rows.map((p) => {
                    const missing = missingFrom(p, targets);
                    const on = selection.has(p.userId);
                    return (
                      <tr
                        key={p.userId}
                        className={cn("cursor-pointer hover:bg-slate-50", on && "bg-sky-50")}
                        onClick={() => toggle(p, !on)}
                        data-testid={`push-add-row-${p.userId}`}
                      >
                        <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                          <Checkbox
                            checked={on}
                            onCheckedChange={(c) => toggle(p, c === true)}
                            aria-label={`Choose ${p.employee?.name ?? p.userId}`}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <span className="flex items-center gap-2.5">
                            <PersonAvatar name={p.employee?.name ?? p.name} photoUrl={p.employee?.photoUrl} size={30} />
                            <span className="min-w-0">
                              <span className="block truncate font-semibold text-slate-900">
                                {p.employee?.name ?? p.name}
                              </span>
                              <span className="block truncate font-mono text-[11px] text-slate-500">
                                {p.userId}
                                {p.employee?.department ? ` · ${p.employee.department}` : ""}
                              </span>
                            </span>
                          </span>
                        </td>
                        <td className="px-2 py-2 text-xs capitalize text-slate-600">
                          {p.employee?.employmentType || "—"}
                        </td>
                        <td className="px-2 py-2">
                          <span className="flex flex-wrap gap-1">
                            {missing.map((id) => {
                              const d = devices.find((x) => x.id === id);
                              return (
                                <span
                                  key={id}
                                  className="rounded-md border border-dashed border-sky-300 px-1.5 text-[10px] font-bold leading-5 text-[#006496]"
                                  title={d?.name}
                                >
                                  {shortDeviceName(d?.name ?? `#${id}`)}
                                </span>
                              );
                            })}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-xs text-slate-500">
                          {p.presence.length === 0
                            ? "no device"
                            : p.presence
                                .map((x) => shortDeviceName(devices.find((d) => d.id === x.deviceId)?.name ?? ""))
                                .join(", ")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {people.data && people.data.total > 0 && targets.length > 0 && (
            <div className="border-t p-3">
              <DataPagination
                page={people.data.page}
                totalPages={people.data.pages}
                onPageChange={setPage}
                pageSize={pageSize}
                onPageSizeChange={(n) => {
                  setPageSize(n);
                  setPage(1);
                }}
                totalItems={people.data.total}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {picked.length > 0 && (
        <div
          className="sticky bottom-3 z-10 space-y-3 rounded-2xl border border-sky-200 bg-white p-3 shadow-lg"
          data-testid="push-add-bar"
        >
          {push.isPending ? (
            <OperationStatus
              devices={chosenDevices}
              waiting={push.waiting}
              label={`Adding ${picked.length} ${picked.length === 1 ? "person" : "people"}…`}
            />
          ) : confirming ? (
            <div className="flex flex-wrap items-center gap-3" data-testid="push-add-confirm">
              <p className="min-w-0 flex-1 text-sm text-slate-800">
                Add <b>{picked.length}</b> {picked.length === 1 ? "employee" : "employees"} wherever they are missing on{" "}
                <b>{chosenDevices.map((d) => shortDeviceName(d.name)).join(", ")}</b>: {entries}{" "}
                {entries === 1 ? "entry" : "entries"} in all. Each device is read back to be sure.
              </p>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Back
              </Button>
              <Button size="sm" className="gap-1.5" onClick={go} data-testid="push-add-go">
                <Upload size={13} /> Add them now
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex items-center gap-1.5 px-1 text-sm font-semibold text-slate-800">
                <Users size={14} /> {picked.length} chosen
              </span>
              <span className="text-xs text-slate-500">
                {entries} {entries === 1 ? "entry" : "entries"} on {targets.length} device
                {targets.length === 1 ? "" : "s"}
              </span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => setSelection(new Map())} data-view-safe>
                Clear
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                onClick={() => setConfirming(true)}
                disabled={targets.length === 0 || entries === 0}
                data-testid="push-add-review"
              >
                <Upload size={13} /> Add to the devices…
              </Button>
            </div>
          )}
        </div>
      )}

      <UserHistory title="Users added" kind="create" testId="push-add-history" />

      {creating && (
        <UserDialog
          mode="create"
          open
          onClose={() => setCreating(false)}
          devices={devices}
          person={null}
          deviceIds={targets}
          context="add"
          onOutcome={(o) => setOutcome(o)}
        />
      )}
      <ResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </div>
  );
}
