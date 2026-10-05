import { useState } from "react";
import { Crown, Eye, EyeOff, UserCog } from "lucide-react";
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

type Props = {
  user: HrUserItem | null;
  roles: Role[];
  /** Every account: needed to tell who the Managing Director is now. */
  users: HrUserItem[];
  /** Start a new account with the Managing Director switch already on. */
  defaultMd?: boolean;
  open: boolean;
  onClose: () => void;
};

/** Create or edit a portal login: username, name, email, password, role, branch and whether it is the MD. */
export default function HrUserDialog({ user, roles, users, defaultMd = false, open, onClose }: Props) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState(user?.username ?? "");
  const [fullName, setFullName] = useState(user?.fullName ?? "");
  const [email, setEmail] = useState(user?.email ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [roleId, setRoleId] = useState<string>(user?.roleId ? String(user.roleId) : "");
  const [branchId, setBranchId] = useState<string>(user?.branchId ? String(user.branchId) : "");
  const [isMd, setIsMd] = useState<boolean>(user ? !!user.isMd : defaultMd);
  const [replaceMd, setReplaceMd] = useState(false);
  const { data: branches } = useListBranches();
  // Someone else already holds the MD identity: making this account the MD takes it from them.
  const currentMd = users.find((u) => u.isMd && u.id !== user?.id) ?? null;
  const takesOver = isMd && !!currentMd;

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
    if (takesOver && !replaceMd) {
      toast({
        title: `Confirm the change of Managing Director`,
        description: `${currentMd?.username} is the MD now. Tick the box to move the MD identity to this account.`,
        variant: "destructive",
      });
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
            // the MD is company-wide: any branch is cleared in the same step
            branchId: isMd ? null : branchId ? Number(branchId) : null,
            ...(password ? { password } : {}),
            ...(isMd !== !!user.isMd ? { isMd, ...(takesOver ? { replaceMd: true } : {}) } : {}),
          },
        });
        toast({
          title: isMd !== !!user.isMd ? (isMd ? "Managing Director assigned" : "MD access removed") : "Account updated",
        });
      } else {
        await createMutation.mutateAsync({
          username: username.trim(),
          password,
          fullName: fullName || undefined,
          email: email || undefined,
          roleId: roleId ? Number(roleId) : undefined,
          branchId: !isMd && branchId ? Number(branchId) : undefined,
          ...(isMd ? { isMd: true, ...(takesOver ? { replaceMd: true } : {}) } : {}),
        });
        toast({ title: isMd ? "Managing Director account created" : "Account created" });
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

  const chosenRole = roles.find((r) => String(r.id) === roleId);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        className="max-h-[92vh] w-[calc(100vw-1.5rem)] max-w-md overflow-y-auto"
        data-testid="account-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="rounded-lg bg-blue-50 p-1.5 text-blue-600">
              <UserCog size={16} />
            </span>
            {user ? `Edit account: ${user.username}` : "Create account"}
          </DialogTitle>
          <DialogDescription>
            {user ? "Change the details, role or branch of this login." : "A new login for the HR portal."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 pt-1">
          <div className="space-y-1.5">
            <Label htmlFor="acct-username">
              Username <span className="text-red-500">*</span>
            </Label>
            <Input
              id="acct-username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder="e.g. md, director1, ea.rahul"
              disabled={!!user}
              data-testid="acct-username"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="acct-fullname">Full name</Label>
              <Input
                id="acct-fullname"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Managing Director"
                data-testid="acct-fullname"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="acct-email">
                Email <span className="font-normal text-gray-400">(optional)</span>
              </Label>
              <Input
                id="acct-email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="name@uktextiles.in"
                data-testid="acct-email"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="acct-password">
              {user ? "New password" : "Password"} {!user && <span className="text-red-500">*</span>}
            </Label>
            <div className="relative">
              <Input
                id="acct-password"
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={user ? "Leave blank to keep current password" : "Set a login password"}
                autoComplete="new-password"
                data-testid="acct-password"
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
            <Label>Role</Label>
            <Select value={roleId} onValueChange={setRoleId}>
              <SelectTrigger data-testid="acct-role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">
              {chosenRole
                ? `${chosenRole.name}: ${chosenRole.description || "what this login can see and edit comes from this role's module access."}`
                : "Access comes entirely from the role's module permissions. An account with no role can't open any module."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Branch</Label>
            <Select
              value={isMd ? "__all__" : branchId || "__all__"}
              onValueChange={(v) => setBranchId(v === "__all__" ? "" : v)}
              disabled={isMd}
            >
              <SelectTrigger data-testid="acct-branch">
                <SelectValue placeholder="All branches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">All branches (company-wide)</SelectItem>
                {branches?.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                    {b.isHeadOffice ? " (Head Office)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-gray-500">
              {isMd
                ? "The Managing Director sees the whole company, so this stays on All branches."
                : `Leave it on "All branches" for a company-wide login (MD, Director, HR Admin). Pick one branch to limit this login to that branch's data.`}
            </p>
          </div>

          {/* ── the Managing Director identity ── */}
          <div
            className={`rounded-xl border p-3.5 transition-colors ${isMd ? "border-[#e0a83a]/60 bg-[#fffaf0]" : "border-gray-200 bg-gray-50/60"}`}
            data-testid="acct-md-section"
          >
            <div className="flex items-start gap-3">
              <span
                className={`mt-0.5 rounded-lg p-1.5 ${isMd ? "bg-[#fff1cc] text-[#7a5410]" : "bg-gray-100 text-gray-500"}`}
              >
                <Crown size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <Label htmlFor="acct-md" className="font-bold">
                  Managing Director
                </Label>
                <p className="mt-0.5 text-xs leading-relaxed text-gray-600">
                  Gives this login the executive MD portal (dashboards, analytics, reports) and the read-only AI
                  assistant. Only one account can be the MD, and nothing changes for anyone else.
                </p>
              </div>
              <Switch
                id="acct-md"
                checked={isMd}
                onCheckedChange={(on) => {
                  setIsMd(on);
                  setReplaceMd(false);
                }}
                disabled={!!user?.isSuperAdmin}
                data-testid="acct-md"
                aria-label="Managing Director"
              />
            </div>
            {user?.isSuperAdmin && (
              <p className="mt-2 text-xs text-gray-500">
                An administrator account cannot be the MD: make a separate account for the MD.
              </p>
            )}
            {takesOver && (
              <label
                className="mt-3 flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900"
                data-testid="acct-md-replace"
              >
                <input
                  type="checkbox"
                  checked={replaceMd}
                  onChange={(e) => setReplaceMd(e.target.checked)}
                  className="mt-0.5"
                  data-testid="acct-md-replace-check"
                />
                <span>
                  <b>{currentMd?.fullName || currentMd?.username}</b> is the Managing Director now. Move the MD identity
                  to this account (they lose the MD portal and the AI assistant).
                </span>
              </label>
            )}
            {!isMd && user?.isMd && (
              <p className="mt-2 text-xs text-amber-800">
                Saving removes the MD portal and the AI assistant from this account.
              </p>
            )}
          </div>
        </div>

        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isPending} data-testid="acct-save">
            {isPending ? "Saving…" : user ? "Save changes" : "Create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
