import { useState } from "react";
import { Fingerprint, Pencil, Power, Trash2, TriangleAlert } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  useDeleteBiometricDevice,
  useUpdateBiometricDevice,
  type BiometricDeviceItem,
} from "@/lib/api-client/custom-hooks";
import { DeviceFields } from "./DeviceFields";
import {
  addressText,
  deviceFormFrom,
  deviceProblems,
  deviceTypeLabel,
  hasProblems,
  updateBody,
  type DeviceErrors,
  type DeviceForm,
} from "./deviceForm";

/** What switching a device off does (said in the confirm, so it is read before it happens). */
const DISABLE_EFFECTS = [
  "Sync Biometric on the Attendance page stops offering it, 'All devices' skips it, and an Auto Sync rule that names only this device fails.",
  "Device Status marks it disabled and stops counting it as a problem; Device Control no longer reads, fetches or pushes to it.",
  "Punches the machine sends by itself (push) are still recorded.",
];
const REMOVE_EFFECTS = [
  "Its cached list of device users and its connection-check history are deleted with it.",
  "Its card disappears from Device Status and Device Control; pushes from its serial then show as an unknown sender.",
  "Auto Sync rules that name it fail until they are edited. Punches already recorded are kept.",
];

/** One device in the list: what it is and how it is reached, and its edit / switch off / remove actions. */
export function DeviceRow({
  device,
  connectors,
  editing,
  onEdit,
}: {
  device: BiometricDeviceItem;
  connectors: { id: number; name: string }[];
  editing: boolean;
  onEdit: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const update = useUpdateBiometricDevice();
  const remove = useDeleteBiometricDevice();
  const [form, setForm] = useState<DeviceForm | null>(null);
  const [errors, setErrors] = useState<DeviceErrors>({});
  const [confirm, setConfirm] = useState<"disable" | "remove" | null>(null);
  const id = typeof device.id === "number" ? device.id : null;
  const connectorName = connectors.find((c) => c.id === device.connectorId)?.name;

  const startEdit = () => {
    setForm(deviceFormFrom(device));
    setErrors({});
    onEdit(true);
  };

  const save = async () => {
    if (id === null || !form) return;
    const problems = deviceProblems(form);
    setErrors(problems);
    if (hasProblems(problems)) {
      toast({ title: "Check the device details", description: Object.values(problems)[0], variant: "destructive" });
      return;
    }
    try {
      await update.mutateAsync({ id, data: updateBody(form, deviceFormFrom(device)) });
      toast({ title: "Device updated" });
      onEdit(false);
    } catch (e) {
      toast({
        title: "Failed to update device",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const setActive = async (active: boolean) => {
    if (id === null) return;
    setConfirm(null);
    try {
      await update.mutateAsync({ id, data: { isActive: active } });
      toast({ title: active ? `${device.name} enabled` : `${device.name} disabled` });
    } catch (e) {
      toast({
        title: "Could not change the device",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const removeDevice = async () => {
    if (id === null) return;
    setConfirm(null);
    try {
      await remove.mutateAsync(id);
      toast({ title: `${device.name} removed` });
    } catch (e) {
      toast({
        title: "Could not remove the device",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <div className="settings-glass overflow-hidden rounded-xl border" data-testid={`settings-device-${device.id}`}>
      <div className="flex items-center gap-3 p-3">
        <div
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${device.isActive ? "bg-cyan-50" : "bg-gray-100"}`}
        >
          <Fingerprint size={16} className={device.isActive ? "text-cyan-600" : "text-gray-400"} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-bold text-gray-800">{device.name}</p>
            {device.isEnv && (
              <span className="rounded-full bg-blue-100 px-1.5 py-0.5 text-[10px] font-bold text-blue-700">.env</span>
            )}
            {!device.isActive && (
              <span className="rounded-full bg-gray-100 px-1.5 py-0.5 text-[10px] font-bold text-gray-500">
                Disabled
              </span>
            )}
          </div>
          <p className="break-words text-[11px] text-gray-500">
            {deviceTypeLabel(device.deviceType)} · {addressText(device.host, device.port)}
            {device.serialNumber ? ` · ${device.serialNumber}` : " · no serial yet"}
            {device.connectorId ? ` · via site connector ${connectorName ?? "#" + device.connectorId}` : ""}
            {device.isEnv ? " · configured in backend/.env" : ""}
          </p>
          {device.notes && !device.isEnv && <p className="text-[11px] italic text-gray-400">{device.notes}</p>}
        </div>
        {id !== null && !device.isEnv && (
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => (editing ? onEdit(false) : startEdit())}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-cyan-50 hover:text-cyan-600"
              title="Edit connection and details"
              aria-label={`Edit connection and details of ${device.name}`}
            >
              <Pencil size={13} />
            </button>
            <button
              type="button"
              onClick={() => (device.isActive ? setConfirm("disable") : void setActive(true))}
              disabled={update.isPending}
              className={`rounded-lg p-1.5 hover:bg-gray-50 ${device.isActive ? "text-green-600" : "text-gray-400"}`}
              title={device.isActive ? "Disable device" : "Enable device"}
              aria-label={`${device.isActive ? "Disable" : "Enable"} ${device.name}`}
            >
              <Power size={13} />
            </button>
            <button
              type="button"
              onClick={() => setConfirm("remove")}
              disabled={remove.isPending}
              className="rounded-lg p-1.5 text-gray-300 hover:bg-red-50 hover:text-red-500"
              title="Remove device"
              aria-label={`Remove ${device.name}`}
            >
              <Trash2 size={13} />
            </button>
          </div>
        )}
      </div>

      {editing && form && id !== null && (
        <div className="settings-divide space-y-3 border-t p-3" data-testid={`edit-device-panel-${id}`}>
          <DeviceFields
            idPrefix={`edit-device-${id}`}
            value={form}
            onChange={(patch) => setForm((f) => (f ? { ...f, ...patch } : f))}
            errors={errors}
            connectors={connectors}
            serialTestId="edit-device-serial"
            connectorTestId={`edit-device-connector-${id}`}
          />
          <div className="flex gap-2">
            <Button size="sm" onClick={() => void save()} disabled={update.isPending}>
              {update.isPending ? "Saving…" : "Save Connection"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onEdit(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent data-testid={`confirm-${confirm ?? "device"}-device`}>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert size={18} className="text-amber-500" />
              {confirm === "remove" ? `Remove ${device.name}?` : `Switch ${device.name} off?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "remove"
                ? "This deletes the device entry for good. It cannot be undone."
                : "The device entry is kept and can be switched on again at any time."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <ul className="space-y-1 text-[12px] leading-snug text-gray-600">
            {(confirm === "remove" ? REMOVE_EFFECTS : DISABLE_EFFECTS).map((line) => (
              <li key={line} className="flex gap-1.5">
                <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-gray-400" />
                <span>{line}</span>
              </li>
            ))}
          </ul>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className={confirm === "remove" ? "bg-red-600 hover:bg-red-700" : undefined}
              onClick={() => void (confirm === "remove" ? removeDevice() : setActive(false))}
              data-testid="confirm-device-action"
            >
              {confirm === "remove" ? "Remove device" : "Disable device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
