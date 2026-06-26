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
  useListBranches, useCreateBranch, useDeleteBranch, getListBranchesQueryKey,
} from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { MapPin, Plus, Trash2, Search, Phone } from "lucide-react";

export default function Branches() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const [form, setForm] = useState({
    name: "", location: "", address: "", phone: "",
  });

  const { data: branches, isLoading } = useListBranches();
  const createMutation = useCreateBranch();
  const deleteMutation = useDeleteBranch();

  const filtered = (branches ?? []).filter(
    (b) =>
      b.name.toLowerCase().includes(search.toLowerCase()) ||
      (b.location ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (b.address ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  function openCreate() {
    setForm({ name: "", location: "", address: "", phone: "" });
    setShowDialog(true);
  }

  async function handleCreate() {
    if (!form.name.trim()) {
      toast({ title: "Branch name is required", variant: "destructive" });
      return;
    }
    try {
      await createMutation.mutateAsync({
        name: form.name.trim(),
        location: form.location.trim() || undefined,
        address: form.address.trim() || undefined,
        phone: form.phone.trim() || undefined,
      });
    } catch {
      toast({ title: "Failed to create branch", variant: "destructive" });
      return;
    }
    toast({ title: "Branch created" });
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
                  <div className="shrink-0">
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

      {/* Create Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Add Branch</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
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
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={createMutation.isPending}>
              {createMutation.isPending ? "Adding…" : "Add Branch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </HrLayout>
  );
}
