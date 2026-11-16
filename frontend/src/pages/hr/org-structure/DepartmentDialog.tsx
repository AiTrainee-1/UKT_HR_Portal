import { useState } from "react";
import { Lock } from "lucide-react";
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
import { useCreateDepartmentWithBranch } from "@/lib/api-client/custom-hooks";
import { ORG_CATEGORY_LABEL, orgCategoryOf, type OrgCategory } from "@/lib/departments";
import { errorMessage, useRefreshOrg, useUpdateDepartment, type BranchRef, type DepartmentRow } from "./api";
import { departmentCategoryLock } from "./logic";
import { KindPicker } from "./KindPicker";

type Props = {
  /** The department being edited; null to create one. */
  department: DepartmentRow | null;
  branches: BranchRef[];
  /** An unscoped login must choose the branch; a branch login's own branch is implied by the server. */
  needsBranch: boolean;
  /** A branch login's own branch (where a department it creates goes), for the duplicate-name check. */
  scopedBranchId?: number | null;
  /** Every department (both kinds), so a clash is caught before the server has to say so. */
  existing: DepartmentRow[];
  /** The branch the filter is on, offered first when creating. */
  defaultBranchId?: number | null;
  /** The kind the page's switch is on: a new department starts as it. */
  category: OrgCategory;
  onClose: () => void;
};

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export default function DepartmentDialog({
  department,
  branches,
  needsBranch,
  scopedBranchId,
  existing,
  defaultBranchId,
  category: pageCategory,
  onClose,
}: Props) {
  const { toast } = useToast();
  const refresh = useRefreshOrg();
  const createMutation = useCreateDepartmentWithBranch();
  const updateMutation = useUpdateDepartment();
  const editing = department != null;
  const [name, setName] = useState(department?.name ?? "");
  const [description, setDescription] = useState(department?.description ?? "");
  const [branchId, setBranchId] = useState(
    department?.branchId != null ? String(department.branchId) : defaultBranchId != null ? String(defaultBranchId) : "",
  );
  const [category, setCategory] = useState<OrgCategory>(editing ? orgCategoryOf(department) : pageCategory);
  const [error, setError] = useState<string | null>(null);
  const busy = createMutation.isPending || updateMutation.isPending;
  // An edited department keeps its kind while anybody is in it (the server says the same).
  const lock = editing ? departmentCategoryLock(department) : null;

  const submit = async () => {
    const trimmed = name.trim().replace(/\s+/g, " ");
    if (!trimmed) return setError("Department name is required");
    if (!editing && needsBranch && !branchId) {
      return setError("Select a branch. A department with no branch is hidden from every branch login.");
    }
    // The branch the department is (or will be) in: its own, the one picked, or a branch login's own.
    const inBranch = editing
      ? department.branchId
      : needsBranch
        ? branchId
          ? Number(branchId)
          : null
        : scopedBranchId;
    if (
      existing.some(
        (d) =>
          d.id !== department?.id &&
          (d.branchId ?? null) === (inBranch ?? null) &&
          orgCategoryOf(d) === category &&
          sameName(d.name, trimmed),
      )
    ) {
      return setError(`A ${ORG_CATEGORY_LABEL[category]} department called "${trimmed}" already exists in this branch`);
    }
    setError(null);
    try {
      if (editing) {
        await updateMutation.mutateAsync({
          id: department.id,
          name: trimmed,
          description: description.trim(),
          ...(category !== orgCategoryOf(department) ? { category } : {}),
        });
      } else {
        await createMutation.mutateAsync({
          name: trimmed,
          description: description.trim() || undefined,
          branchId: branchId ? Number(branchId) : undefined,
          category,
        });
      }
    } catch (e) {
      const message = errorMessage(e) ?? "Please try again.";
      setError(message);
      toast({
        title: editing ? "Failed to update department" : "Failed to create department",
        description: message,
        variant: "destructive",
      });
      return;
    }
    await refresh();
    toast({
      title: editing ? "Department updated" : `${ORG_CATEGORY_LABEL[category]} department created`,
    });
    onClose();
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md" data-testid="department-dialog">
        <DialogHeader>
          <DialogTitle>
            {editing ? `Edit ${department.name}` : `New ${ORG_CATEGORY_LABEL[category]} department`}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? "Rename it or change the description. A department stays in its branch."
              : "A department belongs to one branch and is for staff or for production employees; its name only has to be unique within that branch and type."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>
              Type <span className="text-red-500">*</span>
            </Label>
            <KindPicker value={category} onChange={setCategory} disabled={!!lock} testId="department-category" />
            {lock ? (
              <p className="flex items-start gap-1.5 text-xs text-gray-500" data-testid="department-category-lock">
                <Lock size={12} className="mt-0.5 shrink-0" />
                {lock}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Only {category === "production" ? "production employees" : "staff"} can be put in it.
                {editing &&
                  department.designationCount > 0 &&
                  category !== orgCategoryOf(department) &&
                  " Its designations switch with it."}
              </p>
            )}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dept-name">
              Name <span className="text-red-500">*</span>
            </Label>
            <Input
              id="dept-name"
              placeholder={category === "production" ? "e.g. Cutting" : "e.g. Accounts"}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
              autoFocus
              data-testid="department-name"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dept-desc">Description</Label>
            <Input
              id="dept-desc"
              placeholder="Optional description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              data-testid="department-description"
            />
          </div>
          {editing ? (
            <p className="text-xs text-muted-foreground">
              Branch: <b>{department.branchName ?? "none"}</b>
            </p>
          ) : (
            needsBranch && (
              <div className="space-y-1.5">
                <Label htmlFor="dept-branch">
                  Branch <span className="text-red-500">*</span>
                </Label>
                <select
                  id="dept-branch"
                  value={branchId}
                  onChange={(e) => setBranchId(e.target.value)}
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  data-testid="department-branch"
                >
                  <option value="">Select a branch</option>
                  {branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                    </option>
                  ))}
                </select>
              </div>
            )
          )}
          {error && (
            <p className="text-sm text-red-600" role="alert" data-testid="department-error">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="department-save">
            {busy ? "Saving…" : editing ? "Save changes" : "Create department"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
