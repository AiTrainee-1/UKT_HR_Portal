import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  useListRoles, useCreateRole, useUpdateRole, useDeleteRole, getListRolesQueryKey,
  useListHrUsers, useCreateHrUser, useUpdateHrUser, useDeleteHrUser, getListHrUsersQueryKey,
  useListDepartments,
  Role, HrUserItem,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  Shield, Plus, Trash2, Users, Lock, Edit2, Check, X,
  KeyRound, ToggleLeft, ToggleRight, AlertTriangle,
} from "lucide-react";

// ─── constants ────────────────────────────────────────────────────────────────

const MODULES = [
  { key: "employees",       label: "Employees" },
  { key: "payroll",         label: "Payroll" },
  { key: "attendance",      label: "Attendance" },
  { key: "leave",           label: "Leave & Holiday" },
  { key: "reports",         label: "Reports" },
  { key: "settings",        label: "Settings" },
  { key: "user_management", label: "User Management" },
  { key: "shifts",          label: "Shift Management" },
  { key: "settlement",      label: "Settlement" },
];
const PERMS = ["view", "create", "edit", "delete", "approve"] as const;
type Perm = typeof PERMS[number];

function emptyPerms(): Record<string, Record<Perm, boolean>> {
  return Object.fromEntries(
    MODULES.map((m) => [m.key, Object.fromEntries(PERMS.map((p) => [p, false]))])
  ) as Record<string, Record<Perm, boolean>>;
}

// ─── PermissionMatrix ─────────────────────────────────────────────────────────

