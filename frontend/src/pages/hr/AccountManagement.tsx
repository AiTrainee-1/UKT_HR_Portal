import React, { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { PillTabs } from "@/components/ui/pill-tabs";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListRoles, useCreateRole, useUpdateRole, useDeleteRole,
  useListHrUsers, useCreateHrUser, useUpdateHrUser, useDeleteHrUser,
  useListBranches,
  getListRolesQueryKey, getListHrUsersQueryKey,
  type Role, type HrUserItem, type PermissionLevel,
} from "@/lib/api-client/custom-hooks";
import { MODULE_TREE, MODULE_LABELS, resolvePermission } from "@/lib/permission-modules";
import {
  UserCog, Plus, Shield, Users, Trash2, Edit2, Eye, EyeOff,
  CheckCircle2, XCircle, Ban, CornerDownRight,
} from "lucide-react";

// ─── Role Dialog (create/edit — name, description, per-module access) ─────────

// Only top-level modules get an explicit default — submodules start unset so
// they visibly inherit their parent's level (see the "inherits from" hint
// below) until an admin deliberately overrides one.
function emptyPermissions(): Record<string, PermissionLevel> {
  return Object.fromEntries(MODULE_TREE.map((node) => [node.key, "hidden" as PermissionLevel]));
}

function ModuleRow({
  label, moduleKey, permissions, levels, onSetLevel, indent, inheritedFrom,
}: {
  label: string;
  moduleKey: string;
  permissions: Record<string, PermissionLevel>;
  levels: { value: PermissionLevel; label: string }[];
  onSetLevel: (key: string, level: PermissionLevel) => void;
  indent?: boolean;
  inheritedFrom?: string;
}) {
  // The effective (cascaded) level, so a submodule with no explicit override
  // visibly shows what it currently inherits from its parent.
  const effective = resolvePermission(permissions, moduleKey);
  return (
    <TableRow>
      <TableCell className="text-sm font-medium text-gray-700">
        <span className={`flex items-center gap-1.5 ${indent ? "pl-6" : ""}`}>
          {indent && <CornerDownRight size={12} className="text-gray-300 shrink-0" />}
          {label}
          {inheritedFrom && (
            <span className="text-[10px] font-normal text-gray-400">(inherits {inheritedFrom})</span>
          )}
        </span>
      </TableCell>
      {levels.map((lvl) => (
        <TableCell key={lvl.value} className="text-center">
          <button
            type="button"
            onClick={() => onSetLevel(moduleKey, lvl.value)}
            className={`w-5 h-5 rounded-full border-2 mx-auto flex items-center justify-center transition-colors ${
              effective === lvl.value
                ? "bg-blue-600 border-blue-600"
                : "bg-white border-gray-300 hover:border-blue-400"
            }`}
            aria-label={`${label} — ${lvl.label}`}
          >
            {effective === lvl.value && <CheckCircle2 size={11} className="text-white" />}
          </button>
        </TableCell>
      ))}
    </TableRow>
  );
}

