import type { ReactNode } from "react";
import { Briefcase, Building2, ChevronDown, ChevronRight, FolderTree, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DesignationRow } from "./api";
import { plural, type BranchNode, type DeptNode } from "./logic";
import { Headcount, LevelChip, SplitBar } from "./parts";

type Handlers = {
  onOpen: (d: DesignationRow) => void;
  onEdit: (d: DesignationRow) => void;
  onDelete: (d: DesignationRow) => void;
  /** Add a designation; the department of the group it was pressed in (null for none). */
  onAdd: (departmentId: number | null) => void;
};

type Props = Handlers & {
  nodes: BranchNode[];
  /** Keys the person has closed. Everything is open unless listed. */
  collapsed: Set<string>;
  /** A search or filter is on: every group that has a match is shown open, whatever was closed. */
  forceOpen: boolean;
  onToggle: (key: string) => void;
};

function Toggle({
  open,
  onToggle,
  label,
  testId,
  children,
  className,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  testId: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`${open ? "Collapse" : "Expand"} ${label}`}
      data-testid={testId}
      className={cn("flex min-w-0 flex-1 items-center gap-3 text-left", className)}
    >
      {open ? (
        <ChevronDown size={16} className="shrink-0 text-gray-400" />
      ) : (
        <ChevronRight size={16} className="shrink-0 text-gray-400" />
      )}
      {children}
    </button>
  );
}

function DesignationRowView({ d, onOpen, onEdit, onDelete }: { d: DesignationRow } & Omit<Handlers, "onAdd">) {
  return (
    <div
      className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-3 py-2 hover:bg-gray-50"
      onClick={() => onOpen(d)}
      data-testid={`desig-row-${d.title}`}
      data-staff={d.activeStaff}
      data-production={d.activeProduction}
      data-active={d.active}
    >
      <div className="flex min-w-0 flex-1 basis-48 items-center gap-2.5">
        <Briefcase size={14} className="shrink-0 text-indigo-400" />
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onOpen(d);
          }}
          className="truncate text-left text-sm font-semibold text-gray-900 hover:text-blue-700 hover:underline"
          data-testid={`desig-open-${d.title}`}
        >
          {d.title}
        </button>
        <LevelChip level={d.level} />
      </div>
      <SplitBar staff={d.activeStaff} production={d.activeProduction} className="w-full sm:w-48" />
      <Headcount active={d.active} inactive={d.inactive} className="w-24 text-right text-sm" />
      <div className="flex items-center gap-0.5" onClick={(e) => e.stopPropagation()}>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Edit designation"
          aria-label={`Edit ${d.title}`}
          onClick={() => onEdit(d)}
          data-testid={`desig-edit-${d.title}`}
        >
          <Pencil size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          title="Delete designation"
          aria-label={`Delete ${d.title}`}
          onClick={() => onDelete(d)}
          data-testid={`desig-delete-${d.title}`}
        >
          <Trash2 size={14} className="text-red-500" />
        </Button>
      </div>
    </div>
  );
}

