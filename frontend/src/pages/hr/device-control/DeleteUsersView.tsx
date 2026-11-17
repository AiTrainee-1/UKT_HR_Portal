import { useEffect, useMemo, useState } from "react";
import { CreditCard, Search, Trash2, UserX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CircleLoader } from "@/components/ui/CircleLoader";
import DataPagination from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useDevicePeople,
  type DeviceControlDevice,
  type EmploymentType,
  type PersonLink,
  type PersonRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import DeleteDialog from "./DeleteDialog";
import { ConnectionChip, PersonAvatar, RolePill } from "./parts";
import { UserHistory, ViaTag, useDebounced } from "./PushParts";
import ResultDialog, { type ChangeOutcome } from "./ResultDialog";
import { EmploymentFilter } from "./SubTabs";

const MAX_PEOPLE = 200;

const LINKS: { value: "all" | PersonLink; label: string }[] = [
  { value: "all", label: "Everyone on a device" },
  { value: "inactive_on_device", label: "Inactive in the HRMS" },
  { value: "device_only", label: "Not in the HRMS" },
  { value: "linked", label: "Active employees" },
];

/**
 * Data Push -> Delete Users (owner 2026-11-17): find a person, see every device that holds them (and what each holds),
 * tick the devices to delete them from (one, several or all), confirm, and see each device's result. The employee is
 * never deleted from the HRMS (the confirmation can make them Inactive). Every deletion is in the history below.
 */