function RoleDialog({ role, open, onClose }: { role: Role | null; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [permissions, setPermissions] = useState<Record<string, PermissionLevel>>(
    role?.permissions ?? emptyPermissions()
  );

  const createMutation = useCreateRole();
  const updateMutation = useUpdateRole();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSave = async () => {
    if (!name.trim()) {
      toast({ title: "Role name is required", variant: "destructive" });
      return;
    }
    try {
      if (role) {
        await updateMutation.mutateAsync({ id: role.id, data: { name, description, permissions } });
        toast({ title: "Role updated" });
      } else {
        await createMutation.mutateAsync({ name, description, permissions });
        toast({ title: "Role created" });
      }
      queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to save role", description: e?.message ?? "Unknown error", variant: "destructive" });
    }
  };

  const setLevel = (key: string, level: PermissionLevel) =>
    setPermissions((prev) => ({ ...prev, [key]: level }));

  const LEVELS: { value: PermissionLevel; label: string }[] = [
    { value: "hidden", label: "Hidden" },
    { value: "view", label: "View" },
    { value: "edit", label: "Editable" },
  ];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Shield size={16} className="text-blue-600" />
            {role ? `Edit Role — ${role.name}` : "Create Role"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="grid sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Role Name <span className="text-red-500">*</span></Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Director" disabled={role?.isSystem} />
            </div>
            <div className="space-y-1.5">
              <Label>Description <span className="text-gray-400 font-normal">(optional)</span></Label>
              <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Short note for other admins" />
            </div>
          </div>

          <div className="space-y-2">
            <Label>Module Access</Label>
            <p className="text-xs text-gray-400 -mt-1">
              A submodule with no explicit setting inherits its parent's level — set the parent, then
              override just the submodules that need to differ.
            </p>
            <div className="rounded-xl border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Module</TableHead>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center w-24">Hidden</TableHead>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center w-28">View Only</TableHead>
                    <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center w-28">Editable</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {MODULE_TREE.map((node) => (
                    <React.Fragment key={node.key}>
                      <ModuleRow
                        label={node.label}
                        moduleKey={node.key}
                        permissions={permissions}
                        levels={LEVELS}
                        onSetLevel={setLevel}
                      />
                      {(node.children ?? []).map((child) => (
                        <ModuleRow
                          key={child.key}
                          label={child.label}
                          moduleKey={child.key}
                          permissions={permissions}
                          levels={LEVELS}
                          onSetLevel={setLevel}
                          indent
                          inheritedFrom={permissions[child.key] === undefined ? node.label : undefined}
                        />
                      ))}
                    </React.Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : role ? "Save Changes" : "Create Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── HR User Dialog (create/edit — username, password, role) ──────────────────

function HrUserDialog({
  user, roles, open, onClose,
}: {
  user: HrUserItem | null;
  roles: Role[];
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [roleId, setRoleId] = useState<string>(user?.roleId ? String(user.roleId) : "");
  const [branchId, setBranchId] = useState<string>(user?.branchId ? String(user.branchId) : "");
  const { data: branches } = useListBranches();

  const createMutation = useCreateHrUser();
  const updateMutation = useUpdateHrUser();
  const isPending = createMutation.isPending || updateMutation.isPending;

  const handleSave = async () => {
    if (!username.trim()) {
      toast({ title: "Username is required", variant: "destructive" });
      return;
    }
    if (!user && !password) {
      toast({ title: "Password is required for a new account", variant: "destructive" });
      return;
    }
    try {
      if (user) {
        await updateMutation.mutateAsync({
          id: user.id,
          data: {
            fullName: fullName || undefined,
            email: email || undefined,
            roleId: roleId ? Number(roleId) : undefined,
            branchId: branchId ? Number(branchId) : null,
            ...(password ? { password } : {}),
          },
        });
        toast({ title: "Account updated" });
      } else {
        await createMutation.mutateAsync({
          username,
          password,
          fullName: fullName || undefined,
          email: email || undefined,
          roleId: roleId ? Number(roleId) : undefined,
          branchId: branchId ? Number(branchId) : undefined,
        });
        toast({ title: "Account created" });
      }
      queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
      onClose();
    } catch (e: any) {
      toast({ title: "Failed to save account", description: e?.message ?? "Unknown error", variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserCog size={16} className="text-blue-600" />
            {user ? `Edit Account — ${user.username}` : "Create Account"}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label>Username <span className="text-red-500">*</span></Label>
            <Input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. md, director1, ea.rahul"
              disabled={!!user}
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Full Name</Label>
              <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Managing Director" />
            </div>
            <div className="space-y-1.5">
              <Label>Email <span className="text-gray-400 font-normal">(optional)</span></Label>
              <Input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@uktextiles.in" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>{user ? "New Password" : "Password"} {!user && <span className="text-red-500">*</span>}</Label>
            <div className="relative">
              <Input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={user ? "Leave blank to keep current password" : "Set a login password"}
              />
              <button
                type="button"
                onClick={() => setShowPassword((s) => !s)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400"
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Profile / Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>{r.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-400">Access is determined entirely by the selected role's module permissions.</p>
          </div>
          <div className="space-y-1.5">
            <Label>Branch</Label>
            <Select value={branchId || "__all__"} onValueChange={(v) => setBranchId(v === "__all__" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All branches (unscoped)</SelectItem>
                {branches?.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>{b.name}{b.isHeadOffice ? " (Head Office)" : ""}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-400">Leave as "All branches" for a company-wide role (MD, Director, HR Admin). Assign one branch to scope this account to only that branch's data.</p>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={isPending}>
            {isPending ? "Saving…" : user ? "Save Changes" : "Create Account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function AccountManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: hrUsers, isLoading: usersLoading } = useListHrUsers();
  const { data: roles, isLoading: rolesLoading } = useListRoles();

  const [userDialog, setUserDialog] = useState<{ open: boolean; user: HrUserItem | null }>({ open: false, user: null });
  const [roleDialog, setRoleDialog] = useState<{ open: boolean; role: Role | null }>({ open: false, role: null });
  const [acctTab, setAcctTab] = useState("accounts");

  const updateUserMutation = useUpdateHrUser();
  const deleteUserMutation = useDeleteHrUser();
  const deleteRoleMutation = useDeleteRole();

  const toggleActive = async (u: HrUserItem) => {
    try {
      await updateUserMutation.mutateAsync({ id: u.id, data: { isActive: !u.isActive } });
      queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
      toast({ title: u.isActive ? "Account disabled" : "Account enabled" });
    } catch (e: any) {
      toast({ title: "Failed to update account", description: e?.message, variant: "destructive" });
    }
  };

  const handleDeleteUser = async (u: HrUserItem) => {
    if (u.isSuperAdmin) return;
    if (!confirm(`Delete account "${u.username}"? This cannot be undone.`)) return;
    try {
      await deleteUserMutation.mutateAsync(u.id);
      queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
      toast({ title: "Account deleted" });
    } catch (e: any) {
      toast({ title: "Failed to delete account", description: e?.message, variant: "destructive" });
    }
  };

  const handleDeleteRole = async (r: Role) => {
    if (r.isSystem) return;
    if (!confirm(`Delete role "${r.name}"? Accounts using it will lose their role assignment.`)) return;
    try {
      await deleteRoleMutation.mutateAsync(r.id);
      queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
      toast({ title: "Role deleted" });
    } catch (e: any) {
      toast({ title: "Failed to delete role", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900 flex items-center gap-2">
              <UserCog className="text-blue-600" size={22} />
              Account Management
            </h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Admin only — create HR-portal logins and control what each one can see and edit.
            </p>
          </div>
        </div>

        <Tabs value={acctTab} onValueChange={setAcctTab}>
          <PillTabs
            items={[
              { value: "accounts", label: "Accounts", icon: <Users size={14} /> },
              { value: "roles", label: "Roles & Permissions", icon: <Shield size={14} /> },
            ]}
            value={acctTab}
            onChange={setAcctTab}
          />

          {/* ── Accounts Tab ── */}
          <TabsContent value="accounts" className="space-y-3 pt-3">
            <div className="flex justify-end">
              <Button onClick={() => setUserDialog({ open: true, user: null })} className="gap-1.5">
                <Plus size={15} /> Create Account
              </Button>
            </div>
            <Card className="rounded-2xl overflow-hidden">
              <CardContent className="p-0">
                {usersLoading ? (
                  <div className="p-4 space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Username</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Full Name</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Role</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Branch</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Status</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Last Login</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(hrUsers ?? []).map((u) => (
                        <TableRow key={u.id}>
                          <TableCell className="font-medium">
                            {u.username}
                            {u.isSuperAdmin && (
                              <Badge className="ml-2 text-[10px] bg-blue-50 text-blue-600 border-blue-200">Admin</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-sm text-gray-500">{u.fullName || "—"}</TableCell>
                          <TableCell className="text-sm text-gray-500">{u.roleName || "—"}</TableCell>
                          <TableCell className="text-sm text-gray-500">
                            {u.branchName ? (
                              <Badge variant="outline" className="text-[10px] text-teal-700 border-teal-200 bg-teal-50">{u.branchName}</Badge>
                            ) : (
                              <span className="text-xs text-gray-400">All branches</span>
                            )}
                          </TableCell>
                          <TableCell>
                            {u.isActive ? (
                              <Badge className="text-xs bg-green-50 text-green-600 border-green-200 gap-1"><CheckCircle2 size={11} /> Active</Badge>
                            ) : (
                              <Badge className="text-xs bg-red-50 text-red-600 border-red-200 gap-1"><XCircle size={11} /> Disabled</Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-gray-400">
                            {u.lastLogin ? new Date(u.lastLogin).toLocaleString() : "Never"}
                          </TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button variant="ghost" size="icon" onClick={() => setUserDialog({ open: true, user: u })} title="Edit">
                                <Edit2 size={14} />
                              </Button>
                              {!u.isSuperAdmin && (
                                <>
                                  <Button variant="ghost" size="icon" onClick={() => toggleActive(u)} title={u.isActive ? "Disable" : "Enable"}>
                                    {u.isActive ? <Ban size={14} className="text-orange-500" /> : <CheckCircle2 size={14} className="text-green-600" />}
                                  </Button>
                                  <Button variant="ghost" size="icon" onClick={() => handleDeleteUser(u)} title="Delete">
                                    <Trash2 size={14} className="text-red-500" />
                                  </Button>
                                </>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          {/* ── Roles Tab ── */}
          <TabsContent value="roles" className="space-y-3 pt-3">
            <div className="flex justify-end">
              <Button onClick={() => setRoleDialog({ open: true, role: null })} className="gap-1.5">
                <Plus size={15} /> Create Role
              </Button>
            </div>
            <Card className="rounded-2xl overflow-hidden">
              <CardContent className="p-0">
                {rolesLoading ? (
                  <div className="p-4 space-y-2">
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </div>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Role</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50">Description</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-center">Editable Modules</TableHead>
                        <TableHead className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/50 text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(roles ?? []).map((r) => {
                        const editCount = Object.values(r.permissions ?? {}).filter((v) => v === "edit").length;
                        return (
                          <TableRow key={r.id}>
                            <TableCell className="font-medium">
                              {r.name}
                              {r.isSystem && (
                                <Badge className="ml-2 text-[10px] bg-gray-100 text-gray-500 border-gray-200">System</Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-sm text-gray-500">{r.description || "—"}</TableCell>
                            <TableCell className="text-sm text-gray-500 text-center">{editCount} / {MODULE_LABELS.length}</TableCell>
                            <TableCell className="text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button variant="ghost" size="icon" onClick={() => setRoleDialog({ open: true, role: r })} title="Edit">
                                  <Edit2 size={14} />
                                </Button>
                                {!r.isSystem && (
                                  <Button variant="ghost" size="icon" onClick={() => handleDeleteRole(r)} title="Delete">
                                    <Trash2 size={14} className="text-red-500" />
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {userDialog.open && (
          <HrUserDialog
            user={userDialog.user}
            roles={roles ?? []}
            open={userDialog.open}
            onClose={() => setUserDialog({ open: false, user: null })}
          />
        )}
        {roleDialog.open && (
          <RoleDialog
            role={roleDialog.role}
            open={roleDialog.open}
            onClose={() => setRoleDialog({ open: false, role: null })}
          />
        )}
      </div>
    </HrLayout>
  );
}
