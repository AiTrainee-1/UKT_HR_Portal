import { useEffect, useMemo, useState } from "react";
import { ArrowRightLeft, Copy, CreditCard, Loader2, Pencil, RefreshCw, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { CircleLoader } from "@/components/ui/CircleLoader";
import DataPagination from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useDevicePeople,
  useRefreshDeviceUsers,
  type DeviceControlDevice,
  type EmploymentType,
  type PersonLink,
  type PersonRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { relativeTime } from "../device-status/logic";
import AddToDevicesDialog from "./AddToDevicesDialog";
import MoveDialog from "./MoveDialog";
import { PersonAvatar, RolePill } from "./parts";
import { DeviceTargets, UserHistory, ViaTag, useDebounced } from "./PushParts";
import ResultDialog, { type ChangeOutcome } from "./ResultDialog";
import { EmploymentFilter } from "./SubTabs";
import UserDialog from "./UserDialog";
import { nameDiffersFromHrms, shortDeviceName } from "./logic";

const MAX_PEOPLE = 200;

const LINKS: { value: "all" | PersonLink; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "linked", label: "In the HRMS" },
  { value: "device_only", label: "Not in the HRMS" },
  { value: "inactive_on_device", label: "Inactive in the HRMS" },
];

type Dialog =
  | { kind: "edit"; person: PersonRow }
  | { kind: "copy"; people: PersonRow[] }
  | { kind: "move"; people: PersonRow[] }
  | null;

/**
 * Data Push -> Edit Users (owner 2026-11-17): pick a device, see the users it holds (as last read) and who they are in
 * the HRMS, then change one (on this device, or on every device that has them), copy people to more devices, or move
 * them to another device. Each change shows every device's result and is kept in the history below.
 */