function DepartmentGroup({
  node,
  open,
  onToggle,
  filtered,
  ...handlers
}: { node: DeptNode; open: boolean; onToggle: () => void; filtered: boolean } & Handlers) {
  return (
    <div className="rounded-xl border bg-gray-50/50" data-testid={`dept-node-${node.name}`} data-open={open}>
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <Toggle open={open} onToggle={onToggle} label={node.name} testId={`toggle-dept-${node.name}`}>
          <Building2 size={15} className="shrink-0 text-blue-500" />
          <span className="truncate font-bold text-gray-800">{node.name}</span>
          <span className="hidden whitespace-nowrap text-xs text-gray-500 sm:inline">
            {plural(node.totals.designations, "designation")} ·{" "}
            <Headcount active={node.totals.active} inactive={node.totals.inactive} /> employees
          </span>
        </Toggle>
        <SplitBar
          staff={node.totals.activeStaff}
          production={node.totals.activeProduction}
          legend={false}
          className="hidden w-28 sm:block"
        />
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1 text-xs"
          onClick={() => handlers.onAdd(node.id)}
          aria-label={`Add designation to ${node.name}`}
          data-testid={`add-desig-${node.name}`}
        >
          <Plus size={13} /> Add
        </Button>
      </div>
      {open && (
        <div className="space-y-0.5 border-t px-1.5 py-1.5">
          {node.designations.length === 0 ? (
            <p className="px-3 py-3 text-sm text-gray-500" data-testid={`dept-empty-${node.name}`}>
              No designations in this department yet.
            </p>
          ) : (
            node.designations.map((d) => <DesignationRowView key={d.id} d={d} {...handlers} />)
          )}
          {!filtered && node.withoutDesignation > 0 && (
            <p className="px-3 pb-1 pt-2 text-xs text-amber-700" data-testid={`dept-without-${node.name}`}>
              {plural(node.withoutDesignation, "active employee")} in this department{" "}
              {node.withoutDesignation === 1 ? "has" : "have"} none of these designations.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/** Branch -> Department -> Designation, every level collapsible, with head-count and the staff / production split on each. */
export default function DesignationTree({ nodes, collapsed, forceOpen, onToggle, ...handlers }: Props) {
  const isOpen = (key: string) => forceOpen || !collapsed.has(key);
  return (
    <div className="space-y-3" data-testid="designation-tree">
      {nodes.map((b) => {
        const open = isOpen(b.key);
        const unassigned = b.kind === "unassigned";
        return (
          <Card
            key={b.key}
            className="overflow-hidden rounded-2xl"
            data-testid={`branch-node-${b.name}`}
            data-open={open}
          >
            <CardContent className="p-0">
              <div className="flex flex-wrap items-center gap-3 p-4">
                <Toggle open={open} onToggle={() => onToggle(b.key)} label={b.name} testId={`toggle-branch-${b.name}`}>
                  <div
                    className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white shadow-sm",
                      unassigned ? "bg-gray-400" : "bg-gradient-to-br from-indigo-500 to-violet-500",
                    )}
                  >
                    {unassigned ? <Briefcase size={18} /> : <FolderTree size={18} />}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-black text-gray-900">
                      {unassigned ? "Unassigned designations" : b.name}
                    </p>
                    <p className="text-xs text-gray-500">
                      {unassigned
                        ? `${plural(b.totals.designations, "designation")} with no department`
                        : `${plural(b.totals.departments, "department")} · ${plural(b.totals.designations, "designation")}`}
                      {" · "}
                      <Headcount active={b.totals.active} inactive={b.totals.inactive} /> employees
                    </p>
                  </div>
                </Toggle>
                <SplitBar
                  staff={b.totals.activeStaff}
                  production={b.totals.activeProduction}
                  className="hidden w-48 sm:block"
                />
                {unassigned && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-1 text-xs"
                    onClick={() => handlers.onAdd(null)}
                  >
                    <Plus size={13} /> Add
                  </Button>
                )}
              </div>

              {open && unassigned && (
                <div className="space-y-0.5 border-t px-1.5 py-1.5">
                  {b.designations.map((d) => (
                    <DesignationRowView key={d.id} d={d} {...handlers} />
                  ))}
                </div>
              )}
              {open && !unassigned && (
                <div className="space-y-2 border-t bg-white px-3 py-3">
                  {b.departments.length === 0 ? (
                    <p className="px-1 py-2 text-sm text-gray-500" data-testid={`branch-empty-${b.name}`}>
                      No departments in this branch yet.
                    </p>
                  ) : (
                    b.departments.map((dn) => (
                      <DepartmentGroup
                        key={dn.key}
                        node={dn}
                        open={isOpen(dn.key)}
                        onToggle={() => onToggle(dn.key)}
                        filtered={forceOpen}
                        {...handlers}
                      />
                    ))
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
