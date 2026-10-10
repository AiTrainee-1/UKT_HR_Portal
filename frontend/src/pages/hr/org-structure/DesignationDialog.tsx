import { useMemo, useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useCreateDesignation } from "@/lib/api-client/custom-hooks";
import { errorMessage, useRefreshOrg, useUpdateDesignation, type DesignationRow, type TreeDepartment } from "./api";
import { LEVELS, NONE, levelInfo } from "./logic";

type Props = {
  /** The designation being edited; null to create one. */
  designation: DesignationRow | null;
  departments: TreeDepartment[];
  /** Every designation, to warn about a title that already exists in the chosen department. */
  designations: DesignationRow[];
  /** The department of the group "Add designation" was pressed in. */
  defaultDepartmentId?: number | null;
  /** A branch login must file a designation under one of its departments (the server refuses otherwise). */
  requireDepartment: boolean;
  onClose: () => void;
};

export default function DesignationDialog({
  designation,
  departments,
  designations,
  defaultDepartmentId,
  requireDepartment,
  onClose,
}: Props) {
  const { toast } = useToast();
  const refresh = useRefreshOrg();
  const createMutation = useCreateDesignation();
  const updateMutation = useUpdateDesignation();
  const editing = designation != null;
  const [title, setTitle] = useState(designation?.title ?? "");
  const [departmentId, setDepartmentId] = useState(
    designation
      ? designation.departmentId != null
        ? String(designation.departmentId)
        : NONE
      : defaultDepartmentId != null
        ? String(defaultDepartmentId)
        : NONE,
  );
  // "" is "not set". An old free-text level (or the "staff" the server used to store) stays selectable as it is.
  const [level, setLevel] = useState(
    designation ? (levelInfo(designation.level).key === "" ? "" : levelInfo(designation.level).key) : "",
  );
  const [error, setError] = useState<string | null>(null);
  const busy = createMutation.isPending || updateMutation.isPending;

  const grouped = useMemo(() => {
    const groups = new Map<string, TreeDepartment[]>();
    for (const d of departments)
      groups.set(d.branchName ?? "No branch", [...(groups.get(d.branchName ?? "No branch") ?? []), d]);
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [departments]);

  const levelKnown = LEVELS.some((l) => l.value === level);
  const clash =
    title.trim() !== "" &&
    designations.some(
      (d) =>
        d.id !== designation?.id &&
        (d.departmentId == null ? NONE : String(d.departmentId)) === departmentId &&
        d.title.trim().toLowerCase() === title.trim().toLowerCase(),
    );

  const submit = async () => {
    const trimmed = title.trim();
    if (!trimmed) return setError("Designation title is required");
    if (requireDepartment && departmentId === NONE)
      return setError("Select a department. A designation must belong to one.");
    setError(null);
    const dept = departmentId === NONE ? null : Number(departmentId);
    try {
      if (editing) {
        await updateMutation.mutateAsync({ id: designation.id, title: trimmed, departmentId: dept, level });
      } else {
        await createMutation.mutateAsync({ title: trimmed, departmentId: dept, level });
      }
    } catch (e) {
      const message = errorMessage(e) ?? "Please try again.";
      setError(message);
      toast({
        title: editing ? "Failed to update designation" : "Failed to create designation",
        description: message,
        variant: "destructive",
      });
      return;
    }
    await refresh();
    toast({ title: editing ? "Designation updated" : "Designation created" });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="designation-dialog">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${designation.title}` : "New designation"}</DialogTitle>
          <DialogDescription>
            A designation sits under a department, and the department under a branch.
            {editing && " Moving it to another department moves everyone who holds it."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="des-title">
              Title <span className="text-red-500">*</span>
            </Label>
            <Input
              id="des-title"
              placeholder="e.g. Senior Tailor"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              autoFocus
              data-testid="designation-title"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="des-dept">Department {requireDepartment && <span className="text-red-500">*</span>}</Label>
            <select
              id="des-dept"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              data-testid="designation-department"
            >
              <option value={NONE}>{requireDepartment ? "Select a department" : "No department (unassigned)"}</option>
              {grouped.map(([branch, list]) => (
                <optgroup key={branch} label={branch}>
                  {list.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="des-level">Level</Label>
            <select
              id="des-level"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              data-testid="designation-level"
            >
              <option value="">Not set</option>
              {LEVELS.map((l) => (
                <option key={l.value} value={l.value}>
                  {l.label}
                </option>
              ))}
              {level !== "" && !levelKnown && <option value={level}>{levelInfo(level).label} (current)</option>}
            </select>
          </div>
          {clash && (
            <p className="flex items-start gap-1.5 text-xs text-amber-700" data-testid="designation-clash">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />
              This department already has a designation with this title. You can still save it.
            </p>
          )}
          {error && (
            <p className="text-sm text-red-600" role="alert" data-testid="designation-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="designation-save">
            {busy ? "Saving…" : editing ? "Save changes" : "Create designation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
