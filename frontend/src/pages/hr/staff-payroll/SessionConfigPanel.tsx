import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Edit, Plus, Settings, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldLoader } from "@/components/ui/ShieldLoader";
import { useToast } from "@/hooks/use-toast";
import {
  getSessionConfigsQueryKey,
  useCreateSessionConfig,
  useDeleteSessionConfig,
  useSessionConfigs,
  useUpdateSessionConfig,
  type SessionConfigItem,
} from "@/lib/api-client";

// Settings -> legacy session config of the old session-based production pay. Moved out of StaffPayroll.tsx unchanged;
// it only affects historical payroll records still shown in the old session format.

export function SessionConfigPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: configs, isLoading } = useSessionConfigs();
  const createMutation = useCreateSessionConfig();
  const updateMutation = useUpdateSessionConfig();
  const deleteMutation = useDeleteSessionConfig();

  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [form, setForm] = useState({
    name: "",
    startTime: "08:30",
    endTime: "12:40",
    minimumCheckoutTime: "12:40",
    payAmount: "",
    order: "1",
  });

  const resetForm = () =>
    setForm({
      name: "",
      startTime: "08:30",
      endTime: "12:40",
      minimumCheckoutTime: "12:40",
      payAmount: "",
      order: "1",
    });

  const handleSave = async () => {
    if (!form.name || !form.payAmount) {
      toast({ title: "Name and pay amount are required", variant: "destructive" });
      return;
    }
    try {
      if (editId) {
        await updateMutation.mutateAsync({
          id: editId,
          data: {
            name: form.name,
            startTime: form.startTime,
            endTime: form.endTime,
            minimumCheckoutTime: form.minimumCheckoutTime || null,
            payAmount: Number(form.payAmount),
            order: Number(form.order),
          },
        });
        setEditId(null);
      } else {
        await createMutation.mutateAsync({
          name: form.name,
          startTime: form.startTime,
          endTime: form.endTime,
          minimumCheckoutTime: form.minimumCheckoutTime || null,
          payAmount: Number(form.payAmount),
          order: Number(form.order),
        });
        setShowAdd(false);
      }
      resetForm();
      queryClient.invalidateQueries({ queryKey: getSessionConfigsQueryKey() });
      toast({ title: editId ? "Session updated" : "Session created" });
    } catch {
      toast({ title: "Failed to save session config", variant: "destructive" });
    }
  };

  const handleEdit = (sc: SessionConfigItem) => {
    setEditId(sc.id);
    setShowAdd(false);
    setForm({
      name: sc.name,
      startTime: sc.startTime,
      endTime: sc.endTime,
      minimumCheckoutTime: sc.minimumCheckoutTime ?? "",
      payAmount: String(sc.payAmount),
      order: String(sc.order),
    });
  };

  const handleDelete = async (id: number) => {
    try {
      await deleteMutation.mutateAsync(id);
      queryClient.invalidateQueries({ queryKey: getSessionConfigsQueryKey() });
      toast({ title: "Session deleted" });
    } catch {
      toast({ title: "Failed to delete session config", variant: "destructive" });
    }
  };

  const formFields = (
    <div className="grid sm:grid-cols-2 gap-3 mt-3">
      <div className="space-y-1">
        <Label className="text-xs">Session Name</Label>
        <Input
          value={form.name}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
          placeholder="e.g. Morning Session"
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Pay Amount (₹)</Label>
        <Input
          type="number"
          value={form.payAmount}
          onChange={(e) => setForm((f) => ({ ...f, payAmount: e.target.value }))}
          placeholder="e.g. 150"
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Start Time</Label>
        <Input
          type="time"
          value={form.startTime}
          onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">End Time</Label>
        <Input
          type="time"
          value={form.endTime}
          onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Min. Checkout Time</Label>
        <Input
          type="time"
          value={form.minimumCheckoutTime}
          onChange={(e) => setForm((f) => ({ ...f, minimumCheckoutTime: e.target.value }))}
          className="h-8 text-sm"
        />
        <p className="text-xs text-muted-foreground">Session only counts if employee leaves after this time</p>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">Order</Label>
        <Input
          type="number"
          value={form.order}
          onChange={(e) => setForm((f) => ({ ...f, order: e.target.value }))}
          className="h-8 text-sm"
          min={1}
        />
      </div>
      <div className="sm:col-span-2 flex gap-2">
        <Button
          size="sm"
          onClick={handleSave}
          disabled={createMutation.isPending || updateMutation.isPending}
          className="gap-1.5"
        >
          <CheckCircle2 size={13} />
          {editId ? "Update Session" : "Add Session"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setShowAdd(false);
            setEditId(null);
            resetForm();
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  return (
    <Card className="border-0 shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Settings size={15} className="text-amber-600" />
            <CardTitle className="text-sm font-bold text-gray-900">Legacy Session Config</CardTitle>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => {
              setShowAdd((s) => !s);
              setEditId(null);
              resetForm();
            }}
          >
            <Plus size={12} /> Add Session
          </Button>
        </div>
        <p className="text-xs text-muted-foreground mt-0.5">
          Not used by current production payroll -pay is now Total Shifts × Salary Per Shift (set shift segments and
          punch times in Manage Shifts). This panel only affects historical payroll records still shown in the old
          session format.
        </p>
      </CardHeader>
      <CardContent className="pt-0 space-y-2">
        {showAdd && (
          <div className="rounded-lg border border-dashed border-amber-300 bg-amber-50/40 p-3">{formFields}</div>
        )}
        {isLoading ? (
          <ShieldLoader />
        ) : (configs ?? []).length === 0 ? (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-gray-50 border border-gray-100">
            <AlertCircle size={14} className="text-gray-400 mt-0.5 shrink-0" />
            <p className="text-xs text-gray-500">
              No legacy sessions configured -nothing to do here. Current production payroll doesn't need this.
            </p>
          </div>
        ) : (
          (configs ?? []).map((sc) => (
            <div key={sc.id}>
              {editId === sc.id ? (
                <div className="rounded-lg border border-dashed border-blue-300 bg-blue-50/40 p-3">{formFields}</div>
              ) : (
                <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-amber-50/60 border border-amber-100">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm text-amber-900">{sc.name}</span>
                      <Badge className="text-xs bg-amber-100 text-amber-700 border-amber-200">
                        ₹{sc.payAmount}/session
                      </Badge>
                    </div>
                    <p className="text-xs text-amber-700 mt-0.5">
                      {sc.startTime} – {sc.endTime}
                      {sc.minimumCheckoutTime && (
                        <>
                          {" "}
                          · Min checkout: <strong>{sc.minimumCheckoutTime}</strong>
                        </>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-gray-400 hover:text-gray-700"
                      onClick={() => handleEdit(sc)}
                    >
                      <Edit size={13} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-red-400 hover:text-red-600"
                      onClick={() => handleDelete(sc.id)}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
