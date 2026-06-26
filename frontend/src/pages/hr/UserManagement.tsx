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
  useListRoles, useCreateRole, useDeleteRole, getListRolesQueryKey,
  useListHrUsers, useCreateHrUser, useUpdateHrUser, getListHrUsersQueryKey,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { Shield, Plus, Trash2, CheckSquare, Users, Lock } from "lucide-react";

const MODULES = ["employees", "payroll", "attendance", "leave", "reports", "settings", "user_management"];
const PERMS = ["view", "create", "edit", "delete", "approve"] as const;

export default function UserManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showUserDialog, setShowUserDialog] = useState(false);
  const [showRoleDialog, setShowRoleDialog] = useState(false);
  const [userForm, setUserForm] = useState({
    username: "", fullName: "", email: "", password: "", roleId: "",
  });
  const [roleForm, setRoleForm] = useState({ name: "", description: "" });

  const { data: roles, isLoading: rolesLoading } = useListRoles();
  const { data: users, isLoading: usersLoading } = useListHrUsers();
  const createUserMutation = useCreateHrUser();
  const updateUserMutation = useUpdateHrUser();
  const createRoleMutation = useCreateRole();
  const deleteRoleMutation = useDeleteRole();

  const createUser = async () => {
    if (!userForm.username || !userForm.password) {
      toast({ title: "Username and password required", variant: "destructive" });
      return;
    }
    try {
      await createUserMutation.mutateAsync({
        username: userForm.username,
        password: userForm.password,
        email: userForm.email || undefined,
        fullName: userForm.fullName || undefined,
        roleId: userForm.roleId ? Number(userForm.roleId) : undefined,
      });
    } catch {
      toast({ title: "Failed to create user", variant: "destructive" });
      return;
    }
    toast({ title: "User created successfully" });
    setShowUserDialog(false);
    setUserForm({ username: "", fullName: "", email: "", password: "", roleId: "" });
    queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
  };

  const toggleUserStatus = async (id: number, currentlyActive: boolean) => {
    try {
      await updateUserMutation.mutateAsync({ id, data: { isActive: !currentlyActive } });
    } catch {
      toast({ title: "Failed to update user", variant: "destructive" });
      return;
    }
    queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
  };

  const createRole = async () => {
    if (!roleForm.name) {
      toast({ title: "Role name is required", variant: "destructive" });
      return;
    }
    try {
      await createRoleMutation.mutateAsync({
        name: roleForm.name,
        description: roleForm.description || undefined,
        permissions: Object.fromEntries(
          MODULES.map((m) => [m, Object.fromEntries(PERMS.map((p) => [p, false]))]),
        ),
      });
    } catch {
      toast({ title: "Failed to create role", variant: "destructive" });
      return;
    }
    toast({ title: "Role created" });
    setShowRoleDialog(false);
    setRoleForm({ name: "", description: "" });
    queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
  };

  const deleteRole = async (id: number) => {
    try {
      await deleteRoleMutation.mutateAsync(id);
    } catch {
      toast({ title: "Cannot delete this role", variant: "destructive" });
      return;
    }
    toast({ title: "Role deleted" });
    queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
  };

  return (
    <HrLayout>
      <div className="space-y-6">
        <div>
          <h2 className="text-2xl font-black text-gray-900">User Management</h2>
          <p className="text-muted-foreground text-sm mt-0.5">Manage HR users, roles, and permissions (RBAC)</p>
        </div>

        <Tabs defaultValue="users">
          <TabsList className="bg-gray-100">
            <TabsTrigger value="users" className="gap-2">
              <Users size={14} /> HR Users ({users?.length ?? 0})
            </TabsTrigger>
            <TabsTrigger value="roles" className="gap-2">
              <Shield size={14} /> Roles ({roles?.length ?? 0})
            </TabsTrigger>
          </TabsList>

          {/* Users Tab */}
          <TabsContent value="users" className="mt-4 space-y-4">
            <div className="flex justify-end">
              <Button className="gap-2" onClick={() => setShowUserDialog(true)}>
                <Plus size={15} /> Add User
              </Button>
            </div>
            <div className="space-y-3">
              {usersLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <Card key={i} className="border-0 shadow-sm">
                    <CardContent className="p-4">
                      <Skeleton className="h-9 w-9 rounded-full mb-2" />
                      <Skeleton className="h-5 w-40" />
                    </CardContent>
                  </Card>
                ))
              ) : (users ?? []).length === 0 ? (
                <div className="text-center py-12 text-muted-foreground text-sm">No users yet.</div>
              ) : (
                (users ?? []).map((u) => (
                  <Card key={u.id} className="border hover:shadow-sm transition-shadow">
                    <CardContent className="p-4">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-3">
                          <div
                            className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold text-white shrink-0"
                            style={{ background: u.isActive ? "linear-gradient(135deg, #3b82f6, #6366f1)" : "#d1d5db" }}
                          >
                            {(u.fullName ?? u.username ?? "?").charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <p className="font-bold text-sm text-gray-900">{u.fullName ?? u.username}</p>
                              {u.roleName && <Badge variant="outline" className="text-xs">{u.roleName}</Badge>}
                              {!u.isActive && <Badge className="text-xs bg-red-50 text-red-600 border-red-200">Inactive</Badge>}
                              {u.isSuperAdmin && <Lock size={12} className="text-amber-500" />}
                            </div>
                            <p className="text-xs text-gray-400">{u.username} · {u.email}</p>
                            {u.lastLogin && (
                              <p className="text-xs text-gray-300">
                                Last login: {new Date(u.lastLogin).toLocaleString("en-IN")}
                              </p>
                            )}
                          </div>
                        </div>
                        {!u.isSuperAdmin && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => toggleUserStatus(u.id, u.isActive)}
                            disabled={updateUserMutation.isPending}
                          >
                            {u.isActive ? "Deactivate" : "Activate"}
                          </Button>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                ))
              )}
            </div>
          </TabsContent>

          {/* Roles Tab */}
          <TabsContent value="roles" className="mt-4 space-y-4">
            <div className="flex justify-end">
              <Button className="gap-2" onClick={() => setShowRoleDialog(true)}>
                <Plus size={15} /> New Role
              </Button>
            </div>
            <div className="space-y-4">
              {rolesLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <Card key={i} className="border-0 shadow-sm">
                    <CardContent className="p-4">
                      <Skeleton className="h-5 w-40 mb-2" /><Skeleton className="h-4 w-64" />
                    </CardContent>
                  </Card>
                ))
              ) : (
                (roles ?? []).map((role) => {
                  const userCount = (users ?? []).filter((u) => u.roleId === role.id).length;
                  return (
                    <Card key={role.id} className="border">
                      <CardHeader className="pb-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <Shield size={16} className="text-blue-600" />
                            <CardTitle className="text-sm font-bold">{role.name}</CardTitle>
                            {role.isSystem && (
                              <Badge className="text-xs bg-blue-50 text-blue-600 border-blue-200">System</Badge>
                            )}
                            <Badge variant="outline" className="text-xs">{userCount} users</Badge>
                          </div>
                          {!role.isSystem && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-red-400 hover:text-red-600 hover:bg-red-50"
                              onClick={() => deleteRole(role.id)}
                              disabled={deleteRoleMutation.isPending}
                            >
                              <Trash2 size={13} />
                            </Button>
                          )}
                        </div>
                        {role.description && (
                          <p className="text-xs text-muted-foreground mt-0.5">{role.description}</p>
                        )}
                      </CardHeader>
                      <CardContent>
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr>
                                <th className="text-left py-1.5 pr-4 font-semibold text-gray-500 uppercase tracking-wide">Module</th>
                                {PERMS.map((p) => (
                                  <th key={p} className="text-center py-1.5 px-2 font-semibold text-gray-500 uppercase tracking-wide capitalize">{p}</th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-gray-50">
                              {MODULES.map((mod) => {
                                const modPerms = (role.permissions ?? {})[mod] ?? {};
                                return (
                                  <tr key={mod}>
                                    <td className="py-1.5 pr-4 font-medium text-gray-700 capitalize">{mod.replace("_", " ")}</td>
                                    {PERMS.map((p) => (
                                      <td key={p} className="text-center py-1.5 px-2">
                                        {modPerms[p] ? (
                                          <CheckSquare size={13} className="text-green-500 mx-auto" />
                                        ) : (
                                          <div className="w-3 h-3 rounded border border-gray-200 mx-auto" />
                                        )}
                                      </td>
                                    ))}
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </CardContent>
                    </Card>
                  );
                })
              )}
            </div>
          </TabsContent>
        </Tabs>

        {/* Create User Dialog */}
        <Dialog open={showUserDialog} onOpenChange={setShowUserDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Create HR User</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Username <span className="text-red-500">*</span></Label>
                  <Input value={userForm.username}
                    onChange={(e) => setUserForm((f) => ({ ...f, username: e.target.value }))} placeholder="john.doe" />
                </div>
                <div className="space-y-1.5">
                  <Label>Full Name</Label>
                  <Input value={userForm.fullName}
                    onChange={(e) => setUserForm((f) => ({ ...f, fullName: e.target.value }))} placeholder="John Doe" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input type="email" value={userForm.email}
                  onChange={(e) => setUserForm((f) => ({ ...f, email: e.target.value }))} placeholder="john@uktextiles.in" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Role</Label>
                  <select value={userForm.roleId}
                    onChange={(e) => setUserForm((f) => ({ ...f, roleId: e.target.value }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background">
                    <option value="">— No role —</option>
                    {(roles ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label>Password <span className="text-red-500">*</span></Label>
                  <Input type="password" value={userForm.password}
                    onChange={(e) => setUserForm((f) => ({ ...f, password: e.target.value }))} placeholder="••••••••" />
                </div>
              </div>
              <div className="flex gap-3 pt-2">
                <Button variant="outline" className="flex-1" onClick={() => setShowUserDialog(false)}>Cancel</Button>
                <Button className="flex-1" onClick={createUser} disabled={createUserMutation.isPending}>
                  {createUserMutation.isPending ? "Creating…" : "Create User"}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* Create Role Dialog */}
        <Dialog open={showRoleDialog} onOpenChange={setShowRoleDialog}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle>New Role</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div className="space-y-1.5">
                <Label>Role Name <span className="text-red-500">*</span></Label>
                <Input value={roleForm.name}
                  onChange={(e) => setRoleForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. HR Executive" />
              </div>
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Input value={roleForm.description}
                  onChange={(e) => setRoleForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Optional description" />
              </div>
              <p className="text-xs text-muted-foreground">
                The role will be created with all permissions set to off. Configure permissions after creation.
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
      </div>
    </HrLayout>
  );
}
