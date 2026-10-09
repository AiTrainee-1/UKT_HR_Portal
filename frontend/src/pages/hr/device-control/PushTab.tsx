import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Fingerprint,
  Layers,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CircleLoader } from "@/components/ui/CircleLoader";
import DataPagination from "@/components/ui/DataPagination";
import { useToast } from "@/hooks/use-toast";
import { useListDepartments } from "@/lib/api-client";
import {
  useDevicePeople,
  useRefreshDeviceUsers,
  type DeviceControlDevice,
  type DeviceControlOverview,
  type PeopleParams,
  type PersonRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { TONE_CLASSES, relativeTime } from "../device-status/logic";
import { StatCard } from "../account-management/parts";
import AddToDevicesDialog from "./AddToDevicesDialog";
import DeleteDialog from "./DeleteDialog";
import PeopleFilters from "./PeopleFilters";
import PeopleTable from "./PeopleTable";
import { CloudNotice } from "./parts";
import ResultDialog, { type ChangeOutcome } from "./ResultDialog";
import UserDialog from "./UserDialog";
import {
  NO_FILTERS,
  filtersActive,
  filtersFromSearch,
  filtersToSearch,
  formatCount,
  shortDeviceName,
  toParams,
  type PushFilters,
} from "./logic";

const MAX_SELECTED = 200;

type Dialog =
  | { kind: "user"; mode: "create" | "edit"; person: PersonRow | null; deviceId?: number }
  | { kind: "add"; people: PersonRow[]; deviceId?: number }
  | { kind: "delete"; people: PersonRow[] }
  | null;

/** Data Push: who is on each device, who they are in the HRMS, and adding, changing and deleting them from here. */
export default function PushTab({
  overview,
  loading,
}: {
  overview: DeviceControlOverview | undefined;
  loading: boolean;
}) {
  const { toast } = useToast();
  const devices = useMemo(() => overview?.devices ?? [], [overview]);
  const enabled = devices.filter((d) => d.isActive);
  const { data: departments } = useListDepartments();

  const [filters, setFilters] = useState<PushFilters>(() => filtersFromSearch(window.location.search));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<NonNullable<PeopleParams["sort"]>>("name");
  const [dir, setDir] = useState<"asc" | "desc">("asc");
  const [selection, setSelection] = useState<Map<string, PersonRow>>(new Map());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const [refreshingId, setRefreshingId] = useState<number | "all" | null>(null);

  const params = useMemo<PeopleParams>(
    () => ({ ...toParams(filters, page, sort, dir), pageSize }),
    [filters, page, sort, dir, pageSize],
  );
  const people = useDevicePeople(params, !loading);
  const refresh = useRefreshDeviceUsers();

  // the address says what the page shows, so a view can be bookmarked or sent to a colleague
  useEffect(() => {
    const next = `${window.location.pathname}${filtersToSearch(filters)}`;
    if (next !== `${window.location.pathname}${window.location.search}`)
      window.history.replaceState(window.history.state, "", next);
  }, [filters]);

  const change = useCallback((next: PushFilters) => {
    setFilters(next);
    setPage(1);
  }, []);
  const quick = (patch: Partial<PushFilters>) => change({ ...NO_FILTERS, ...patch });
  const onSort = (key: NonNullable<PeopleParams["sort"]>) => {
    if (key === sort) setDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSort(key);
      setDir(key === "devices" ? "desc" : "asc");
    }
    setPage(1);
  };

  const readUsers = async (deviceIds?: number[]) => {
    setRefreshingId(deviceIds?.length === 1 ? deviceIds[0] : "all");
    try {
      const res = await refresh.mutateAsync(deviceIds);
      setSelection(new Map()); // the rows picked were read before this: what they hold may have changed
      const failed = res.results.filter((r) => !r.ok);
      const ok = res.results.filter((r) => r.ok);
      toast({
        title:
          failed.length === 0
            ? `Read ${ok.length} ${ok.length === 1 ? "device" : "devices"}`
            : `Read ${ok.length} of ${res.results.length} devices`,
        description:
          failed.length > 0
            ? failed.map((f) => `${f.deviceName}: ${f.error}`).join("\n")
            : `${ok.reduce((n, r) => n + (r.count ?? 0), 0).toLocaleString("en-IN")} user records.`,
        variant: failed.length > 0 && ok.length === 0 ? "destructive" : undefined,
      });
    } catch (e) {
      toast({
        title: "Could not read the devices",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setRefreshingId(null);
    }
  };

  const facets = people.data?.facets;
  const rows = people.data?.items ?? [];
  const unread = enabled.filter((d) => !d.usersRead.at);
  const stale = enabled.filter(
    (d) => d.usersRead.at && Date.now() - new Date(d.usersRead.at).getTime() > 24 * 3600 * 1000,
  );
  const onlyDevice = filters.devices.length === 1 && filters.deviceMode === "any" ? filters.devices[0] : null;

  const toggle = (p: PersonRow, on: boolean) =>
    setSelection((prev) => {
      const next = new Map(prev);
      if (on) {
        if (next.size >= MAX_SELECTED) {
          toast({ title: `Select at most ${MAX_SELECTED} people at a time`, variant: "destructive" });
          return prev;
        }
        next.set(p.userId, p);
      } else next.delete(p.userId);
      return next;
    });
  const toggleAll = (on: boolean) =>
    setSelection((prev) => {
      const next = new Map(prev);
      for (const r of rows.filter((x) => !x.restricted)) {
        if (on && next.size < MAX_SELECTED) next.set(r.userId, r);
        if (!on) next.delete(r.userId);
      }
      return next;
    });
  const picked = [...selection.values()];
  const done = (o: ChangeOutcome) => {
    setSelection(new Map());
    setOutcome(o);
  };

  const card = (
    key: string,
    label: string,
    value: number | undefined,
    sub: string,
    tone: string,
    icon: typeof Users,
    patch: Partial<PushFilters>,
    active: boolean,
  ) => (
    <button
      key={key}
      type="button"
      onClick={() => (active ? change(NO_FILTERS) : quick(patch))}
      aria-pressed={active}
      data-view-safe
      data-testid={`push-stat-${key}`}
      className={cn(
        "block rounded-2xl text-left transition-all hover:-translate-y-0.5",
        active && "ring-2 ring-[#006496]",
      )}
    >
      <StatCard
        testId={`push-statval-${key}`}
        label={label}
        value={people.isLoading || value == null ? "—" : value.toLocaleString("en-IN")}
        sub={sub}
        icon={icon}
        tone={tone}
      />
    </button>
  );

  if (loading) return <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />;

  if (enabled.length === 0) {
    return (
      <Card className="rounded-2xl">
        <CardContent className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="push-no-devices">
          <div className="rounded-2xl bg-blue-50 p-4 text-blue-600">
            <Fingerprint size={26} />
          </div>
          <p className="font-bold text-gray-900">No biometric device is switched on</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Add each machine in Settings → Devices, then come back to see who is on it.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4" data-testid="push-tab">
      <CloudNotice devices={devices} />

      {(unread.length > 0 || stale.length > 0) && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-3 text-sm text-sky-950"
          data-testid="push-unread"
        >
          <p className="flex items-start gap-2">
            <AlertTriangle size={16} className="mt-0.5 shrink-0 text-sky-600" />
            <span>
              {unread.length > 0 ? (
                <>
                  <b>Not read yet:</b> {unread.map((d) => shortDeviceName(d.name)).join(", ")}.{" "}
                </>
              ) : null}
              {stale.length > 0 ? (
                <>
                  <b>Read more than a day ago:</b> {stale.map((d) => shortDeviceName(d.name)).join(", ")}.{" "}
                </>
              ) : null}
              The list below is what each device held when it was last read.
            </span>
          </p>
          <Button
            size="sm"
            onClick={() => readUsers()}
            disabled={refresh.isPending}
            aria-label="Update the user list from the devices"
            data-testid="push-read-banner"
          >
            {refresh.isPending ? (
              <Loader2 size={13} className="mr-1.5 animate-spin" />
            ) : (
              <RefreshCw size={13} className="mr-1.5" />
            )}
            Read them now
          </Button>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6 [&>*]:h-full [&>button>div]:h-full">
        {card(
          "all",
          "People",
          facets?.total,
          `${formatCount(facets?.onDevices)} on a device`,
          "bg-slate-100 text-slate-800",
          Users,
          {},
          !filtersActive(filters),
        )}
        {card(
          "linked",
          "In the HRMS",
          facets?.linked,
          "active employees on a device",
          "bg-green-50 text-green-800",
          UserCheck,
          { link: "linked" },
          filters.link === "linked",
        )}
        {card(
          "device-only",
          "Not in the HRMS",
          facets?.deviceOnly,
          "on a device, no employee",
          "bg-amber-50 text-amber-800",
          UserX,
          { link: "device_only" },
          filters.link === "device_only",
        )}
        {card(
          "hrms-only",
          "Not on a device",
          facets?.hrmsOnly,
          "active employees, no device",
          "bg-indigo-50 text-indigo-800",
          UserMinus,
          { link: "hrms_only" },
          filters.link === "hrms_only",
        )}
        {card(
          "inactive",
          "Inactive, still on one",
          facets?.inactiveOnDevice,
          "delete them from the device",
          "bg-red-50 text-red-800",
          UserX,
          { link: "inactive_on_device" },
          filters.link === "inactive_on_device",
        )}
        {card(
          "multiple",
          "On several devices",
          facets?.multipleDevices,
          `${formatCount(facets?.differs)} with details that differ`,
          "bg-blue-50 text-blue-800",
          Layers,
          { count: "multiple" },
          filters.count === "multiple" && filters.link === "all",
        )}
      </div>

      {/* ── the devices: click one to see only who is on it ── */}
      <div className="flex gap-2 overflow-x-auto pb-1" data-testid="push-devices">
        {devices.map((d: DeviceControlDevice) => {
          const on = onlyDevice === d.id;
          return (
            <div
              key={d.id}
              className={cn(
                "flex min-w-[11.5rem] shrink-0 items-stretch overflow-hidden rounded-xl border bg-white transition-shadow",
                on && "ring-2 ring-[#006496]",
                !d.isActive && "opacity-60",
              )}
            >
              <button
                type="button"
                onClick={() =>
                  change(
                    on
                      ? { ...filters, devices: [], deviceMode: "any" }
                      : { ...filters, devices: [d.id], deviceMode: "any" },
                  )
                }
                aria-pressed={on}
                data-testid={`push-device-${d.id}`}
                className="min-w-0 flex-1 px-3 py-2 text-left"
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "h-2 w-2 shrink-0 rounded-full",
                      d.connection.state === "connected"
                        ? TONE_CLASSES.good.dot
                        : d.connection.state === "disabled"
                          ? TONE_CLASSES.muted.dot
                          : TONE_CLASSES.bad.dot,
                    )}
                  />
                  <span className="truncate text-sm font-bold text-slate-800" title={d.name}>
                    {shortDeviceName(d.name)}
                  </span>
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  {formatCount(facets?.perDevice[String(d.id)] ?? d.capacity?.users)} users ·{" "}
                  <span className={d.usersRead.error ? "text-red-600" : ""} title={d.usersRead.error || undefined}>
                    {d.usersRead.error ? "read failed" : `read ${relativeTime(d.usersRead.at)}`}
                  </span>
                </span>
              </button>
              <button
                type="button"
                onClick={() => readUsers([d.id])}
                disabled={!d.isActive || refresh.isPending}
                title={`Update ${d.name}'s user list from the device`}
                aria-label={`Update the user list of ${d.name} from the device`}
                data-testid={`push-device-read-${d.id}`}
                className="border-l px-2.5 text-slate-400 hover:bg-slate-50 hover:text-[#006496] disabled:opacity-40"
              >
                {refreshingId === d.id ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
              </button>
            </div>
          );
        })}
        <Button
          variant="outline"
          className="h-auto shrink-0 gap-1.5 self-stretch"
          onClick={() => readUsers()}
          disabled={refresh.isPending}
          aria-label="Update the user list from all devices"
          data-testid="push-refresh"
        >
          {refreshingId === "all" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          Read all devices
        </Button>
      </div>

      {refresh.isPending && refresh.waiting && (
        <p className="text-xs text-slate-500" role="status" data-testid="push-waiting">
          {refresh.waiting}
        </p>
      )}

      <PeopleFilters
        filters={filters}
        onChange={change}
        devices={devices}
        departments={departments ?? []}
        shown={people.data?.total ?? 0}
        total={facets?.total ?? 0}
      />

      {picked.length > 0 && (
        <div
          className="sticky top-2 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-[#006496]/30 bg-white p-2.5 shadow-md"
          data-testid="push-bulk"
        >
          <span className="px-1 text-sm font-semibold text-slate-800">{picked.length} selected</span>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setDialog({ kind: "add", people: picked })}
            data-testid="push-bulk-add"
          >
            <Upload size={13} /> Add to devices…
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-red-600 hover:text-red-700"
            onClick={() => setDialog({ kind: "delete", people: picked.filter((p) => p.presence.length > 0) })}
            disabled={picked.every((p) => p.presence.length === 0)}
            data-testid="push-bulk-delete"
          >
            <Trash2 size={13} /> Delete from devices…
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelection(new Map())}>
            Clear selection
          </Button>
        </div>
      )}

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
            <p className="text-sm font-bold text-slate-800">People on the devices</p>
            <Button
              size="sm"
              className="gap-1.5"
              onClick={() => setDialog({ kind: "user", mode: "create", person: null })}
              data-testid="push-add-user"
            >
              <UserPlus size={14} /> Add user
            </Button>
          </div>
          {people.isLoading ? (
            <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />
          ) : people.isError ? (
            <div
              className="flex flex-col items-center gap-3 px-6 py-12 text-center text-sm text-red-700"
              data-testid="push-error"
            >
              <p>The list could not be loaded: {(people.error as Error)?.message}</p>
              <Button size="sm" variant="outline" onClick={() => people.refetch()}>
                Try again
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center" data-testid="push-empty">
              <div className="rounded-2xl bg-gray-100 p-4 text-gray-500">
                <CheckCircle2 size={26} />
              </div>
              <p className="font-bold text-gray-900">
                {facets && facets.total === 0 ? "Nothing to show yet" : "No one matches"}
              </p>
              <p className="max-w-sm text-sm text-muted-foreground">
                {facets && facets.total === 0
                  ? "Read the users from the devices to see who is on them."
                  : "Try fewer filters, or clear them."}
              </p>
              {facets && facets.total === 0 ? (
                <Button
                  size="sm"
                  onClick={() => readUsers()}
                  disabled={refresh.isPending}
                  aria-label="Update the user list from all devices"
                >
                  Read the devices
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => change(NO_FILTERS)}>
                  Clear filters
                </Button>
              )}
            </div>
          ) : (
            <PeopleTable
              rows={rows}
              devices={devices.filter((d) => d.isActive)}
              selected={new Set(selection.keys())}
              onToggle={toggle}
              onToggleAll={toggleAll}
              sort={sort}
              dir={dir}
              onSort={onSort}
              handlers={{
                onEdit: (p) => setDialog({ kind: "user", mode: "edit", person: p }),
                onAddTo: (p) =>
                  setDialog(
                    p.presence.length === 0
                      ? { kind: "user", mode: "create", person: p }
                      : { kind: "add", people: [p] },
                  ),
                onDelete: (p) => setDialog({ kind: "delete", people: [p] }),
                onPickDevice: (d, p) =>
                  setDialog(
                    p.presence.some((x) => x.deviceId === d.id)
                      ? { kind: "user", mode: "edit", person: p, deviceId: d.id }
                      : p.presence.length === 0
                        ? { kind: "user", mode: "create", person: p, deviceId: d.id }
                        : { kind: "add", people: [p], deviceId: d.id },
                  ),
              }}
            />
          )}
          {people.data && people.data.total > 0 && (
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

      {dialog?.kind === "user" && (
        <UserDialog
          key={`${dialog.mode}-${dialog.person?.userId ?? "new"}-${dialog.deviceId ?? "any"}`}
          mode={dialog.mode}
          open
          onClose={() => setDialog(null)}
          devices={devices}
          person={dialog.person}
          deviceId={dialog.deviceId}
          onOutcome={done}
        />
      )}
      {dialog?.kind === "add" && (
        <AddToDevicesDialog
          people={dialog.people}
          devices={devices}
          deviceId={dialog.deviceId}
          onClose={() => setDialog(null)}
          onOutcome={done}
        />
      )}
      {dialog?.kind === "delete" && (
        <DeleteDialog people={dialog.people} devices={devices} onClose={() => setDialog(null)} onOutcome={done} />
      )}
      <ResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </div>
  );
}
