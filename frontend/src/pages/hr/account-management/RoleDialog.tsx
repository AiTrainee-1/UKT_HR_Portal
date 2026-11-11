import { useRef, useState } from "react";
import { Shield } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { getListRolesQueryKey, useCreateRole, useUpdateRole, type Role } from "@/lib/api-client/custom-hooks";
import { approvalCount, isLocked, legacyApprovals, type Approvals, type RoleCategory } from "@/lib/hr-access";
import { RoleApprovalsEditor } from "./ApprovalsEditor";
import PermissionEditor from "./PermissionEditor";
import { emptyPermissions, permissionsEqual, type Permissions } from "./logic";

const sameApprovals = (a: Approvals | null, b: Approvals | null) =>
  a === b || (a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b));

/** A role made for HR Managers / Assistants always has its approvals set separately; for an HR Assistant role the locked
 *  ones are switched off. A role for any account keeps what it had (the old rule, or its own switches). */
function approvalsFor(category: RoleCategory, approvals: Approvals | null, permissions: Permissions): Approvals | null {
  if (!category) return approvals;
  const base = approvals ?? legacyApprovals(permissions, category);
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, v && !isLocked(category, k)]));
}

type Props = {
  role: Role | null;
  /** Every role, to refuse a name that is taken and to offer "copy from". */
  roles: Role[];
  /** How many accounts have this role (editing only). */
  usedBy: number;
  open: boolean;
  onClose: () => void;
};

/** Create or edit a role: its name, a note, and what it can see and edit. */
export default function RoleDialog({ role, roles, usedBy, open, onClose }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<Permissions>(() => ({ ...(role?.permissions ?? emptyPermissions()) }));
  const [category, setCategory] = useState<RoleCategory>(role?.category ?? "");
  const [approvals, setApprovals] = useState<Approvals | null>(role?.approvals ?? null);
  const [section, setSection] = useState<"pages" | "approvals">("pages");
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);
  const [discardAsk, setDiscardAsk] = useState(false);
  const initial = useRef({
    name: role?.name ?? "",
    description: role?.description ?? "",
    permissions: role?.permissions ?? emptyPermissions(),
    category: role?.category ?? "",
    approvals: role?.approvals ?? null,
  });

  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const dirty =
    name !== initial.current.name ||
    description !== initial.current.description ||
    !permissionsEqual(permissions, initial.current.permissions) ||
    category !== initial.current.category ||
    !sameApprovals(approvals, initial.current.approvals);
  const taken = roles.some((r) => r.id !== role?.id && r.name.trim().toLowerCase() === name.trim().toLowerCase());
  const nameProblem = name.trim() && taken ? "Another role already has this name." : null;

  /** Closing with unsaved work asks first: the module list is long and easy to lose by a stray click. */
  const requestClose = () => (dirty ? setDiscardAsk(true) : onClose());

  const handleSave = async () => {
    if (!name.trim()) {
      toast({ title: "Role name is required", variant: "destructive" });
      return;
    }
    if (taken) {
      toast({ title: "Another role already has this name", variant: "destructive" });
      return;
    }
    try {
      if (role) {
        await updateMutation.mutateAsync({
          id: role.id,
          data: { name: name.trim(), description, permissions, category, approvals },
        });
        toast({ title: "Role updated" });
      } else {
        await createMutation.mutateAsync({ name: name.trim(), description, permissions, category, approvals });
        toast({ title: "Role created" });
      }
      queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
      onClose();
    } catch (e: unknown) {
      toast({
        title: "Failed to save role",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && requestClose()}>
        <DialogContent
          className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-3xl grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-4 sm:p-6"
          data-testid="role-dialog"
        >
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <span className="rounded-lg bg-blue-50 p-1.5 text-blue-600">
                <Shield size={16} />
              </span>
              {role ? `Edit role: ${role.name}` : "Create role"}
            </DialogTitle>
            <DialogDescription>
              {role && usedBy > 0
                ? `${usedBy} ${usedBy === 1 ? "account has" : "accounts have"} this role. Changes apply to ${usedBy === 1 ? "it" : "them"} the next time the portal loads.`
                : "A role decides which parts of the portal an account can see and edit."}
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 min-w-0 space-y-4 overflow-y-auto pr-1">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="role-name">
                  Role name <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="role-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="e.g. Director"
                  disabled={role?.isSystem}
                  aria-invalid={!!nameProblem}
                  data-testid="role-name"
                />
                {nameProblem && (
                  <p className="text-xs text-red-600" data-testid="role-name-error">
                    {nameProblem}
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="role-description">
                  Description <span className="font-normal text-gray-400">(optional)</span>
                </Label>
                <Input
                  id="role-description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Short note for other admins"
                  data-testid="role-description"
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Made for</Label>
              <Select
                value={category || "any"}
                onValueChange={(v) => {
                  const next = (v === "any" ? "" : v) as RoleCategory;
                  setCategory(next);
                  setApprovals((a) => approvalsFor(next, a, permissions));
                }}
              >
                <SelectTrigger className="sm:w-80" data-testid="role-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any account</SelectItem>
                  <SelectItem value="hr_manager">HR Managers only</SelectItem>
                  <SelectItem value="hr_assistant">HR Assistants only</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">
                {category === "hr_assistant"
                  ? "Only HR Assistant accounts can have this role. Missing punches and attendance edits stay locked off."
                  : category === "hr_manager"
                    ? "Only HR Manager accounts can have this role."
                    : "Admin, HR Manager and HR Assistant accounts can all have this role."}
              </p>
            </div>

            {copiedFrom && (
              <p
                className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-xs text-blue-800"
                data-testid="copied-note"
              >
                Permissions copied from <b>{copiedFrom}</b>. Nothing is saved until you press Save.
              </p>
            )}

            <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <PillTabs
                size="sm"
                items={[
                  { value: "pages", label: "Pages & actions" },
                  {
                    value: "approvals",
                    label: approvals === null ? "Approvals · follow Edit" : `Approvals · ${approvalCount(approvals)}`,
                  },
                ]}
                value={section}
                onChange={(v) => setSection(v as "pages" | "approvals")}
              />
            </div>

            {section === "pages" ? (
              <PermissionEditor
                permissions={permissions}
                onChange={setPermissions}
                otherRoles={roles.filter((r) => r.id !== role?.id)}
                onCopied={(from) => setCopiedFrom(from.name)}
              />
            ) : (
              <RoleApprovalsEditor
                approvals={approvals}
                permissions={permissions}
                category={category}
                onChange={setApprovals}
              />
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={requestClose}>
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={isPending || !name.trim() || taken} data-testid="role-save">
              {isPending ? "Saving…" : role ? "Save changes" : "Create role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={discardAsk} onOpenChange={setDiscardAsk}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This role has changes that have not been saved. They will be lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="discard-keep">Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={onClose} data-testid="discard-confirm">
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
