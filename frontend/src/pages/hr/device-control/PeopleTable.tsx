import { ArrowDown, ArrowUp, ChevronsUpDown, Edit2, Trash2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useIsMobile } from "@/hooks/use-mobile";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { DeviceControlDevice, PeopleParams, PersonRow } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { TONE_CLASSES } from "../device-status/logic";
import { TonePill } from "../device-status/parts";
import { DevicePresence, PersonAvatar, RolePill } from "./parts";
import { LINK_HINT, LINK_LABEL, LINK_TONE, describeDiffers } from "./logic";

type SortKey = NonNullable<PeopleParams["sort"]>;

function SortHead({
  label,
  column,
  sort,
  dir,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort === column;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      className={cn("text-[11px] font-bold uppercase tracking-wider text-[#006496]/60", className)}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-[#006496]",
          active && "text-[#006496]",
        )}
        data-testid={`push-sort-${column}`}
      >
        {label}
        <Icon size={12} className={active ? "" : "opacity-40"} />
      </button>
    </TableHead>
  );
}

type Handlers = {
  onEdit: (p: PersonRow) => void;
  onAddTo: (p: PersonRow) => void;
  onDelete: (p: PersonRow) => void;
  onPickDevice: (device: { id: number; name: string }, person: PersonRow) => void;
};

function HrmsCell({ p }: { p: PersonRow }) {
  const e = p.employee;
  return (
    <div className="min-w-0 space-y-0.5">
      <TonePill tone={LINK_TONE[p.link]}>{LINK_LABEL[p.link]}</TonePill>
      <p className="max-w-[14rem] truncate text-xs text-slate-500" title={LINK_HINT[p.link]}>
        {e
          ? [e.department, e.designation].filter(Boolean).join(" · ") ||
            (e.employmentType === "production" ? "Production" : "Staff")
          : LINK_HINT[p.link]}
      </p>
    </div>
  );
}

function PersonCell({ p }: { p: PersonRow }) {
  const e = p.employee;
  const differsText = describeDiffers(p.differs);
  const deviceName = p.presence.find((x) => x.name)?.name;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <PersonAvatar
        name={p.name || p.userId}
        photoUrl={e?.photoUrl}
        tone={p.link === "device_only" ? "bg-amber-50 text-amber-700" : "bg-blue-50 text-blue-700"}
      />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-x-1.5 font-semibold text-slate-900">
          <span className="truncate" data-testid={`push-name-${p.userId}`}>
            {p.name || "(no name)"}
          </span>
          {e && e.status !== "active" && <span className="text-[11px] font-medium text-red-500">Inactive</span>}
        </p>
        <p className="truncate text-xs text-slate-500">
          <span className="font-mono">{p.userId}</span>
          {e && deviceName && deviceName.toLowerCase() !== e.name.toLowerCase()
            ? ` · on device as “${deviceName}”`
            : ""}
        </p>
        {differsText && (
          <p className={cn("text-[11px] font-medium", TONE_CLASSES.warn.text)} data-testid={`push-differs-${p.userId}`}>
            {differsText} on devices
          </p>
        )}
      </div>
    </div>
  );
}

function RowActions({ p, h }: { p: PersonRow; h: Handlers }) {
  if (p.restricted) return <span className="text-xs text-slate-400">Another branch</span>;
  const onNone = p.presence.length === 0;
  return (
    <div className="flex items-center justify-end gap-0.5">
      {onNone ? (
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={() => h.onAddTo(p)}
          data-testid={`push-add-${p.userId}`}
        >
          <Upload size={13} /> Add to a device
        </Button>
      ) : (
        <>
          <Button
            variant="ghost"
            size="icon"
            title="Edit on the devices"
            aria-label={`Edit ${p.name || p.userId}`}
            onClick={() => h.onEdit(p)}
            data-testid={`push-edit-${p.userId}`}
          >
            <Edit2 size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Add to more devices"
            aria-label={`Add ${p.name || p.userId} to more devices`}
            onClick={() => h.onAddTo(p)}
            data-testid={`push-add-${p.userId}`}
          >
            <Upload size={15} />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            title="Delete from the devices"
            aria-label={`Delete ${p.name || p.userId}`}
            onClick={() => h.onDelete(p)}
            data-testid={`push-delete-${p.userId}`}
          >
            <Trash2 size={15} className="text-red-500" />
          </Button>
        </>
      )}
    </div>
  );
}

