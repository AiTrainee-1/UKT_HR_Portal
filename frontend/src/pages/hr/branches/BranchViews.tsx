import type { KeyboardEvent, MouseEvent } from "react";
import { Building2, Factory, Briefcase, MapPin, Navigation, Pencil, Phone, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { Branch } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip } from "../account-management/parts";
import type { BranchSummaryRow } from "./api";
import { hasGeofence, headcount } from "./logic";

type Handlers = {
  onOpen: (b: Branch) => void;
  onEdit: (b: Branch) => void;
  onDelete: (b: Branch) => void;
  busyId?: number | null;
};

export function GeofenceChip({ branch }: { branch: Branch }) {
  const set = hasGeofence(branch);
  return (
    <span className="inline-flex" data-testid="geo-chip" data-geofence={set ? "set" : "unset"}>
      {set ? (
        <Chip className="border-teal-200 bg-teal-50 text-teal-700">
          <Navigation size={10} /> Geofence set ({branch.geofenceRadiusM ?? 200}m)
        </Chip>
      ) : (
        <Chip className="border-amber-200 bg-amber-50 text-amber-700">
          <Navigation size={10} /> No location set
        </Chip>
      )}
    </span>
  );
}

export function HeadOfficeChip() {
  return (
    <Chip className="border-amber-200 bg-amber-50 text-amber-700">
      <Building2 size={10} /> Head Office
    </Chip>
  );
}

export function CodeChip({ code }: { code?: string | null }) {
  return code ? (
    <span className="rounded bg-teal-50 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-teal-700">{code}</span>
  ) : null;
}

/** Staff and production headcount of a branch, or a dash while the figures are not there. */
export function PeopleFigures({ row }: { row?: BranchSummaryRow }) {
  if (!row) return <span className="text-xs text-gray-400">-</span>;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
      <span className="inline-flex items-center gap-1" title="Active staff">
        <Briefcase size={12} className="text-blue-500" /> <b className="text-gray-900">{row.staffActive}</b> staff
      </span>
      <span className="inline-flex items-center gap-1" title="Active production workers">
        <Factory size={12} className="text-orange-500" /> <b className="text-gray-900">{row.productionActive}</b>{" "}
        production
      </span>
    </div>
  );
}

// A row or card opens the detail drawer; its own buttons must not.
const stop = (e: MouseEvent | KeyboardEvent) => e.stopPropagation();

function Actions({ branch, onEdit, onDelete, busyId }: { branch: Branch } & Omit<Handlers, "onOpen">) {
  return (
    <div className="flex shrink-0 items-center gap-0.5" onClick={stop} onKeyDown={stop}>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:bg-teal-50 hover:text-teal-700"
        onClick={() => onEdit(branch)}
        title="Edit"
        aria-label={`Edit ${branch.name}`}
        data-testid={`branch-edit-${branch.id}`}
      >
        <Pencil size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8 text-muted-foreground hover:bg-red-50 hover:text-red-600"
        disabled={busyId === branch.id}
        onClick={() => onDelete(branch)}
        title="Delete"
        aria-label={`Delete ${branch.name}`}
        data-testid={`branch-delete-${branch.id}`}
      >
        <Trash2 size={15} />
      </Button>
    </div>
  );
}

const openOnKey = (open: () => void) => (e: KeyboardEvent) => {
  if (e.target !== e.currentTarget) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    open();
  }
};

/** One branch as a card: the grid on wide screens and the only layout on a phone. */
export function BranchCard({ branch, row, onOpen, ...actions }: { branch: Branch; row?: BranchSummaryRow } & Handlers) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${branch.name}: open details`}
      onClick={() => onOpen(branch)}
      onKeyDown={openOnKey(() => onOpen(branch))}
      className="group flex cursor-pointer flex-col gap-3 rounded-2xl border bg-white p-4 shadow-sm outline-none transition-shadow hover:shadow-md focus-visible:ring-2 focus-visible:ring-teal-500"
      data-testid={`branch-card-${branch.id}`}
      data-branch-name={branch.name}
    >
      <div className="flex items-start gap-3">
        <div
          className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl"
          style={{ background: "linear-gradient(135deg, #0f766e, #06b6d4)" }}
        >
          <MapPin size={18} className="text-white" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="font-bold text-gray-900">{branch.name}</p>
            <CodeChip code={branch.code} />
          </div>
          {branch.location && <p className="text-sm text-muted-foreground">{branch.location}</p>}
        </div>
        <Actions branch={branch} {...actions} />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {branch.isHeadOffice && <HeadOfficeChip />}
        <GeofenceChip branch={branch} />
      </div>

      {(branch.address || branch.phone) && (
        <div className="space-y-1">
          {branch.address && <p className="line-clamp-2 text-sm text-muted-foreground">{branch.address}</p>}
          {branch.phone && (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Phone size={11} /> {branch.phone}
            </span>
          )}
        </div>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 border-t pt-3">
        <PeopleFigures row={row} />
        {row && (
          <span className="shrink-0 text-xs text-gray-500" data-testid="branch-departments">
            {row.departments.length} {row.departments.length === 1 ? "department" : "departments"}
          </span>
        )}
      </div>
    </div>
  );
}

/** The same branches as a table (wide screens, when the list view is chosen). */
export function BranchTable({
  branches,
  figures,
  onOpen,
  ...actions
}: { branches: Branch[]; figures: Map<number, BranchSummaryRow> } & Handlers) {
  const head = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";
  return (
    <div className="overflow-hidden rounded-2xl border bg-white shadow-sm" data-testid="branches-table">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className={head}>Branch</TableHead>
            <TableHead className={head}>Location</TableHead>
            <TableHead className={head}>People</TableHead>
            <TableHead className={cn(head, "text-right")}>Departments</TableHead>
            <TableHead className={head}>Attendance location</TableHead>
            <TableHead className={head}>Phone</TableHead>
            <TableHead className={cn(head, "text-right")}>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {branches.map((b) => {
            const row = figures.get(b.id);
            return (
              <TableRow
                key={b.id}
                tabIndex={0}
                onClick={() => onOpen(b)}
                onKeyDown={openOnKey(() => onOpen(b))}
                className="cursor-pointer outline-none focus-visible:bg-teal-50/40"
                data-testid={`branch-row-${b.id}`}
                data-branch-name={b.name}
              >
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold text-gray-900">{b.name}</span>
                    <CodeChip code={b.code} />
                    {b.isHeadOffice && <HeadOfficeChip />}
                  </div>
                </TableCell>
                <TableCell className="max-w-[14rem] truncate text-sm text-gray-600" title={b.address ?? undefined}>
                  {b.location || <span className="text-gray-300">-</span>}
                </TableCell>
                <TableCell>
                  <PeopleFigures row={row} />
                </TableCell>
                <TableCell className="text-right text-sm tabular-nums">{row ? row.departments.length : "-"}</TableCell>
                <TableCell>
                  <GeofenceChip branch={b} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm text-gray-600">
                  {b.phone || <span className="text-gray-300">-</span>}
                </TableCell>
                <TableCell className="text-right">
                  <Actions branch={b} {...actions} />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** Total of active people (staff plus production) shown next to a branch name in the drawer and the delete warning. */
export const peopleLabel = (row: BranchSummaryRow | undefined) => {
  const n = headcount(row);
  return `${n} active ${n === 1 ? "employee" : "employees"}`;
};
