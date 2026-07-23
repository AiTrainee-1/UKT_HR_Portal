import { useState } from "react";
import HrLayout from "@/components/HrLayout";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  useListBranches, useCreateBranch, useUpdateBranch, useDeleteBranch, getListBranchesQueryKey,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { MapPin, Plus, Trash2, Pencil, Search, Phone, Building2, Navigation } from "lucide-react";
import GeofencePicker from "@/components/geo/GeofencePicker";

const EMPTY_FORM = {
  name: "", code: "", location: "", address: "", phone: "", isHeadOffice: false,
  geofenceLat: null as number | null, geofenceLng: null as number | null, geofenceRadiusM: 200,
};

export default function Branches() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);

  const { data: branches, isLoading } = useListBranches();
  const createMutation = useCreateBranch();
  const updateMutation = useUpdateBranch();
  const deleteMutation = useDeleteBranch();
  const isSaving = createMutation.isPending || updateMutation.isPending;

  const filtered = (branches ?? []).filter(
    (b) =>
      b.name.toLowerCase().includes(search.toLowerCase()) ||
      (b.location ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (b.address ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  function openCreate() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowDialog(true);
  }

  function openEdit(b: NonNullable<typeof branches>[number]) {
    setEditingId(b.id);
    setForm({
      name: b.name,
      code: b.code ?? "",
      location: b.location ?? "",
      address: b.address ?? "",
      phone: b.phone ?? "",
      isHeadOffice: b.isHeadOffice,
      geofenceLat: b.geofenceLat ?? null,
      geofenceLng: b.geofenceLng ?? null,
      geofenceRadiusM: b.geofenceRadiusM ?? 200,
    });
    setShowDialog(true);
  }

  async function handleSave() {
    if (!form.name.trim()) {
      toast({ title: "Branch name is required", variant: "destructive" });
      return;
    }
    const payload = {
      name: form.name.trim(),
      code: form.code.trim() || undefined,
      location: form.location.trim() || undefined,
      address: form.address.trim() || undefined,
      phone: form.phone.trim() || undefined,
      isHeadOffice: form.isHeadOffice,
      geofenceLat: form.geofenceLat,
      geofenceLng: form.geofenceLng,
      geofenceRadiusM: form.geofenceRadiusM,
    };
    try {
      if (editingId) {
        await updateMutation.mutateAsync({ id: editingId, data: payload });
      } else {
        await createMutation.mutateAsync(payload);
      }
    } catch {
      toast({ title: editingId ? "Failed to update branch" : "Failed to create branch", variant: "destructive" });
      return;
    }
    toast({ title: editingId ? "Branch updated" : "Branch created" });
    setShowDialog(false);
    queryClient.invalidateQueries({ queryKey: getListBranchesQueryKey() });
  }

  async function handleDelete(id: number) {
    try {
      await deleteMutation.mutateAsync(id);
    } catch {
      toast({ title: "Failed to delete branch", variant: "destructive" });
      return;
    }
    toast({ title: "Branch deleted" });
    queryClient.invalidateQueries({ queryKey: getListBranchesQueryKey() });
  }

  return (
    <HrLayout>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-2xl font-black text-gray-900">Manage Branch</h2>
            <p className="text-muted-foreground text-sm mt-0.5">
              Manage company locations and branch offices
            </p>
          </div>
          <Button onClick={openCreate} className="gap-2 self-start sm:self-auto">
            <Plus size={16} /> Add Branch
          </Button>
        </div>

        {/* Search */}
        <div className="relative max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search branches…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Summary */}
        <div className="grid grid-cols-2 gap-3 max-w-xs">
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Total</p>
              <p className="text-2xl font-black text-teal-600 mt-0.5">{branches?.length ?? 0}</p>
            </CardContent>
          </Card>
          <Card className="border-0 shadow-sm">
            <CardContent className="p-4">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Locations</p>
              <p className="text-2xl font-black text-gray-700 mt-0.5">
                {new Set((branches ?? []).map((b) => b.location).filter(Boolean)).size}
              </p>
            </CardContent>
          </Card>
        </div>

        {/* List */}
        <div className="grid gap-3">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Card key={i} className="border-0 shadow-sm">
                <CardContent className="p-4">
                  <Skeleton className="h-5 w-40 mb-2" />
                  <Skeleton className="h-4 w-64" />
                </CardContent>
              </Card>
            ))
          ) : filtered.length === 0 ? (
            <Card className="border-0 shadow-sm">
              <CardContent className="p-10 flex flex-col items-center text-center">
                <MapPin size={32} className="text-muted-foreground/30 mb-3" />
                <p className="font-semibold text-gray-700">
                  {search ? "No branches match your search" : "No branches yet"}
                </p>
                {!search && (
                  <p className="text-sm text-muted-foreground mt-1">
                    Add your first branch to get started.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : (
            filtered.map((b) => (
              <Card key={b.id} className="border-0 shadow-sm hover:shadow-md transition-shadow">
                <CardContent className="p-4 flex items-start gap-4">
                  <div
                    className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 mt-0.5"
                    style={{ background: "linear-gradient(135deg, #0f766e, #06b6d4)" }}
                  >
                    <MapPin size={18} className="text-white" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="font-bold text-gray-900">{b.name}</p>
                      {b.code && (
                        <span className="text-[11px] font-mono font-semibold text-teal-700 bg-teal-50 px-1.5 py-0.5 rounded">
                          {b.code}
                        </span>
                      )}
                      {b.isHeadOffice && (
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">
                          <Building2 size={10} /> Head Office
                        </span>
                      )}
                      {b.geofenceLat != null ? (
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-teal-700 bg-teal-50 px-1.5 py-0.5 rounded">
                          <Navigation size={10} /> Geofence set ({b.geofenceRadiusM ?? 200}m)
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-[11px] font-semibold text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded">
                          <Navigation size={10} /> No location set
                        </span>
                      )}
                      {b.location && (
                        <span className="text-sm text-muted-foreground">{b.location}</span>
                      )}
                    </div>
                    {b.address && (
                      <p className="text-sm text-muted-foreground mt-1 truncate">{b.address}</p>
                    )}
                    {b.phone && (
                      <span className="flex items-center gap-1.5 text-xs text-muted-foreground mt-2">
                        <Phone size={11} /> {b.phone}
                      </span>
                    )}
                  </div>
                  <div className="shrink-0 flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground hover:text-teal-700 hover:bg-teal-50"
                      onClick={() => openEdit(b)}
                      title="Edit"
                    >
                      <Pencil size={15} />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-red-600 hover:bg-red-50"
                          disabled={deleteMutation.isPending}
                          title="Delete"
                        >
                          <Trash2 size={15} />
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Delete branch?</AlertDialogTitle>
                          <AlertDialogDescription>
                            This will permanently remove <strong>{b.name}</strong>.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>Cancel</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={() => handleDelete(b.id)}
                            className="bg-red-600 hover:bg-red-700"
                          >
                            Delete
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      {/* Create / Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Branch" : "Add Branch"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label htmlFor="br-name">Branch Name <span className="text-red-500">*</span></Label>
                <Input
                  id="br-name"
                  placeholder="e.g. Surat Branch"
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  autoFocus
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="br-code">Code</Label>
                <Input
                  id="br-code"
                  placeholder="e.g. U2"
                  value={form.code}
                  onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="br-location">Location / City</Label>
              <Input
                id="br-location"
                placeholder="e.g. Surat"
                value={form.location}
                onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="br-address">Address</Label>
              <Input
                id="br-address"
                placeholder="Full address"
                value={form.address}
                onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="br-phone">Phone</Label>
              <Input
                id="br-phone"
                placeholder="+91 …"
                value={form.phone}
                onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              />
            </div>
            <label htmlFor="br-ho" className="flex items-start gap-2.5 rounded-lg border p-3 cursor-pointer">
              <input
                id="br-ho"
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-teal-600"
                checked={form.isHeadOffice}
                onChange={(e) => setForm((f) => ({ ...f, isHeadOffice: e.target.checked }))}
              />
              <span>
                <span className="block text-sm font-medium text-gray-900">Head Office</span>
                <span className="block text-xs text-muted-foreground mt-0.5">
                  The default branch existing employees and departments belong to. Only one branch can be Head Office — marking this one unmarks any other.
                </span>
              </span>
            </label>

            <div className="space-y-2 rounded-lg border p-3">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1.5">
                  <Navigation size={13} className="text-teal-700" /> Attendance Location (Geofence)
                </Label>
                {form.geofenceLat != null && (
                  <button
                    type="button"
                    className="text-[11px] text-red-500 hover:underline"
                    onClick={() => setForm((f) => ({ ...f, geofenceLat: null, geofenceLng: null }))}
                  >
                    Clear
                  </button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                Click the map to set this branch's location. Employees inside the radius below can mark attendance
                from the mobile or web app; outside it, they'll need photo + Department-Head approval.
              </p>
              <GeofencePicker
                key={editingId ?? "new"}
                lat={form.geofenceLat}
                lng={form.geofenceLng}
                radiusM={form.geofenceRadiusM}
                onPick={(lat, lng) => setForm((f) => ({ ...f, geofenceLat: lat, geofenceLng: lng }))}
              />
              {form.geofenceLat != null && (
                <div className="grid grid-cols-2 gap-3 items-end">
                  <div className="text-xs text-muted-foreground font-mono">
                    {form.geofenceLat.toFixed(6)}, {form.geofenceLng!.toFixed(6)}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="br-radius" className="text-xs">Radius (meters)</Label>
                    <Input
                      id="br-radius"
                      type="number"
                      min={20}
                      max={2000}
                      value={form.geofenceRadiusM}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, geofenceRadiusM: Math.max(20, Number(e.target.value) || 200) }))
                      }
                      className="h-8"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving…" : editingId ? "Save Changes" : "Add Branch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
