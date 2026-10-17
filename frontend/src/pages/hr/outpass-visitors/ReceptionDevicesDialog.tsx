import { useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import {
  useListReceptionDevices,
  getListReceptionDevicesQueryKey,
  useCreateReceptionDevice,
  useUpdateReceptionDevice,
  useDeleteReceptionDevice,
  type ReceptionDevice,
} from "@/lib/api-client/custom-hooks";
import { Copy, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";

// ── Reception device management ─────────────────────────────────────────
// A ReceptionDevice is to the Visitors page what GateDevice is to the
// Outpass page: a real username/password login for Reception staff's
// own dashboard (/reception/console) onto VisitorVisit -no scanning of any
// kind, the visitor's own phone scanning the permanent Visitor QR
// remains the only way a visit gets recorded. See backend/api/reception_views.py.

function ReceptionDeviceRow({
  device,
  onToggleActive,
  onResetPassword,
  onDelete,
  isMutating,
}: {
  device: ReceptionDevice;
  onToggleActive: (device: ReceptionDevice, next: boolean) => void;
  onResetPassword: (device: ReceptionDevice) => void;
  onDelete: (device: ReceptionDevice) => void;
  isMutating: boolean;
}) {
  const { toast } = useToast();
  const loginUrl = `${window.location.origin}/reception-login/${device.loginToken}`;

  const copyLink = () => {
    navigator.clipboard.writeText(loginUrl);
    toast({ title: "Login link copied" });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold">{device.name}</p>
          <Badge
            variant={device.isActive ? "default" : "secondary"}
            className={`text-[10px] ${device.isActive ? "!bg-green-100 !text-green-700" : ""}`}
          >
            {device.isActive ? "Active" : "Deactivated"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {device.branchName ?? "No branch"} · Username: <span className="font-mono">{device.username}</span>
          {device.lastLoginAt &&
            ` · Last login ${new Date(device.lastLoginAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 shrink-0">
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs px-2" onClick={copyLink}>
          <Copy size={12} /> Copy Login Link
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs px-2"
          onClick={() => onResetPassword(device)}
          disabled={isMutating}
        >
          <KeyRound size={12} /> Reset Password
        </Button>
        <Switch checked={device.isActive} onCheckedChange={(v) => onToggleActive(device, v)} disabled={isMutating} />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs px-2 text-red-600 border-red-200 hover:bg-red-50"
          onClick={() => onDelete(device)}
          disabled={isMutating}
        >
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  );
}

export function ReceptionDevicesDialog({
  isBranchScoped,
  branches,
  defaultBranchId,
}: {
  isBranchScoped: boolean;
  branches: { id: number; name: string }[] | undefined;
  defaultBranchId?: string;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", branchId: defaultBranchId ?? "", username: "", password: "" });
  const [formError, setFormError] = useState<string | null>(null);
  const [resetTarget, setResetTarget] = useState<ReceptionDevice | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const { data: devices, isLoading } = useListReceptionDevices();
  const createMutation = useCreateReceptionDevice();
  const updateMutation = useUpdateReceptionDevice();
  const deleteMutation = useDeleteReceptionDevice();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListReceptionDevicesQueryKey() });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (form.name.trim().length < 1) return setFormError("Desk name is required.");
    if (!isBranchScoped && !form.branchId) return setFormError("Please select a branch.");
    if (form.username.trim().length < 3) return setFormError("Username must be at least 3 characters.");
    if (form.password.length < 6) return setFormError("Password must be at least 6 characters.");

    try {
      await createMutation.mutateAsync({
        name: form.name.trim(),
        branchId: form.branchId ? Number(form.branchId) : undefined,
        username: form.username.trim(),
        password: form.password,
      });
      toast({ title: `${form.name.trim()} created` });
      setForm({ name: "", branchId: defaultBranchId ?? "", username: "", password: "" });
      invalidate();
    } catch (err: any) {
      setFormError(err?.message ?? "Could not create reception desk");
    }
  };

  const toggleActive = async (device: ReceptionDevice, next: boolean) => {
    await updateMutation.mutateAsync({ id: device.id, data: { isActive: next } });
    toast({ title: next ? `${device.name} reactivated` : `${device.name} deactivated` });
    invalidate();
  };

  const submitReset = async () => {
    if (!resetTarget) return;
    if (resetPassword.length < 6)
      return toast({ title: "Password must be at least 6 characters", variant: "destructive" });
    await updateMutation.mutateAsync({ id: resetTarget.id, data: { password: resetPassword } });
    toast({ title: `Password reset for ${resetTarget.name}` });
    setResetTarget(null);
    setResetPassword("");
  };

  const handleDelete = async (device: ReceptionDevice) => {
    if (!confirm(`Remove ${device.name}? Its login will stop working immediately.`)) return;
    await deleteMutation.mutateAsync(device.id);
    toast({ title: `${device.name} removed` });
    invalidate();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <ShieldCheck size={14} /> Manage Reception
        </Button>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Reception Desk Logins</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-1 max-h-[70vh] overflow-y-auto">
            <div className="flex flex-col gap-2">
              {isLoading ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
              ) : !devices?.length ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No reception desks created yet.</p>
              ) : (
                devices.map((d) => (
                  <ReceptionDeviceRow
                    key={d.id}
                    device={d}
                    onToggleActive={toggleActive}
                    onResetPassword={(device) => setResetTarget(device)}
                    onDelete={handleDelete}
                    isMutating={updateMutation.isPending || deleteMutation.isPending}
                  />
                ))
              )}
            </div>

            <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded-xl border p-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Add a Reception Desk</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="reception-name">Desk Name</Label>
                  <Input
                    id="reception-name"
                    placeholder="Front Desk"
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  />
                </div>
                {!isBranchScoped && (
                  <div className="flex flex-col gap-1">
                    <Label>Branch</Label>
                    <Select value={form.branchId} onValueChange={(v) => setForm((f) => ({ ...f, branchId: v }))}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select branch" />
                      </SelectTrigger>
                      <SelectContent>
                        {branches?.map((b) => (
                          <SelectItem key={b.id} value={String(b.id)}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <Label htmlFor="reception-username">Username</Label>
                  <Input
                    id="reception-username"
                    value={form.username}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="reception-password">Password</Label>
                  <Input
                    id="reception-password"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  />
                </div>
              </div>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" className="gap-1.5" disabled={createMutation.isPending}>
                <Plus size={14} /> {createMutation.isPending ? "Creating…" : "Create Desk"}
              </Button>
            </form>
          </div>
        </DialogContent>
      </Dialog>

      {/* Reset-password mini dialog */}
      {resetTarget && (
        <Dialog
          open
          onOpenChange={() => {
            setResetTarget(null);
            setResetPassword("");
          }}
        >
          <DialogContent className="max-w-xs">
            <DialogHeader>
              <DialogTitle>Reset password for {resetTarget.name}</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <Input
                type="password"
                placeholder="New password"
                value={resetPassword}
                onChange={(e) => setResetPassword(e.target.value)}
              />
              <DialogFooter>
                <Button onClick={submitReset} disabled={updateMutation.isPending}>
                  Save
                </Button>
              </DialogFooter>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
