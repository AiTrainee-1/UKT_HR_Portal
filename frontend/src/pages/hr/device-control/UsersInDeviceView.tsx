import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CreditCard, Equal, Layers, Plus, Search, ShieldAlert, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { CircleLoader } from "@/components/ui/CircleLoader";
import DataPagination from "@/components/ui/DataPagination";
import { Input } from "@/components/ui/input";
import {
  useDevicePeople,
  type DeviceControlDevice,
  type EmploymentType,
  type PeopleParams,
  type PersonRow,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatCard } from "../account-management/parts";
import AddToDevicesDialog from "./AddToDevicesDialog";
import MakeSameDialog from "./MakeSameDialog";
import { UserHistory, useDebounced } from "./PushParts";
import ResultDialog, { type ChangeOutcome } from "./ResultDialog";
import { EmploymentFilter } from "./SubTabs";
import {
  cellState,
  formatCount,
  isAdminRole,
  makeSamePlan,
  missingFrom,
  nameDiffersFromHrms,
  presenceVariants,
  shortDeviceName,
} from "./logic";

type Show = "all" | "differs" | "missing" | "multiple" | "device_only";

const SHOWS: { value: Show; label: string }[] = [
  { value: "all", label: "Everyone" },
  { value: "differs", label: "Details differ" },
  { value: "missing", label: "Missing from a column" },
  { value: "multiple", label: "On several devices" },
  { value: "device_only", label: "Not in the HRMS" },
];

/**
 * Data Push -> Users in Device (owner 2026-11-17): everyone against every device, with what each device holds for them
 * (name, role, card) side by side. A device holding something other than the rest is amber, one that lacks the person is
 * a dashed gap, and a name that is not the HRMS name is marked. "Make the same" and "Add to the missing" fix a row.
 */