export default function PeopleTable({
  rows,
  devices,
  selected,
  onToggle,
  onToggleAll,
  sort,
  dir,
  onSort,
  handlers,
}: {
  rows: PersonRow[];
  devices: DeviceControlDevice[];
  selected: Set<string>;
  onToggle: (p: PersonRow, on: boolean) => void;
  onToggleAll: (on: boolean) => void;
  sort: SortKey;
  dir: "asc" | "desc";
  onSort: (key: SortKey) => void;
  handlers: Handlers;
}) {
  const selectable = rows.filter((r) => !r.restricted);
  const allOn = selectable.length > 0 && selectable.every((r) => selected.has(r.userId));
  const someOn = selectable.some((r) => selected.has(r.userId));
  const chips = devices.map((d) => ({ id: d.id, name: d.name }));
  const isMobile = useIsMobile();
  const pick = (p: PersonRow) => (d: { id: number; name: string }) => handlers.onPickDevice(d, p);

  if (!isMobile) {
    return (
      <div>
        <Table data-testid="push-table">
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <Checkbox
                  checked={allOn ? true : someOn ? "indeterminate" : false}
                  onCheckedChange={(c) => onToggleAll(c === true)}
                  aria-label="Select everyone on this page"
                  data-testid="push-select-all"
                />
              </TableHead>
              <SortHead label="Person" column="name" sort={sort} dir={dir} onSort={onSort} />
              <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">HRMS</TableHead>
              <SortHead label="On devices" column="devices" sort={sort} dir={dir} onSort={onSort} />
              <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">Role</TableHead>
              <TableHead className="text-right text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                Actions
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => (
              <TableRow
                key={p.userId}
                data-testid={`push-row-${p.userId}`}
                data-link={p.link}
                data-selected={selected.has(p.userId)}
              >
                <TableCell className="w-10">
                  <Checkbox
                    checked={selected.has(p.userId)}
                    disabled={p.restricted}
                    onCheckedChange={(c) => onToggle(p, c === true)}
                    aria-label={`Select ${p.name || p.userId}`}
                    data-testid={`push-select-${p.userId}`}
                  />
                </TableCell>
                <TableCell>
                  <PersonCell p={p} />
                </TableCell>
                <TableCell>
                  <HrmsCell p={p} />
                </TableCell>
                <TableCell>
                  {p.presence.length === 0 ? (
                    <span className="text-xs text-slate-400">on no device</span>
                  ) : (
                    <DevicePresence person={p} devices={chips} onPick={pick(p)} />
                  )}
                </TableCell>
                <TableCell>
                  <div className="space-y-1">
                    {[...new Map(p.presence.map((x) => [x.privilege, x])).values()].map((x) => (
                      <RolePill key={x.privilege} privilege={x.privilege} />
                    ))}
                    {p.presence.some((x) => x.card) && (
                      <p className="text-[11px] text-slate-500">card {p.presence.find((x) => x.card)?.card}</p>
                    )}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <RowActions p={p} h={handlers} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }

  // phones: a card for each person
  return (
    <div className="divide-y" data-testid="push-cards">
      {rows.map((p) => (
        <div key={p.userId} className="space-y-3 p-4" data-testid={`push-card-${p.userId}`}>
          <div className="flex items-start gap-3">
            <Checkbox
              className="mt-1"
              checked={selected.has(p.userId)}
              disabled={p.restricted}
              onCheckedChange={(c) => onToggle(p, c === true)}
              aria-label={`Select ${p.name || p.userId}`}
            />
            <div className="min-w-0 flex-1">
              <PersonCell p={p} />
            </div>
          </div>
          <HrmsCell p={p} />
          {p.presence.length > 0 && <DevicePresence person={p} devices={chips} onPick={pick(p)} />}
          <RowActions p={p} h={handlers} />
        </div>
      ))}
    </div>
  );
}