function PermissionMatrix({
  perms,
  onChange,
  readOnly = false,
}: {
  perms: Record<string, Record<string, boolean>>;
  onChange?: (updated: Record<string, Record<string, boolean>>) => void;
  readOnly?: boolean;
}) {
  const toggle = (mod: string, perm: string) => {
    if (readOnly || !onChange) return;
    const next = JSON.parse(JSON.stringify(perms));
    if (!next[mod]) next[mod] = {};
    next[mod][perm] = !next[mod][perm];
    // if enabling anything, also enable "view"
    if (next[mod][perm] && perm !== "view") next[mod]["view"] = true;
    onChange(next);
  };

  const toggleRow = (mod: string, all: boolean) => {
    if (readOnly || !onChange) return;
    const next = JSON.parse(JSON.stringify(perms));
    if (!next[mod]) next[mod] = {};
    PERMS.forEach((p) => { next[mod][p] = all; });
    onChange(next);
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-gray-100">
      <table className="w-full text-xs">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            <th className="text-left py-2.5 pl-4 pr-3 font-semibold text-gray-500 uppercase tracking-wide min-w-[140px]">
              Module
            </th>
            {PERMS.map((p) => (
              <th key={p} className="text-center py-2.5 px-3 font-semibold text-gray-500 uppercase tracking-wide capitalize w-16">
                {p}
              </th>
            ))}
            {!readOnly && (
              <th className="text-center py-2.5 px-2 font-semibold text-gray-500 uppercase tracking-wide w-14">All</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {MODULES.map((mod, i) => {
            const modPerms = (perms ?? {})[mod.key] ?? {};
            const allOn = PERMS.every((p) => modPerms[p]);
            return (
              <tr key={mod.key} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/40"}>
                <td className="py-2.5 pl-4 pr-3 font-medium text-gray-700">{mod.label}</td>
                {PERMS.map((p) => (
                  <td key={p} className="text-center py-2.5 px-3">
                    {readOnly ? (
                      modPerms[p] ? (
                        <Check size={13} className="text-emerald-500 mx-auto" />
                      ) : (
                        <div className="w-3 h-3 rounded border border-gray-200 mx-auto" />
                      )
                    ) : (
                      <button
                        onClick={() => toggle(mod.key, p)}
                        className={`w-5 h-5 rounded border-2 mx-auto flex items-center justify-center transition-colors ${
                          modPerms[p]
                            ? "bg-blue-600 border-blue-600"
                            : "bg-white border-gray-300 hover:border-blue-400"
                        }`}
                      >
                        {modPerms[p] && <Check size={11} className="text-white" />}
                      </button>
                    )}
                  </td>
                ))}
                {!readOnly && (
                  <td className="text-center py-2.5 px-2">
                    <button
                      onClick={() => toggleRow(mod.key, !allOn)}
                      className="text-gray-400 hover:text-blue-600 transition-colors mx-auto block"
                      title={allOn ? "Clear all" : "Grant all"}
                    >
                      {allOn
                        ? <ToggleRight size={16} className="text-blue-500" />
                        : <ToggleLeft size={16} />
                      }
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────────────────

export default function UserManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // ── Users ──────────────────────────────────────────────────────────────────
  const [showUserDialog, setShowUserDialog] = useState(false);
  const [editUser, setEditUser] = useState<HrUserItem | null>(null);
  const [deleteUser, setDeleteUser] = useState<HrUserItem | null>(null);
  const [userForm, setUserForm] = useState({
    username: "", fullName: "", email: "", password: "", roleId: "", departmentId: "",
  });

  // ── Roles ──────────────────────────────────────────────────────────────────
  const [showRoleDialog, setShowRoleDialog] = useState(false);
  const [editRole, setEditRole] = useState<Role | null>(null);
  const [editRolePerms, setEditRolePerms] = useState<Record<string, Record<string, boolean>>>(emptyPerms());
  const [deleteRole, setDeleteRoleConfirm] = useState<Role | null>(null);
  const [roleForm, setRoleForm] = useState({ name: "", description: "" });

  // ── Data ───────────────────────────────────────────────────────────────────
  const { data: roles = [], isLoading: rolesLoading } = useListRoles();
  const { data: users = [], isLoading: usersLoading } = useListHrUsers();
  const { data: departments = [] } = useListDepartments();

  const createUserMutation   = useCreateHrUser();
  const updateUserMutation   = useUpdateHrUser();
  const deleteUserMutation   = useDeleteHrUser();
  const createRoleMutation   = useCreateRole();
  const updateRoleMutation   = useUpdateRole();
  const deleteRoleMutation   = useDeleteRole();

  const refreshUsers = () => queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
  const refreshRoles = () => queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });

  // ── User actions ───────────────────────────────────────────────────────────
  const openCreateUser = () => {
    setUserForm({ username: "", fullName: "", email: "", password: "", roleId: "", departmentId: "" });
    setEditUser(null);
    setShowUserDialog(true);
  };

  const openEditUser = (u: HrUserItem) => {
    setUserForm({
      username: u.username,
      fullName: u.fullName ?? "",
      email: u.email ?? "",
      password: "",
      roleId: u.roleId ? String(u.roleId) : "",
      departmentId: u.departmentId ? String(u.departmentId) : "",
    });
    setEditUser(u);
    setShowUserDialog(true);
  };

  const saveUser = async () => {
    if (!userForm.username) {
      toast({ title: "Username is required", variant: "destructive" });
      return;
    }
    try {
      if (editUser) {
        const payload: Record<string, unknown> = {
          email: userForm.email || undefined,
          fullName: userForm.fullName || undefined,
          roleId: userForm.roleId ? Number(userForm.roleId) : undefined,
          departmentId: userForm.departmentId ? Number(userForm.departmentId) : undefined,
        };
        if (userForm.password) payload.password = userForm.password;
        await updateUserMutation.mutateAsync({ id: editUser.id, data: payload as any });
        toast({ title: "User updated" });
      } else {
        if (!userForm.password) {
          toast({ title: "Password is required", variant: "destructive" });
          return;
        }
        await createUserMutation.mutateAsync({
          username: userForm.username,
          password: userForm.password,
          email: userForm.email || undefined,
          fullName: userForm.fullName || undefined,
          roleId: userForm.roleId ? Number(userForm.roleId) : undefined,
        });
        toast({ title: "User created successfully" });
      }
      setShowUserDialog(false);
      refreshUsers();
    } catch (e: any) {
      toast({ title: "Failed to save user", description: e?.response?.data?.error, variant: "destructive" });
    }
  };

  const confirmDeleteUser = async () => {
    if (!deleteUser) return;
    try {
      await deleteUserMutation.mutateAsync(deleteUser.id);
      toast({ title: `User "${deleteUser.username}" deleted` });
      setDeleteUser(null);
      refreshUsers();
    } catch {
      toast({ title: "Cannot delete this user", variant: "destructive" });
    }
  };

  const toggleUserStatus = async (u: HrUserItem) => {
    await updateUserMutation.mutateAsync({ id: u.id, data: { isActive: !u.isActive } });
    refreshUsers();
  };

  // ── Role actions ───────────────────────────────────────────────────────────
  const createRole = async () => {
    if (!roleForm.name) {
      toast({ title: "Role name is required", variant: "destructive" });
      return;
    }
    try {
      await createRoleMutation.mutateAsync({
        name: roleForm.name,
        description: roleForm.description || undefined,
        permissions: emptyPerms(),
      });
      toast({ title: "Role created — now set its permissions" });
      setShowRoleDialog(false);
      setRoleForm({ name: "", description: "" });
      refreshRoles();
    } catch {
      toast({ title: "Failed to create role", variant: "destructive" });
    }
  };

  const openEditRole = (role: Role) => {
    setEditRole(role);
    setEditRolePerms(JSON.parse(JSON.stringify(role.permissions ?? emptyPerms())));
  };

  const saveRolePermissions = async () => {
    if (!editRole) return;
    try {
      await updateRoleMutation.mutateAsync({ id: editRole.id, data: { permissions: editRolePerms } });
      toast({ title: `Permissions saved for "${editRole.name}"` });
      setEditRole(null);
      refreshRoles();
    } catch {
      toast({ title: "Failed to save permissions", variant: "destructive" });
    }
  };

  const confirmDeleteRole = async () => {
    if (!deleteRole) return;
    try {
      await deleteRoleMutation.mutateAsync(deleteRole.id);
      toast({ title: `Role "${deleteRole.name}" deleted` });
      setDeleteRoleConfirm(null);
      refreshRoles();
    } catch {
      toast({ title: "Cannot delete this role", variant: "destructive" });
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────
  return (
    <HrLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-black text-gray-900">User Management</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Manage HR portal users, roles, and granular module permissions (RBAC)
          </p>
        </div>

        <Tabs defaultValue="users">
          <TabsList className="bg-gray-100">
            <TabsTrigger value="users" className="gap-2">
              <Users size={14} /> HR Users ({users.length})
            </TabsTrigger>
            <TabsTrigger value="roles" className="gap-2">
              <Shield size={14} /> Roles & Permissions ({roles.length})
            </TabsTrigger>
          </TabsList>

          {/* ── Users Tab ─────────────────────────────────────────────────── */}
          <TabsContent value="users" className="mt-4 space-y-4">
            <div className="flex justify-end">
              <Button className="gap-2" onClick={openCreateUser}>
                <Plus size={15} /> Add User
              </Button>
            </div>

            {usersLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <Card key={i} className="border-0 shadow-sm">
                  <CardContent className="p-4"><Skeleton className="h-10 w-full" /></CardContent>
                </Card>
              ))
            ) : users.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground text-sm">No users yet.</div>
            ) : (
              <div className="space-y-2">
                {users.map((u) => {
                  const initials = (u.fullName ?? u.username ?? "?").charAt(0).toUpperCase();
                  return (
                    <Card key={u.id} className={`border transition-shadow hover:shadow-md ${!u.isActive ? "opacity-60" : ""}`}>
                      <CardContent className="p-4">
                        <div className="flex items-center gap-4">
                          {/* Avatar */}
                          <div
                            className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-black text-white shrink-0"
                            style={{
                              background: u.isActive
                                ? "linear-gradient(135deg, #3b82f6, #6366f1)"
                                : "#d1d5db",
                            }}
                          >
                            {initials}
                          </div>

                          {/* Info */}
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-bold text-sm text-gray-900">{u.fullName ?? u.username}</span>
                              {u.roleName && (
                                <Badge variant="outline" className="text-xs">{u.roleName}</Badge>
                              )}
                              {!u.isActive && (
                                <Badge className="text-xs bg-red-50 text-red-600 border border-red-200">Inactive</Badge>
                              )}
                              {u.isSuperAdmin && (
                                <span className="flex items-center gap-1 text-xs text-amber-600 font-medium">
                                  <Lock size={11} /> Super Admin
                                </span>
                              )}
                            </div>
                            <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                              <span className="text-xs text-gray-400">@{u.username}</span>
                              {u.email && <span className="text-xs text-gray-400">{u.email}</span>}
                              {u.departmentName && <span className="text-xs text-gray-400">{u.departmentName}</span>}
                              {u.lastLogin && (
                                <span className="text-xs text-gray-300">
                                  Last login: {new Date(u.lastLogin).toLocaleString("en-IN", {
                                    day: "2-digit", month: "short", year: "numeric",
                                    hour: "2-digit", minute: "2-digit",
                                  })}
                                </span>
                              )}
                            </div>
                          </div>

                          {/* Actions */}
                          <div className="flex items-center gap-2 shrink-0">
                            <Button
                              variant="ghost" size="sm"
                              className="h-8 px-3 text-xs gap-1.5 text-gray-600 hover:text-blue-700 hover:bg-blue-50"
                              onClick={() => openEditUser(u)}
                            >
                              <Edit2 size={12} /> Edit
                            </Button>
                            {!u.isSuperAdmin && (
                              <>
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-8 px-3 text-xs gap-1.5"
                                  onClick={() => toggleUserStatus(u)}
                                  disabled={updateUserMutation.isPending}
                                >
                                  {u.isActive ? (
                                    <span className="text-amber-600">Deactivate</span>
                                  ) : (
                                    <span className="text-green-600">Activate</span>
                                  )}
                                </Button>
                                <Button
                                  variant="ghost" size="icon"
                                  className="h-8 w-8 text-red-400 hover:text-red-600 hover:bg-red-50"
                                  onClick={() => setDeleteUser(u)}
                                >
                                  <Trash2 size={13} />
                                </Button>
                              </>
                            )}
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          {/* ── Roles Tab ─────────────────────────────────────────────────── */}
          <TabsContent value="roles" className="mt-4 space-y-4">
            <div className="flex justify-end">
              <Button className="gap-2" onClick={() => setShowRoleDialog(true)}>
                <Plus size={15} /> New Role
              </Button>
            </div>

            {rolesLoading ? (
              Array.from({ length: 2 }).map((_, i) => (
                <Card key={i} className="border-0 shadow-sm">
                  <CardContent className="p-4"><Skeleton className="h-24 w-full" /></CardContent>
                </Card>
              ))
            ) : (
              <div className="space-y-4">
                {roles.map((role) => {
                  const userCount = users.filter((u) => u.roleId === role.id).length;
                  return (
                    <Card key={role.id} className="border">
                      <CardHeader className="pb-3">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Shield size={16} className="text-blue-600" />
                            <CardTitle className="text-sm font-bold">{role.name}</CardTitle>
                            {role.isSystem && (
                              <Badge className="text-xs bg-blue-50 text-blue-600 border-blue-200">System</Badge>
                            )}
                            <Badge variant="outline" className="text-xs">{userCount} users</Badge>
                          </div>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline" size="sm"
                              className="h-7 text-xs gap-1.5"
                              onClick={() => openEditRole(role)}
                            >
                              <Edit2 size={12} /> Edit Permissions
                            </Button>
                            {!role.isSystem && (
                              <Button
                                variant="ghost" size="icon"
                                className="h-7 w-7 text-red-400 hover:text-red-600 hover:bg-red-50"
                                onClick={() => setDeleteRoleConfirm(role)}
                              >
                                <Trash2 size={13} />
                              </Button>
                            )}
                          </div>
                        </div>
                        {role.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">{role.description}</p>
                        )}
                      </CardHeader>
                      <CardContent className="pt-0">
                        <PermissionMatrix perms={role.permissions ?? {}} readOnly />
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>
        </Tabs>
      </div>

      {/* ─── Create / Edit User Dialog ─────────────────────────────────────── */}
      <Dialog open={showUserDialog} onOpenChange={setShowUserDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editUser ? "Edit User" : "Create HR User"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Username {!editUser && <span className="text-red-500">*</span>}</Label>
                <Input
                  value={userForm.username}
                  disabled={!!editUser}
                  onChange={(e) => setUserForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="john.doe"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Full Name</Label>
                <Input
                  value={userForm.fullName}
                  onChange={(e) => setUserForm((f) => ({ ...f, fullName: e.target.value }))}
                  placeholder="John Doe"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Email</Label>
              <Input
                type="email"
                value={userForm.email}
                onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="john@uktextiles.in"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Role</Label>
                <select
                  value={userForm.roleId}
                  onChange={(e) => setUserForm((f) => ({ ...f, roleId: e.target.value }))}
                  className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                >
                  <option value="">— No role —</option>
                  {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label>Department</Label>
                <select
                  value={userForm.departmentId}
                  onChange={(e) => setUserForm((f) => ({ ...f, departmentId: e.target.value }))}
                  className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                >
                  <option value="">— Any —</option>
                  {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>
                {editUser ? "New Password" : "Password"} {!editUser && <span className="text-red-500">*</span>}
              </Label>
              {editUser && (
                <p className="text-xs text-muted-foreground">Leave blank to keep existing password</p>
              )}
              <Input
                type="password"
                value={userForm.password}
                onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="••••••••"
              />
            </div>
            <div className="flex gap-3 pt-2">
              <Button variant="outline" className="flex-1" onClick={() => setShowUserDialog(false)}>
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={saveUser}
                disabled={createUserMutation.isPending || updateUserMutation.isPending}
              >
                {createUserMutation.isPending || updateUserMutation.isPending
                  ? "Saving…"
                  : editUser ? "Save Changes" : "Create User"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Create Role Dialog ────────────────────────────────────────────── */}
      <Dialog open={showRoleDialog} onOpenChange={setShowRoleDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>New Role</DialogTitle></DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Role Name <span className="text-red-500">*</span></Label>
              <Input
                value={roleForm.name}
                onChange={(e) => setRoleForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. HR Executive"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Description</Label>
              <Input
                value={roleForm.description}
                onChange={(e) => setRoleForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              After creation, click <strong>Edit Permissions</strong> on the role card to set module access.
            </p>
            <div className="flex gap-3">
              <Button variant="outline" className="flex-1" onClick={() => setShowRoleDialog(false)}>Cancel</Button>
              <Button className="flex-1" onClick={createRole} disabled={createRoleMutation.isPending}>
                {createRoleMutation.isPending ? "Creating…" : "Create Role"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Edit Role Permissions Modal ───────────────────────────────────── */}
      <Dialog open={!!editRole} onOpenChange={(open) => !open && setEditRole(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Shield size={16} className="text-blue-600" />
              Edit Permissions — {editRole?.name}
            </DialogTitle>
          </DialogHeader>
          <p className="text-xs text-muted-foreground -mt-2">
            Toggle access for each module. Enabling any action automatically grants <strong>View</strong>.
          </p>
          <div className="py-2">
            <PermissionMatrix perms={editRolePerms} onChange={setEditRolePerms} />
          </div>
          <div className="flex gap-3 pt-2">
            <Button variant="outline" className="flex-1" onClick={() => setEditRole(null)}>Cancel</Button>
            <Button className="flex-1" onClick={saveRolePermissions} disabled={updateRoleMutation.isPending}>
              {updateRoleMutation.isPending ? "Saving…" : "Save Permissions"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Delete User Confirm ────────────────────────────────────────────── */}
      <Dialog open={!!deleteUser} onOpenChange={(open) => !open && setDeleteUser(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-red-600"><AlertTriangle size={16} /> Delete User</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            Permanently delete <strong>{deleteUser?.fullName ?? deleteUser?.username}</strong>? This cannot be undone.
          </p>
          <div className="flex gap-3 pt-3">
            <Button variant="outline" className="flex-1" onClick={() => setDeleteUser(null)}>Cancel</Button>
            <Button variant="destructive" className="flex-1" onClick={confirmDeleteUser} disabled={deleteUserMutation.isPending}>
              {deleteUserMutation.isPending ? "Deleting…" : "Delete User"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ─── Delete Role Confirm ────────────────────────────────────────────── */}
      <Dialog open={!!deleteRole} onOpenChange={(open) => !open && setDeleteRoleConfirm(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle className="flex items-center gap-2 text-red-600"><AlertTriangle size={16} /> Delete Role</DialogTitle></DialogHeader>
          <p className="text-sm text-gray-600">
            Delete role <strong>{deleteRole?.name}</strong>?
            {users.filter((u) => u.roleId === deleteRole?.id).length > 0 && (
              <span className="text-red-500"> {users.filter((u) => u.roleId === deleteRole?.id).length} user(s) will lose this role.</span>
            )}
          </p>
          <div className="flex gap-3 pt-3">
            <Button variant="outline" className="flex-1" onClick={() => setDeleteRoleConfirm(null)}>Cancel</Button>
            <Button variant="destructive" className="flex-1" onClick={confirmDeleteRole} disabled={deleteRoleMutation.isPending}>
              {deleteRoleMutation.isPending ? "Deleting…" : "Delete Role"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