export default function DeleteUsersView({ devices }: { devices: DeviceControlDevice[] }) {
  const { toast } = useToast();
  const activeIds = useMemo(() => devices.filter((d) => d.isActive).map((d) => d.id), [devices]);
  const [kind, setKind] = useState<EmploymentType | "">("");
  const [link, setLink] = useState<"all" | PersonLink>("all");
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(15);
  const [selection, setSelection] = useState<Map<string, PersonRow>>(new Map());
  const [deviceChoice, setDeviceChoice] = useState<number[] | null>(null); // null = every device that holds them
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  useEffect(() => setPage(1), [search, kind, link]);

  const people = useDevicePeople(
    {
      search,
      link,
      devices: activeIds,
      deviceMode: "any",
      employmentType: kind,
      sort: "code",
      page,
      pageSize,
    },
    activeIds.length > 0,
  );
  const rows = useMemo(() => people.data?.items ?? [], [people.data]);
  const picked = useMemo(() => [...selection.values()], [selection]);

  // the devices holding anyone chosen, with how many of them and (for one person) what that device holds
  const holding = useMemo(() => {
    const counts = new Map<number, number>();
    for (const p of picked) for (const x of p.presence) counts.set(x.deviceId, (counts.get(x.deviceId) ?? 0) + 1);
    return devices.filter((d) => counts.has(d.id)).map((d) => ({ device: d, count: counts.get(d.id) ?? 0 }));
  }, [picked, devices]);
  const chosenDevices = deviceChoice ?? holding.map((h) => h.device.id);
  const single = picked.length === 1 ? picked[0] : null;

  const toggle = (p: PersonRow, on: boolean) => {
    setDeviceChoice(null);
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
  };
  const toggleDevice = (id: number, on: boolean) => {
    const now = new Set(chosenDevices);
    if (on) now.add(id);
    else now.delete(id);
    setDeviceChoice([...now]);
  };
  const done = (o: ChangeOutcome) => {
    setSelection(new Map());
    setDeviceChoice(null);
    setOutcome(o);
  };

  return (
    <div className="space-y-4" data-testid="push-delete">
      <div className="grid items-start gap-4 lg:grid-cols-5">
        <Card className="overflow-hidden rounded-2xl lg:col-span-3">
          <CardContent className="p-0">
            <div className="space-y-3 border-b p-4">
              <div>
                <h3 className="text-sm font-bold text-slate-800">1. Who to delete</h3>
                <p className="text-xs text-slate-500">
                  People on the devices as they were last read. Tick one or more.
                </p>
              </div>
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by user ID, name, card or department"
                  className="pl-8"
                  data-testid="push-delete-search"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <EmploymentFilter value={kind} onChange={setKind} testId="push-delete-kind" />
                <select
                  value={link}
                  onChange={(e) => setLink(e.target.value as "all" | PersonLink)}
                  className="h-9 rounded-lg border bg-white px-2 text-xs"
                  aria-label="Who"
                  data-testid="push-delete-link"
                >
                  {LINKS.map((l) => (
                    <option key={l.value} value={l.value}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {people.isLoading ? (
              <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />
            ) : rows.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-slate-500" data-testid="push-delete-empty">
                No one on a device matches.
              </p>
            ) : (
              <ul className="divide-y" data-testid="push-delete-list">
                {rows.map((p) => {
                  const on = selection.has(p.userId);
                  const name = p.employee?.name ?? p.name;
                  return (
                    <li key={p.userId}>
                      <label
                        className={cn(
                          "flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-slate-50",
                          on && "bg-red-50",
                          p.restricted && "cursor-not-allowed opacity-60",
                        )}
                        data-testid={`push-delete-row-${p.userId}`}
                      >
                        <Checkbox
                          checked={on}
                          disabled={p.restricted}
                          onCheckedChange={(c) => toggle(p, c === true)}
                          aria-label={`Choose ${p.userId}`}
                        />
                        <PersonAvatar name={name || p.userId} photoUrl={p.employee?.photoUrl} size={30} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-slate-900">
                            {name || "(no name)"}
                          </span>
                          <span className="block truncate text-[11px] text-slate-500">
                            <span className="font-mono">{p.userId}</span>
                            {p.employee
                              ? ` · ${p.employee.employmentType}${p.employee.status !== "active" ? " · Inactive" : ""}`
                              : " · not in the HRMS"}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs text-slate-500">
                          on {p.deviceCount} device{p.deviceCount === 1 ? "" : "s"}
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
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
                  pageSizes={[15, 25, 50]}
                  totalItems={people.data.total}
                />
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="rounded-2xl lg:sticky lg:top-3 lg:col-span-2">
          <CardContent className="space-y-3 p-4" data-testid="push-delete-where">
            <h3 className="text-sm font-bold text-slate-800">2. Where they are</h3>
            {picked.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-slate-500">
                <UserX size={22} className="text-slate-400" />
                Choose someone on the left to see the devices that hold them.
              </div>
            ) : (
              <>
                <p className="text-xs text-slate-600">
                  {single ? (
                    <>
                      <b>{single.employee?.name ?? single.name}</b> ({single.userId}) is on {holding.length} device
                      {holding.length === 1 ? "" : "s"}.
                    </>
                  ) : (
                    <>
                      <b>{picked.length}</b> people chosen, on {holding.length} device
                      {holding.length === 1 ? "" : "s"} in all.
                    </>
                  )}
                </p>
                <div className="flex gap-2 text-xs">
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 font-semibold text-[#006496] hover:bg-sky-50"
                    onClick={() => setDeviceChoice(null)}
                    data-view-safe
                    data-testid="push-delete-all-devices"
                  >
                    Every device ({holding.length})
                  </button>
                  <button
                    type="button"
                    className="rounded-lg px-2 py-1 font-semibold text-slate-500 hover:bg-slate-100"
                    onClick={() => setDeviceChoice([])}
                    data-view-safe
                  >
                    None
                  </button>
                </div>
                <ul className="divide-y rounded-xl border">
                  {holding.map(({ device, count }) => {
                    const at = single?.presence.find((x) => x.deviceId === device.id);
                    return (
                      <li key={device.id}>
                        <label
                          className="flex cursor-pointer items-start gap-3 px-3 py-2.5 hover:bg-slate-50"
                          data-testid={`push-delete-device-${device.id}`}
                        >
                          <Checkbox
                            className="mt-0.5"
                            checked={chosenDevices.includes(device.id)}
                            onCheckedChange={(c) => toggleDevice(device.id, c === true)}
                            aria-label={device.name}
                            data-view-safe
                          />
                          <span className="min-w-0 flex-1 space-y-0.5">
                            <span className="flex flex-wrap items-center justify-between gap-2">
                              <span className="truncate text-sm font-semibold text-slate-800">{device.name}</span>
                              <ConnectionChip device={device} />
                            </span>
                            <ViaTag device={device} className="flex" />
                            {at ? (
                              <span className="flex flex-wrap items-center gap-1.5 text-[11px] text-slate-600">
                                <span>holds “{at.name || "(no name)"}”</span>
                                <RolePill privilege={at.privilege} />
                                {at.card ? (
                                  <span className="inline-flex items-center gap-0.5">
                                    <CreditCard size={11} /> {at.card}
                                  </span>
                                ) : null}
                              </span>
                            ) : (
                              <span className="block text-[11px] text-slate-500">
                                holds {count} of the {picked.length}
                              </span>
                            )}
                          </span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setSelection(new Map())} data-view-safe>
                    Clear
                  </Button>
                  <span className="flex-1" />
                  <Button
                    size="sm"
                    className="gap-1.5 bg-red-600 text-white hover:bg-red-700"
                    onClick={() => setConfirming(true)}
                    disabled={chosenDevices.length === 0}
                    data-testid="push-delete-review"
                  >
                    <Trash2 size={13} /> Delete from {chosenDevices.length} device
                    {chosenDevices.length === 1 ? "" : "s"}…
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <UserHistory title="Deletions" kind="delete" testId="push-delete-history" />

      {confirming && (
        <DeleteDialog
          people={picked}
          devices={devices}
          deviceIds={chosenDevices}
          context="delete"
          onClose={() => setConfirming(false)}
          onOutcome={done}
        />
      )}
      <ResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </div>
  );
}
