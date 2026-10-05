import { useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, Shield, ShieldPlus, UserCog, UserPlus, Users, UserX } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import HrLayout from "@/components/HrLayout";
import { Button } from "@/components/ui/button";
import { PillTabs } from "@/components/ui/pill-tabs";
import { Tabs, TabsContent } from "@/components/ui/tabs";
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
import { useToast } from "@/hooks/use-toast";
import {
  getListHrUsersQueryKey,
  getListRolesQueryKey,
  useDeleteHrUser,
  useDeleteRole,
  useListBranches,
  useListHrUsers,
  useListRoles,
  useUpdateHrUser,
  type HrUserItem,
  type Role,
} from "@/lib/api-client/custom-hooks";
import AccountsTab from "./account-management/AccountsTab";
import HrUserDialog from "./account-management/HrUserDialog";
import RoleDialog from "./account-management/RoleDialog";
import RolesTab from "./account-management/RolesTab";
import { NONE, NO_FILTERS, roleUsage, summarizeAccounts, type AccountFilters } from "./account-management/logic";
import { StatCard } from "./account-management/parts";

/** "3 custom · 1 built in" (the built-in part only when there is one). */
const roleSummary = (list: Role[]) => {
  const builtIn = list.filter((r) => r.isSystem).length;
  return `${list.length - builtIn} custom${builtIn ? ` · ${builtIn} built in` : ""}`;
};

type Confirm = { kind: "user"; user: HrUserItem } | { kind: "role"; role: Role } | null;

