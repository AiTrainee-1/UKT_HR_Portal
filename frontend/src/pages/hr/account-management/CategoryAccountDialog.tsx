import { useMemo, useState } from "react";
import { Briefcase, ClipboardList, Eye, EyeOff, Lock, RotateCcw } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  getListHrUsersQueryKey,
  useCreateHrUser,
  useListBranches,
  useUpdateHrUser,
  type HrUserItem,
  type Role,
} from "@/lib/api-client/custom-hooks";
import {
  APPROVAL_KINDS,
  ASSISTANT_LOCKED,
  CATEGORY_LABEL,
  applyModuleOverrides,
  cleanOverrides,
  effectiveApprovals,
  legacyApprovals,
  type Overrides,
} from "@/lib/hr-access";
import AccountAccessEditor from "./AccountAccessEditor";
import { AccountApprovalsEditor } from "./ApprovalsEditor";
import { CATEGORY_PURPOSE, defaultRoleFor, rolesFor, type StaffCategory } from "./logic";
import { Chip } from "./parts";

const NO_ROLE = "__none__";
const ALL_BRANCHES = "__all__";

type Props = {
  category: StaffCategory;
  user: HrUserItem | null;
  roles: Role[];
  open: boolean;
  onClose: () => void;
};

/** Create or edit an HR Manager / HR Assistant: the login, its role, and this person's own changes on top of the role. */
export default function CategoryAccountDialog({ category, user, roles, open, onClose }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: branches } = useListBranches();
  const fitting = useMemo(() => rolesFor(roles, category), [roles, category]);
  const starter = defaultRoleFor(roles, category);

  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [roleId, setRoleId] = useState<string>(
    user ? (user.roleId ? String(user.roleId) : NO_ROLE) : starter ? String(starter.id) : NO_ROLE,
  );
  const [branchId, setBranchId] = useState<string>(user?.branchId ? String(user.branchId) : ALL_BRANCHES);
  const [isActive, setIsActive] = useState<boolean>(user ? user.isActive : true);
  const [overrides, setOverrides] = useState<Overrides>(() => ({
    modules: { ...(user?.permissionOverrides?.modules ?? {}) },
    approvals: { ...(user?.permissionOverrides?.approvals ?? {}) },
  }));
  const [section, setSection] = useState<"pages" | "approvals">("pages");

  const createMutation = useCreateHrUser();
  const updateMutation = useUpdateHrUser();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const role = roles.find((r) => String(r.id) === roleId);
  const rolePermissions = useMemo(() => role?.permissions ?? {}, [role]);
  const permissions = useMemo(
    () => applyModuleOverrides(rolePermissions, overrides.modules),
    [rolePermissions, overrides.modules],
  );
  // what the role alone would let this person approve (a role on the old rule: edit on the module)
  const roleApprovals = role?.approvals ?? legacyApprovals(permissions);
  const effective = effectiveApprovals({
    rolePermissions,
    roleApprovals: role?.approvals ?? null,
    overrides,
    category,
  });
  const allowed = APPROVAL_KINDS.filter((k) => effective[k.key]);
  const moduleChanges = Object.keys(overrides.modules ?? {}).length;
  const approvalChanges = Object.keys(overrides.approvals ?? {}).length;
  const label = CATEGORY_LABEL[category];
  const Icon = category === "hr_manager" ? Briefcase : ClipboardList;

  const handleSave = async () => {
    if (!username.trim()) {
      toast({ title: "Username is required", variant: "destructive" });
      return;
    }
    if (!user && !password) {
      toast({ title: "Password is required for a new account", variant: "destructive" });
      return;
    }
    const permissionOverrides = cleanOverrides(overrides, category);
    try {
      if (user) {
        await updateMutation.mutateAsync({
          id: user.id,
          data: {
            fullName: fullName || undefined,
            email: email || undefined,
            roleId: roleId === NO_ROLE ? null : Number(roleId),
            branchId: branchId === ALL_BRANCHES ? null : Number(branchId),
            isActive,
            permissionOverrides,
            ...(password ? { password } : {}),
          },
        });
        toast({ title: `${label} updated` });
      } else {
        await createMutation.mutateAsync({
          username: username.trim(),
          password,
          fullName: fullName || undefined,
          email: email || undefined,
          roleId: roleId === NO_ROLE ? undefined : Number(roleId),
          branchId: branchId === ALL_BRANCHES ? undefined : Number(branchId),
          category,
          permissionOverrides,
        });
        toast({ title: `${label} account created` });
      }
      queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
      onClose();
    } catch (e: unknown) {
      toast({
        title: "Failed to save account",
        description: e instanceof Error ? e.message : "Unknown error",
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-3xl grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] gap-3 p-4 sm:p-6"
        data-testid="category-account-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={
                category === "hr_manager"
                  ? "rounded-lg bg-teal-50 p-1.5 text-teal-700"
                  : "rounded-lg bg-violet-50 p-1.5 text-violet-700"
              }
            >
              <Icon size={16} />
            </span>
            {user ? `Edit ${label}: ${user.username}` : `Create ${label}`}
          </DialogTitle>
          <DialogDescription>{CATEGORY_PURPOSE[category]}</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 min-w-0 space-y-5 overflow-y-auto pr-1">
          {/* ── the login ── */}
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="cat-username">
                Username <span className="text-red-500">*</span>
              </Label>
              <Input
                id="cat-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. hr.priya"
                disabled={!!user}
                data-testid="cat-username"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-password">
                {user ? "New password" : "Password"} {!user && <span className="text-red-500">*</span>}
              </Label>
              <div className="relative">
                <Input
                  id="cat-password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={user ? "Leave blank to keep the current one" : "Set a login password"}
                  autoComplete="new-password"
                  data-testid="cat-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((s) => !s)}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-700"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-fullname">Full name</Label>
              <Input
                id="cat-fullname"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Priya Raman"
                data-testid="cat-fullname"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cat-email">
                Email <span className="font-normal text-gray-400">(optional)</span>
              </Label>
              <Input
                id="cat-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@uktextiles.in"
                data-testid="cat-email"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Role</Label>
              <Select value={roleId} onValueChange={setRoleId}>
                <SelectTrigger data-testid="cat-role">
                  <SelectValue placeholder="Select a role" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_ROLE}>No role (opens nothing)</SelectItem>
                  {fitting.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                      {r.category ? "" : " (any account)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">
                {role
                  ? `${role.description || "What this login sees, edits and approves starts from this role."}`
                  : "With no role the account can't open any module (until you give it some below)."}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label>Branch</Label>
              <Select value={branchId} onValueChange={setBranchId}>
                <SelectTrigger data-testid="cat-branch">
                  <SelectValue placeholder="All branches" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_BRANCHES}>All branches (company-wide)</SelectItem>
                  {branches?.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>
                      {b.name}
                      {b.isHeadOffice ? " (Head Office)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-gray-500">
                {category === "hr_manager"
                  ? "A manager limited to one branch approves and reviews only that branch's requests and assistants."
                  : "Pick one branch to limit this login to that branch's data."}
              </p>
            </div>
          </div>

          {user && (
            <label
              className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border bg-gray-50/60 p-3"
              htmlFor="cat-active"
            >
              <span>
                <span className="block text-sm font-semibold text-gray-900">Can sign in</span>
                <span className="block text-xs text-gray-500">
                  Switch off to stop this login at once (the account and its history are kept).
                </span>
              </span>
              <Switch
                id="cat-active"
                checked={isActive}
                onCheckedChange={setIsActive}
                aria-label="Enable or disable this login"
                data-testid="cat-active"
              />
            </label>
          )}

          {/* ── this person's access ── */}
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-bold text-gray-900">Access for this person</p>
                <p className="text-xs text-gray-500">
                  Everything follows the role. Change a page or an approval here to make it different for this person
                  only.
                </p>
              </div>
              {moduleChanges + approvalChanges > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setOverrides({ modules: {}, approvals: {} })}
                  data-testid="cat-reset-all"
                >
                  <RotateCcw size={13} /> Reset all to the role
                </Button>
              )}
            </div>
            <div className="-mx-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <PillTabs
                size="sm"
                items={[
                  {
                    value: "pages",
                    label: moduleChanges ? `Pages & actions · ${moduleChanges} custom` : "Pages & actions",
                  },
                  {
                    value: "approvals",
                    label: approvalChanges ? `Approvals · ${approvalChanges} custom` : "Approvals",
                  },
                ]}
                value={section}
                onChange={(v) => setSection(v as "pages" | "approvals")}
              />
            </div>
            {section === "pages" ? (
              <AccountAccessEditor
                rolePermissions={rolePermissions}
                modules={overrides.modules ?? {}}
                onChange={(modules) => setOverrides((o) => ({ ...o, modules }))}
              />
            ) : (
              <AccountApprovalsEditor
                roleApprovals={roleApprovals}
                permissions={permissions}
                overrides={overrides.approvals ?? {}}
                category={category}
                onChange={(approvals) => setOverrides((o) => ({ ...o, approvals }))}
              />
            )}
            <div className="rounded-xl border bg-white p-3 text-xs text-gray-600" data-testid="cat-can-approve">
              <p className="mb-1.5 font-semibold text-gray-900">
                {allowed.length ? `Can approve (${allowed.length})` : "Can't approve any requests"}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {allowed.map((k) => (
                  <Chip key={k.key} className="border-emerald-200 bg-emerald-50 text-emerald-800">
                    {k.label}
                  </Chip>
                ))}
                {category === "hr_assistant" &&
                  Object.keys(ASSISTANT_LOCKED).map((k) => (
                    <Chip key={k} className="border-gray-200 bg-gray-50 text-gray-500">
                      <Lock size={10} /> {APPROVAL_KINDS.find((x) => x.key === k)?.label}: never
                    </Chip>
                  ))}
              </div>
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending} data-testid="cat-save">
            {isPending ? "Saving…" : user ? "Save changes" : `Create ${label}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
