import { Briefcase, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { DesignationRow } from "./api";
import { BranchChip, Headcount, LevelChip, SplitBar } from "./parts";

type Props = {
  rows: DesignationRow[];
  onOpen: (d: DesignationRow) => void;
  onEdit: (d: DesignationRow) => void;
  onDelete: (d: DesignationRow) => void;
};

const HEAD = "text-[11px] font-bold uppercase tracking-wider text-[#006496]/60";

function Actions({ d, onEdit, onDelete }: { d: DesignationRow } & Pick<Props, "onEdit" | "onDelete">) {
  return (
    <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
      <Button
        variant="ghost"
        size="icon"
        title="Edit designation"
        aria-label={`Edit ${d.title}`}
        onClick={() => onEdit(d)}
        data-testid={`desig-edit-${d.title}`}
      >
        <Pencil size={15} />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        title="Delete designation"
        aria-label={`Delete ${d.title}`}
        onClick={() => onDelete(d)}
        data-testid={`desig-delete-${d.title}`}
      >
        <Trash2 size={15} className="text-red-500" />
      </Button>
    </div>
  );
}

function Title({ d, onOpen }: { d: DesignationRow; onOpen: (d: DesignationRow) => void }) {
  return (
    <div className="flex min-w-0 items-center gap-2.5">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-sm">
        <Briefcase size={16} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(d);
          }}
          className="truncate text-left font-bold text-gray-900 hover:text-blue-700 hover:underline"
          data-testid={`desig-open-${d.title}`}
        >
          {d.title}
        </button>
        <LevelChip level={d.level} />
      </div>
    </div>
  );
}

/** The designations as one flat, sortable list: a table on wide screens, cards on phones. */
export default function DesignationList({ rows, onOpen, onEdit, onDelete }: Props) {
  return (
    <Card className="overflow-hidden rounded-2xl">
      <CardContent className="p-0">
        <div className="hidden md:block">
          <Table data-testid="designations-table">
            <TableHeader>
              <TableRow>
                <TableHead className={HEAD}>Designation</TableHead>
                <TableHead className={HEAD}>Department</TableHead>
                <TableHead className={HEAD}>Branch</TableHead>
                <TableHead className={cn(HEAD, "w-52")}>Staff / production</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Employees</TableHead>
                <TableHead className={cn(HEAD, "text-right")}>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((d) => (
                <TableRow
                  key={d.id}
                  className="cursor-pointer"
                  onClick={() => onOpen(d)}
                  data-testid={`desig-row-${d.title}`}
                  data-staff={d.activeStaff}
                  data-production={d.activeProduction}
                  data-active={d.active}
                >
                  <TableCell>
                    <Title d={d} onOpen={onOpen} />
                  </TableCell>
                  <TableCell className="text-sm text-gray-700">
                    {d.departmentName ?? <span className="text-gray-400">Unassigned</span>}
                  </TableCell>
                  <TableCell>{d.departmentId != null ? <BranchChip name={d.branchName} /> : null}</TableCell>
                  <TableCell>
                    <SplitBar staff={d.activeStaff} production={d.activeProduction} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Headcount active={d.active} inactive={d.inactive} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Actions d={d} onEdit={onEdit} onDelete={onDelete} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="divide-y md:hidden" data-testid="designations-cards">
          {rows.map((d) => (
            <div
              key={d.id}
              onClick={() => onOpen(d)}
              className="space-y-3 p-4 active:bg-gray-50"
              data-testid={`desig-card-${d.title}`}
            >
              <div className="flex items-start justify-between gap-2">
                <Title d={d} onOpen={onOpen} />
                <Actions d={d} onEdit={onEdit} onDelete={onDelete} />
              </div>
              <p className="text-xs text-gray-500">
                {d.departmentName ?? "Unassigned"}
                {d.branchName ? ` · ${d.branchName}` : ""}
              </p>
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