/** Account Management (admin only): the portal's logins, and the roles that decide what each can see and edit. */
export default function AccountManagement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: hrUsers, isLoading: usersLoading } = useListHrUsers();
  const { data: roles, isLoading: rolesLoading } = useListRoles();
  const { data: branches } = useListBranches();
  const users = useMemo(() => hrUsers ?? [], [hrUsers]);
  const roleList = useMemo(() => roles ?? [], [roles]);

  const [tab, setTab] = useState("accounts");
  const [filters, setFilters] = useState<AccountFilters>(NO_FILTERS);
  const [userDialog, setUserDialog] = useState<{ open: boolean; user: HrUserItem | null }>({ open: false, user: null });
  const [roleDialog, setRoleDialog] = useState<{ open: boolean; role: Role | null }>({ open: false, role: null });
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const updateUserMutation = useUpdateHrUser();
  const deleteUserMutation = useDeleteHrUser();
  const deleteRoleMutation = useDeleteRole();

  const summary = useMemo(() => summarizeAccounts(users), [users]);
  const usage = useMemo(() => roleUsage(users), [users]);

  const toggleActive = async (u: HrUserItem) => {
    setBusyId(u.id);
    try {
      await updateUserMutation.mutateAsync({ id: u.id, data: { isActive: !u.isActive } });
      queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
      toast({ title: u.isActive ? `${u.username} disabled` : `${u.username} enabled` });
    } catch (e: unknown) {
      toast({
        title: "Failed to update account",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setBusyId(null);
    }
  };

  const runDelete = async () => {
    const pending = confirm;
    setConfirm(null);
    if (!pending) return;
    try {
      if (pending.kind === "user") {
        if (pending.user.isSuperAdmin) return;
        await deleteUserMutation.mutateAsync(pending.user.id);
        queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
        toast({ title: `Account ${pending.user.username} deleted` });
      } else {
        if (pending.role.isSystem) return;
        await deleteRoleMutation.mutateAsync(pending.role.id);
        // accounts that had the role lose it, so both lists are stale
        queryClient.invalidateQueries({ queryKey: getListRolesQueryKey() });
        queryClient.invalidateQueries({ queryKey: getListHrUsersQueryKey() });
        toast({ title: `Role ${pending.role.name} deleted` });
      }
    } catch (e: unknown) {
      toast({
        title: pending.kind === "user" ? "Failed to delete account" : "Failed to delete role",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const showAccountsOf = (role: Role) => {
    setFilters({ ...NO_FILTERS, role: String(role.id) });
    setTab("accounts");
  };

  const roleUsers = confirm?.kind === "role" ? (usage[confirm.role.id] ?? 0) : 0;

  return (
    <HrLayout>
      <div className="space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-blue-600 p-2.5 text-white shadow-sm">
              <UserCog size={22} />
            </div>
            <div>
              <h2 className="text-2xl font-black text-gray-900">Account Management</h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                Admin only: create HR portal logins and control what each one can see and edit.
              </p>
            </div>
          </div>
          {tab === "accounts" ? (
            <Button
              onClick={() => setUserDialog({ open: true, user: null })}
              className="gap-1.5"
              data-testid="create-account"
            >
              <UserPlus size={15} /> Create account
            </Button>
          ) : (
            <Button
              onClick={() => setRoleDialog({ open: true, role: null })}
              className="gap-1.5"
              data-testid="create-role"
            >
              <ShieldPlus size={15} /> Create role
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard
            testId="stat-accounts"
            label="Accounts"
            value={usersLoading ? "—" : summary.total}
            sub={usersLoading ? undefined : `${summary.branchScoped} branch-only · ${summary.companyWide} company-wide`}
            icon={Users}
            tone="bg-slate-100 text-slate-800"
          />
          <StatCard
            testId="stat-active"
            label="Active"
            value={usersLoading ? "—" : summary.active}
            sub="can sign in"
            icon={CheckCircle2}
            tone="bg-green-50 text-green-800"
          />
          <StatCard
            testId="stat-disabled"
            label="Disabled"
            value={usersLoading ? "—" : summary.disabled}
            sub="blocked from signing in"
            icon={UserX}
            tone="bg-amber-50 text-amber-800"
          />
          <StatCard
            testId="stat-roles"
            label="Roles"
            value={rolesLoading ? "—" : roleList.length}
            sub={rolesLoading ? undefined : roleSummary(roleList)}
            icon={Shield}
            tone="bg-blue-50 text-blue-800"
          />
        </div>

        <Tabs value={tab} onValueChange={setTab}>
          <PillTabs
            items={[
              { value: "accounts", label: "Accounts", icon: <Users size={14} />, count: users.length },
              { value: "roles", label: "Roles & Permissions", icon: <Shield size={14} />, count: roleList.length },
            ]}
            value={tab}
            onChange={setTab}
          />

          <TabsContent value="accounts">
            {summary.noRole > 0 && (
              <div
                className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                data-testid="no-role-notice"
              >
                <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                <p className="flex-1">
                  <b>
                    {summary.noRole} {summary.noRole === 1 ? "account has" : "accounts have"} no role
                  </b>{" "}
                  and can't open any module until one is given.
                </p>
                <button
                  type="button"
                  onClick={() => setFilters({ ...NO_FILTERS, role: NONE })}
                  className="font-semibold underline"
                >
                  Show
                </button>
              </div>
            )}
            <AccountsTab
              users={users}
              roles={roleList}
              branches={branches ?? []}
              loading={usersLoading}
              filters={filters}
              onFilters={setFilters}
              onCreate={() => setUserDialog({ open: true, user: null })}
              onEdit={(user) => setUserDialog({ open: true, user })}
              onToggleActive={toggleActive}
              onDelete={(user) => setConfirm({ kind: "user", user })}
              busyId={busyId}
            />
          </TabsContent>

          <TabsContent value="roles">
            <RolesTab
              roles={roleList}
              users={users}
              loading={rolesLoading}
              onCreate={() => setRoleDialog({ open: true, role: null })}
              onEdit={(role) => setRoleDialog({ open: true, role })}
              onDelete={(role) => setConfirm({ kind: "role", role })}
              onShowAccounts={showAccountsOf}
            />
          </TabsContent>
        </Tabs>

        {userDialog.open && (
          <HrUserDialog
            key={userDialog.user?.id ?? "new"}
            user={userDialog.user}
            roles={roleList}
            open={userDialog.open}
            onClose={() => setUserDialog({ open: false, user: null })}
          />
        )}
        {roleDialog.open && (
          <RoleDialog
            key={roleDialog.role?.id ?? "new"}
            role={roleDialog.role}
            roles={roleList}
            usedBy={roleDialog.role ? (usage[roleDialog.role.id] ?? 0) : 0}
            open={roleDialog.open}
            onClose={() => setRoleDialog({ open: false, role: null })}
          />
        )}

        <AlertDialog open={confirm !== null} onOpenChange={(o) => !o && setConfirm(null)}>
          <AlertDialogContent data-testid="confirm-delete">
            <AlertDialogHeader>
              <AlertDialogTitle>
                {confirm?.kind === "user" ? `Delete account "${confirm.user.username}"?` : null}
                {confirm?.kind === "role" ? `Delete role "${confirm.role.name}"?` : null}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {confirm?.kind === "user" &&
                  "They will no longer be able to sign in to the HR portal. This cannot be undone. To keep the account but stop it signing in, disable it instead."}
                {confirm?.kind === "role" &&
                  (roleUsers > 0
                    ? `${roleUsers} ${roleUsers === 1 ? "account uses" : "accounts use"} this role and will be left with no role, so ${roleUsers === 1 ? "it" : "they"} can't open any module until another role is given. This cannot be undone.`
                    : "No account uses this role. This cannot be undone.")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel data-testid="confirm-cancel">Cancel</AlertDialogCancel>
              <AlertDialogAction
                onClick={runDelete}
                className="bg-red-600 text-white hover:bg-red-700"
                data-testid="confirm-delete-yes"
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </HrLayout>
  );
}
