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
  useListGateDevices,
  getListGateDevicesQueryKey,
  useCreateGateDevice,
  useUpdateGateDevice,
  useDeleteGateDevice,
  type GateDevice,
} from "@/lib/api-client/custom-hooks";
import { Copy, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";

// ── Gate Scanner device management ─────────────────────────────────────────
// A GateDevice is a completely different concept from the GateQrDialog: that
// one is a permanent, unauthenticated QR for the entry form; this is a real
// username/password login for a kiosk that scans an *approved* Outpass's own
// QR (see the Passes list of Outpass > Overview) and records the employee's
// exit. See backend/api/gate_scanner_views.py.

function GateDeviceRow({
  gate,
  onToggleActive,
  onResetPassword,
  onDelete,
  isMutating,
}: {
  gate: GateDevice;
  onToggleActive: (gate: GateDevice, next: boolean) => void;
  onResetPassword: (gate: GateDevice) => void;
  onDelete: (gate: GateDevice) => void;
  isMutating: boolean;
}) {
  const { toast } = useToast();
  const loginUrl = `${window.location.origin}/gate-scanner/${gate.loginToken}`;

  const copyLink = () => {
    navigator.clipboard.writeText(loginUrl);
    toast({ title: "Login link copied" });
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-semibold">{gate.name}</p>
          <Badge
            variant={gate.isActive ? "default" : "secondary"}
            className={`text-[10px] ${gate.isActive ? "!bg-green-100 !text-green-700" : ""}`}
          >
            {gate.isActive ? "Active" : "Deactivated"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          {gate.branchName ?? "No branch"} · Username: <span className="font-mono">{gate.username}</span>
          {gate.lastLoginAt &&
            ` · Last login ${new Date(gate.lastLoginAt).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`}
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
          onClick={() => onResetPassword(gate)}
          disabled={isMutating}
        >
          <KeyRound size={12} /> Reset Password
        </Button>
        <Switch checked={gate.isActive} onCheckedChange={(v) => onToggleActive(gate, v)} disabled={isMutating} />
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs px-2 text-red-600 border-red-200 hover:bg-red-50"
          onClick={() => onDelete(gate)}
          disabled={isMutating}
        >
          <Trash2 size={12} />
        </Button>
      </div>
    </div>
  );
}

export function GateDevicesDialog({
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
  const [resetTarget, setResetTarget] = useState<GateDevice | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  const { data: gates, isLoading } = useListGateDevices();
  const createMutation = useCreateGateDevice();
  const updateMutation = useUpdateGateDevice();
  const deleteMutation = useDeleteGateDevice();

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListGateDevicesQueryKey() });

  const handleCreate = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (form.name.trim().length < 1) return setFormError("Gate name is required.");
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
      setFormError(err?.message ?? "Could not create gate profile");
    }
  };

  const toggleActive = async (gate: GateDevice, next: boolean) => {
    await updateMutation.mutateAsync({ id: gate.id, data: { isActive: next } });
    toast({ title: next ? `${gate.name} reactivated` : `${gate.name} deactivated` });
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

  const handleDelete = async (gate: GateDevice) => {
    if (!confirm(`Remove ${gate.name}? Its scan history is kept, but its login will stop working immediately.`)) return;
    await deleteMutation.mutateAsync(gate.id);
    toast({ title: `${gate.name} removed` });
    invalidate();
  };

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
          <ShieldCheck size={14} /> Manage Gates
        </Button>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Gate Scanner Devices</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-1 max-h-[70vh] overflow-y-auto">
            <div className="flex flex-col gap-2">
              {isLoading ? (
                <p className="text-sm text-muted-foreground py-4 text-center">Loading…</p>
              ) : !gates?.length ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No gates created yet.</p>
              ) : (
                gates.map((g) => (
                  <GateDeviceRow
                    key={g.id}
                    gate={g}
                    onToggleActive={toggleActive}
                    onResetPassword={(gate) => setResetTarget(gate)}
                    onDelete={handleDelete}
                    isMutating={updateMutation.isPending || deleteMutation.isPending}
                  />
                ))
              )}
            </div>

            <form onSubmit={handleCreate} className="flex flex-col gap-3 rounded-xl border p-3">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Add a Gate</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="gate-name">Gate Name</Label>
                  <Input
                    id="gate-name"
                    placeholder="Gate 1"
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
                  <Label htmlFor="gate-username">Username</Label>
                  <Input
                    id="gate-username"
                    value={form.username}
                    onChange={(e) => setForm((f) => ({ ...f, username: e.target.value }))}
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="gate-password">Password</Label>
                  <Input
                    id="gate-password"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                  />
                </div>
              </div>
              {formError && <p className="text-sm text-destructive">{formError}</p>}
              <Button type="submit" className="gap-1.5" disabled={createMutation.isPending}>
                <Plus size={14} /> {createMutation.isPending ? "Creating…" : "Create Gate"}
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
