import { Building2, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { DepartmentRow } from "./api";
import { plural } from "./logic";
import { BranchChip, Headcount, SplitBar } from "./parts";

type Props = {
  rows: DepartmentRow[];
  onOpen: (d: DepartmentRow) => void;
  onEdit: (d: DepartmentRow) => void;
  onDelete: (d: DepartmentRow) => void;
};

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

function Actions({ d, onEdit, onDelete }: { d: DepartmentRow } & Pick<Props, "onEdit" | "onDelete">) {
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        size="icon"
        title="Edit department"
        aria-label={`Edit ${d.name}`}
        onClick={() => onEdit(d)}
        data-testid={`dept-edit-${d.name}`}
      >
        <Pencil size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Delete department"
        aria-label={`Delete ${d.name}`}
        onClick={() => onDelete(d)}
        data-testid={`dept-delete-${d.name}`}
      >
        <Trash2 size={15} className="text-red-500" />
      </Button>
    </div>
  );
}

function Name({ d, onOpen }: { d: DepartmentRow; onOpen: (d: DepartmentRow) => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-cyan-500 text-white shadow-sm">
        <Building2 size={18} />
      </div>
      <div className="min-w-0">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(d);
          }}
          className="block max-w-full truncate text-left font-bold text-gray-900 hover:text-blue-700 hover:underline"
          data-testid={`dept-open-${d.name}`}
        >
          {d.name}
        </button>
        {d.description && <p className="max-w-[18rem] truncate text-xs text-gray-500">{d.description}</p>}
      </div>
    </div>
  );
}

/** The departments, as a table on wide screens and as cards on phones. */
export default function DepartmentList({ rows, onOpen, onEdit, onDelete }: Props) {
  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardContent className="p-0">
        <div className="hidden md:block">
          <Table data-testid="departments-table">
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD}>Department</TableHead>
                <TableHead className={HEAD}>Branch</TableHead>
                <TableHead className={cn(HEAD, "w-56")}>Staff / production</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Employees</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Designations</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow
                  key={d.id}
                  className="cursor-pointer"
                  onClick={() => onOpen(d)}
                  data-testid={`dept-row-${d.name}`}
                  data-staff={d.activeStaff}
                  data-production={d.activeProduction}
                  data-active={d.active}
                >
                  <TableCell>
                    <Name d={d} onOpen={onOpen} />
                  </TableCell>
                  <TableCell>
                    <BranchChip name={d.branchName} />
                  </TableCell>
                  <TableCell>
                    <SplitBar staff={d.activeStaff} production={d.activeProduction} />
                  </TableCell>
                  <TableCell className="text-right" data-testid={`dept-total-${d.name}`}>
                    <Headcount active={d.active} inactive={d.inactive} />
                  </TableCell>
                  <TableCell className="text-right text-sm text-gray-600">{d.designationCount}</TableCell>
                  <TableCell className="text-right">
                    <Actions d={d} onEdit={onEdit} onDelete={onDelete} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="divide-y md:hidden" data-testid="departments-cards">
          {rows.map((d) => (
            <div
              key={d.id}
              onClick={() => onOpen(d)}
              className="space-y-3 p-4 active:bg-gray-50"
              data-testid={`dept-card-${d.name}`}
            >
              <div className="flex items-start justify-between gap-2">
                <Name d={d} onOpen={onOpen} />
                <Actions d={d} onEdit={onEdit} onDelete={onDelete} />
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <BranchChip name={d.branchName} />
                <span className="text-xs text-gray-500">{plural(d.designationCount, "designation")}</span>
              </div>
              <SplitBar staff={d.activeStaff} production={d.activeProduction} />
              <p className="text-xs text-gray-500">
                <Headcount active={d.active} inactive={d.inactive} /> employees
              </p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