export default function UsersInDeviceView({ devices }: { devices: DeviceControlDevice[] }) {
  const active = useMemo(() => devices.filter((d) => d.isActive), [devices]);
  const [columns, setColumns] = useState<number[]>(() => active.map((d) => d.id));
  const [kind, setKind] = useState<EmploymentType | "">("");
  const [show, setShow] = useState<Show>("all");
  const [query, setQuery] = useState("");
  const search = useDebounced(query.trim());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [dialog, setDialog] = useState<{ kind: "same" | "add"; person: PersonRow } | null>(null);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  useEffect(() => setPage(1), [search, kind, show, columns]);

  const shown = active.filter((d) => columns.includes(d.id));
  const params: PeopleParams = {
    search,
    employmentType: kind,
    devices: columns,
    deviceMode: show === "missing" ? "missing" : "any",
    differs: show === "differs",
    count: show === "multiple" ? "multiple" : "any",
    link: show === "device_only" ? "device_only" : show === "missing" ? "active" : "all",
    sort: "code",
    page,
    pageSize,
  };
  const people = useDevicePeople(params, columns.length > 0);
  const rows = people.data?.items ?? [];
  const facets = people.data?.facets;
  const toggleColumn = (id: number) =>
    setColumns((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  return (
    <div className="space-y-4" data-testid="push-users">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="People on the devices"
          value={formatCount(facets?.onDevices)}
          sub={`${formatCount(facets?.linked)} of them active employees`}
          icon={Users}
          tone="bg-slate-50 text-slate-700"
        />
        <StatCard
          label="On several devices"
          value={formatCount(facets?.multipleDevices)}
          sub="the same person on 2 or more"
          icon={Layers}
          tone="bg-sky-50 text-sky-800"
        />
        <StatCard
          label="Details differ"
          value={formatCount(facets?.differs)}
          sub="name, role or card not the same"
          icon={AlertTriangle}
          tone={facets?.differs ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-500"}
        />
        <StatCard
          label="Not in the HRMS"
          value={formatCount(facets?.deviceOnly)}
          sub="on a device, no employee"
          icon={ShieldAlert}
          tone={facets?.deviceOnly ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-500"}
        />
      </div>

      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-[14rem] flex-1">
              <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search by user ID, name, card or department"
                className="pl-8"
                data-testid="push-users-search"
              />
            </div>
            <EmploymentFilter value={kind} onChange={setKind} testId="push-users-kind" />
          </div>
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Who to show">
            {SHOWS.map((s) => (
              <button
                key={s.value}
                type="button"
                role="radio"
                aria-checked={show === s.value}
                onClick={() => setShow(s.value)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-semibold",
                  show === s.value ? "border-slate-900 bg-slate-900 text-white" : "bg-white text-slate-600",
                )}
                data-view-safe
                data-testid={`push-users-show-${s.value}`}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs font-semibold text-slate-500">Devices to compare:</span>
            {active.map((d) => {
              const on = columns.includes(d.id);
              return (
                <button
                  key={d.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleColumn(d.id)}
                  title={d.name}
                  className={cn(
                    "rounded-lg border px-2 py-1 text-[11px] font-bold",
                    on ? "border-[#006496] bg-[#006496] text-white" : "border-dashed text-slate-400",
                  )}
                  data-view-safe
                  data-testid={`push-users-col-${d.id}`}
                >
                  {shortDeviceName(d.name)}
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          {columns.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500">Choose at least one device to compare.</p>
          ) : people.isLoading ? (
            <CircleLoader texts={["UK Textiles", "Device Control", "Loading"]} />
          ) : rows.length === 0 ? (
            <p className="px-4 py-12 text-center text-sm text-slate-500" data-testid="push-users-empty">
              No one matches.
            </p>
          ) : (
            <div className="max-h-[70vh] overflow-auto">
              <table className="w-full border-separate border-spacing-0 text-sm" data-testid="push-users-table">
                <thead className="text-left text-xs text-slate-500">
                  <tr>
                    <th className="sticky left-0 top-0 z-20 min-w-[13rem] border-b bg-slate-50 px-4 py-2 font-semibold">
                      Person
                    </th>
                    {shown.map((d) => (
                      <th
                        key={d.id}
                        className="sticky top-0 z-10 min-w-[9rem] border-b bg-slate-50 px-2 py-2 font-semibold"
                        title={d.name}
                      >
                        {shortDeviceName(d.name)}
                        <span className="block text-[10px] font-normal text-slate-400">
                          {formatCount(facets?.perDevice[String(d.id)])} users
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const canSame = !p.restricted && (presenceVariants(p).length > 1 || !!makeSamePlan(p, "hrms"));
                    const gaps = p.employee && !p.restricted ? missingFrom(p, columns) : [];
                    return (
                      <tr key={p.userId} className="group" data-testid={`push-users-row-${p.userId}`}>
                        <td className="sticky left-0 z-10 border-b bg-white px-4 py-2 group-hover:bg-slate-50">
                          <span className="block truncate font-semibold text-slate-900">
                            {p.employee?.name ?? (p.name || "(no name)")}
                          </span>
                          <span className="block truncate text-[11px] text-slate-500">
                            <span className="font-mono">{p.userId}</span>
                            {p.employee
                              ? ` · ${p.employee.employmentType}${p.employee.status !== "active" ? " · Inactive" : ""}`
                              : p.restricted
                                ? " · another branch"
                                : " · not in the HRMS"}
                          </span>
                          {(canSame || gaps.length > 0) && (
                            <span className="mt-1 flex flex-wrap gap-1">
                              {canSame && (
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800 hover:bg-amber-100"
                                  onClick={() => setDialog({ kind: "same", person: p })}
                                  data-testid={`push-users-same-${p.userId}`}
                                >
                                  <Equal size={11} /> Make the same
                                </button>
                              )}
                              {gaps.length > 0 && (
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 rounded-md border border-sky-200 bg-sky-50 px-1.5 py-0.5 text-[11px] font-semibold text-[#006496] hover:bg-sky-100"
                                  onClick={() => setDialog({ kind: "add", person: p })}
                                  data-testid={`push-users-add-${p.userId}`}
                                >
                                  <Plus size={11} /> Add to {gaps.length}
                                </button>
                              )}
                            </span>
                          )}
                        </td>
                        {shown.map((d) => {
                          const state = cellState(p, d.id);
                          const at = p.presence.find((x) => x.deviceId === d.id);
                          const offHrms = at ? nameDiffersFromHrms(p, at.name) : false;
                          return (
                            <td key={d.id} className="border-b px-1.5 py-1.5 align-top" data-state={state}>
                              {at ? (
                                <div
                                  className={cn(
                                    "rounded-lg px-2 py-1",
                                    state === "differs" ? "bg-amber-50 ring-1 ring-amber-200" : "bg-slate-50",
                                  )}
                                  title={`${d.name}: ${at.name || "(no name)"} · ${at.role}${at.card ? ` · card ${at.card}` : ""}`}
                                  data-testid={`push-users-cell-${p.userId}-${d.id}`}
                                >
                                  <span
                                    className={cn(
                                      "block truncate text-xs font-semibold",
                                      state === "differs" ? "text-amber-900" : "text-slate-800",
                                    )}
                                  >
                                    {at.name || "(no name)"}
                                  </span>
                                  <span className="flex flex-wrap items-center gap-1 text-[10px] text-slate-500">
                                    {isAdminRole(at.privilege) && (
                                      <span className="font-bold text-violet-700">{at.role}</span>
                                    )}
                                    {at.card ? (
                                      <span className="inline-flex items-center gap-0.5">
                                        <CreditCard size={10} /> {at.card}
                                      </span>
                                    ) : null}
                                    {offHrms && <span className="text-amber-700">≠ HRMS name</span>}
                                  </span>
                                </div>
                              ) : (
                                <div
                                  className="rounded-lg border border-dashed border-slate-200 px-2 py-1.5 text-center text-[11px] text-slate-400"
                                  data-testid={`push-users-cell-${p.userId}-${d.id}`}
                                >
                                  not on it
                                </div>
                              )}
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {people.data && people.data.total > 0 && columns.length > 0 && (
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

      <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-500" data-testid="push-users-legend">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-5 rounded bg-slate-50 ring-1 ring-slate-200" /> holds the same as the others
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-5 rounded bg-amber-50 ring-1 ring-amber-200" /> holds something else
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-3 w-5 rounded border border-dashed border-slate-300" /> not on that device
        </span>
        <span>As the devices were last read (Overview → Read all devices).</span>
      </div>

      <UserHistory title="Made the same" contexts={["make_same"]} testId="push-users-history" />

      {dialog?.kind === "same" && (
        <MakeSameDialog
          person={dialog.person}
          devices={devices}
          onClose={() => setDialog(null)}
          onOutcome={setOutcome}
        />
      )}
      {dialog?.kind === "add" && (
        <AddToDevicesDialog
          people={[dialog.person]}
          devices={devices}
          context="copy"
          onClose={() => setDialog(null)}
          onOutcome={setOutcome}
        />
      )}
      <ResultDialog outcome={outcome} onClose={() => setOutcome(null)} />
    </div>
  );
}