export default function EditUsersView({ devices }: { devices: DeviceControlDevice[] }) {
  const { toast } = useToast();
  const active = devices.filter((d) => d.isActive);
  const [deviceId, setDeviceId] = useState<number | null>(active[0]?.id ?? null);
  const device = devices.find((d) => d.id === deviceId) ?? null;
  const [kind, setKind] = useState<EmploymentType | "">("");
  const [link, setLink] = useState<"all" | PersonLink>("all");
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [selection, setSelection] = useState<Map<string, PersonRow>>(new Map());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const refresh = useRefreshDeviceUsers();
  useEffect(() => {
    setPage(1);
    setSelection(new Map());
  }, [search, kind, link, deviceId]);

  const people = useDevicePeople(
    {
      search,
      link,
      devices: deviceId ? [deviceId] : [],
      deviceMode: "any",
      employmentType: kind,
      sort: "code",
      page,
      pageSize,
    },
    deviceId != null,
  );
  const rows = useMemo(() => people.data?.items ?? [], [people.data]);
  const picked = [...selection.values()];
  const selectable = rows.filter((r) => !r.restricted);
  const allOnPage = selectable.length > 0 && selectable.every((r) => selection.has(r.userId));

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
  const togglePage = (on: boolean) =>
    setSelection((prev) => {
      const next = new Map(prev);
      for (const r of selectable) {
        if (on && next.size < MAX_PEOPLE) next.set(r.userId, r);
        if (!on) next.delete(r.userId);
      }
      return next;
    });
  const done = (o: ChangeOutcome) => {
    setSelection(new Map());
    setOutcome(o);
  };

  const readAgain = async () => {
    if (!device) return;
    try {
      const res = await refresh.mutateAsync([device.id]);
      const r = res.results[0];
      toast(
        r?.ok
          ? { title: `Read ${r.deviceName}`, description: `${(r.count ?? 0).toLocaleString("en-IN")} user records.` }
          : { title: `Could not read ${device.name}`, description: r?.error, variant: "destructive" },
      );
    } catch (e) {
      toast({
        title: `Could not read ${device.name}`,
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-4" data-testid="push-edit">
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4">
          <div>
            <h3 className="text-sm font-bold text-slate-800">1. Device</h3>
            <p className="text-xs text-slate-500">
              Its users as the device was last read. Changing someone needs the device to be reachable.
            </p>
          </div>
          <DeviceTargets
            devices={devices}
            chosen={deviceId ? [deviceId] : []}
            onChange={(ids) => setDeviceId(ids[0] ?? null)}
            single
            canPick={(d) => d.isActive}
            counts={people.data?.facets.perDevice}
            testId="push-edit-device"
          />
        </CardContent>
      </Card>

      {device && (
        <Card className="overflow-hidden rounded-2xl">
          <CardContent className="p-0">
            <div className="space-y-3 border-b p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-bold text-slate-800">2. Users on {device.name}</h3>
                  <p className="flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
                    <ViaTag device={device} />
                    <span>
                      {device.usersRead.at ? `read ${relativeTime(device.usersRead.at)}` : "never read"}
                      {people.data ? ` · ${people.data.total.toLocaleString("en-IN")} shown` : ""}
                    </span>
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={readAgain}
                  disabled={refresh.isPending}
                  data-testid="push-edit-read"
                >
                  {refresh.isPending ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
                  Read {shortDeviceName(device.name)} again
                </Button>
              </div>
              {refresh.isPending && refresh.waiting && <p className="text-xs text-slate-500">{refresh.waiting}</p>}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative min-w-[14rem] flex-1">
                  <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search by user ID, name, card or department"
                    className="pl-8"
                    data-testid="push-edit-search"
                  />
                </div>
                <EmploymentFilter value={kind} onChange={setKind} testId="push-edit-kind" />
                <div className="inline-flex gap-0.5 rounded-xl bg-slate-100 p-1" role="group" aria-label="In the HRMS">
                  {LINKS.map((l) => (
                    <button
                      key={l.value}
                      type="button"
                      aria-pressed={link === l.value}
                      onClick={() => setLink(l.value)}
                      className={cn(
                        "h-8 rounded-lg px-2.5 text-xs font-semibold",
                        link === l.value
                          ? "bg-white text-slate-900 shadow-sm ring-1 ring-slate-200"
                          : "text-slate-500 hover:text-slate-900",
                      )}
                      data-view-safe
                      data-testid={`push-edit-link-${l.value}`}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {people.isLoading ? (
              <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />
            ) : rows.length === 0 ? (
              <p className="px-4 py-12 text-center text-sm text-slate-500" data-testid="push-edit-empty">
                {device.usersRead.at ? "No user on this device matches." : "This device has not been read yet."}
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm" data-testid="push-edit-table">
                  <thead className="bg-slate-50 text-left text-xs text-slate-500">
                    <tr>
                      <th className="w-10 px-4 py-2">
                        <Checkbox
                          checked={allOnPage}
                          onCheckedChange={(c) => togglePage(c === true)}
                          aria-label="Choose everyone on this page"
                        />
                      </th>
                      <th className="px-2 py-2 font-semibold">User ID</th>
                      <th className="px-2 py-2 font-semibold">Name on this device</th>
                      <th className="px-2 py-2 font-semibold">In the HRMS</th>
                      <th className="px-2 py-2 font-semibold">Role</th>
                      <th className="px-2 py-2 font-semibold">Also on</th>
                      <th className="px-2 py-2 text-right font-semibold">Change</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {rows.map((p) => {
                      const here = p.presence.find((x) => x.deviceId === device.id);
                      const elsewhere = p.presence.filter((x) => x.deviceId !== device.id);
                      const on = selection.has(p.userId);
                      return (
                        <tr key={p.userId} className={cn(on && "bg-sky-50")} data-testid={`push-edit-row-${p.userId}`}>
                          <td className="px-4 py-2">
                            <Checkbox
                              checked={on}
                              disabled={p.restricted}
                              onCheckedChange={(c) => toggle(p, c === true)}
                              aria-label={`Choose ${p.userId}`}
                            />
                          </td>
                          <td className="px-2 py-2 font-mono text-xs text-slate-700">{p.userId}</td>
                          <td className="px-2 py-2">
                            <span className="block font-semibold text-slate-900">{here?.name || "(no name)"}</span>
                            <span className="flex flex-wrap gap-1.5 text-[11px] text-slate-500">
                              {here?.card ? (
                                <span className="inline-flex items-center gap-0.5">
                                  <CreditCard size={11} /> {here.card}
                                </span>
                              ) : null}
                              {here && nameDiffersFromHrms(p, here.name) && (
                                <span className="text-amber-700">not the HRMS name</span>
                              )}
                              {p.differs.length > 0 && <span className="text-amber-700">differs between devices</span>}
                            </span>
                          </td>
                          <td className="px-2 py-2">
                            {p.employee ? (
                              <span className="flex items-center gap-2">
                                <PersonAvatar name={p.employee.name} photoUrl={p.employee.photoUrl} size={26} />
                                <span className="min-w-0">
                                  <span className="block truncate text-xs font-semibold text-slate-800">
                                    {p.employee.name}
                                  </span>
                                  <span className="block truncate text-[11px] capitalize text-slate-500">
                                    {p.employee.employmentType}
                                    {p.employee.department ? ` · ${p.employee.department}` : ""}
                                    {p.employee.status !== "active" ? " · Inactive" : ""}
                                  </span>
                                </span>
                              </span>
                            ) : (
                              <span className="text-xs text-amber-700">
                                {p.restricted ? "another branch" : "no employee"}
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2">{here && <RolePill privilege={here.privilege} />}</td>
                          <td className="px-2 py-2 text-xs text-slate-500">
                            {elsewhere.length === 0
                              ? "only here"
                              : elsewhere
                                  .map((x) => shortDeviceName(devices.find((d) => d.id === x.deviceId)?.name ?? ""))
                                  .join(", ")}
                          </td>
                          <td className="px-2 py-2">
                            <span className="flex justify-end gap-1">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 gap-1 px-2 text-xs"
                                onClick={() => setDialog({ kind: "edit", person: p })}
                                disabled={p.restricted}
                                data-testid={`push-edit-edit-${p.userId}`}
                              >
                                <Pencil size={12} /> Edit
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 gap-1 px-2 text-xs"
                                onClick={() => setDialog({ kind: "copy", people: [p] })}
                                disabled={p.restricted}
                                data-testid={`push-edit-copy-${p.userId}`}
                              >
                                <Copy size={12} /> Copy
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 gap-1 px-2 text-xs"
                                onClick={() => setDialog({ kind: "move", people: [p] })}
                                disabled={p.restricted}
                                data-testid={`push-edit-move-${p.userId}`}
                              >
                                <ArrowRightLeft size={12} /> Move
                              </Button>
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
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
      )}

      {picked.length > 0 && device && (
        <div
          className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-2xl border border-sky-200 bg-white p-3 shadow-lg"
          data-testid="push-edit-bar"
        >
          <span className="flex items-center gap-1.5 px-1 text-sm font-semibold text-slate-800">
            <Users size={14} /> {picked.length} chosen
          </span>
          <span className="flex-1" />
          <Button size="sm" variant="ghost" onClick={() => setSelection(new Map())} data-view-safe>
            Clear
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={() => setDialog({ kind: "copy", people: picked })}
            data-testid="push-edit-bulk-copy"
          >
            <Copy size={13} /> Copy to more devices…
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            onClick={() => setDialog({ kind: "move", people: picked })}
            data-testid="push-edit-bulk-move"
          >
            <ArrowRightLeft size={13} /> Move to another device…
          </Button>
        </div>
      )}

      <UserHistory
        title="Edits, copies and moves"
        contexts={["edit", "copy", "transfer", "make_same"]}
        testId="push-edit-history"
      />

      {dialog?.kind === "edit" && device && (
        <UserDialog
          key={`edit-${dialog.person.userId}-${device.id}`}
          mode="edit"
          open
          onClose={() => setDialog(null)}
          devices={devices}
          person={dialog.person}
          deviceId={device.id}
          context="edit"
          onOutcome={done}
        />
      )}
      {dialog?.kind === "copy" && (
        <AddToDevicesDialog
          people={dialog.people}
          devices={devices}
          context="copy"
          onClose={() => setDialog(null)}
          onOutcome={done}
        />
      )}
      {dialog?.kind === "move" && device && (
        <MoveDialog
          people={dialog.people}
          source={device}
          devices={devices}
          onClose={() => setDialog(null)}
          onOutcome={done}
        />
      )}
      <ResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </div>
  );
}
