import { useState } from "react";
import { Eye, EyeOff, UserCog } from "lucide-react";
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
  open: boolean;
  onClose: () => void;
};

/** Create or edit a portal login: username, name, email, password, role and branch. */
export default function HrUserDialog({ user, roles, open, onClose }: Props) {
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
          username: username.trim(),
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
            <Select value={branchId || "__all__"} onValueChange={(v) => setBranchId(v === "__all__" ? "" : v)}>
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
              Leave it on "All branches" for a company-wide login (MD, Director, HR Admin). Pick one branch to limit
              this login to that branch's data.
            </p>
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
