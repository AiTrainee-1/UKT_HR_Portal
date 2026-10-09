import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Fingerprint, Plus, Trash2, Power, Pencil } from "lucide-react";
import {
  useListBiometricDevices,
  useCreateBiometricDevice,
  useUpdateBiometricDevice,
  useDeleteBiometricDevice,
  useConnectors,
} from "@/lib/api-client/custom-hooks";

/** "Connect via": which Site Connector reaches a device the server cannot ("" = the server connects itself). */
function ConnectViaSelect({
  value,
  onChange,
  connectors,
  testId,
}: {
  value: string;
  onChange: (value: string) => void;
  connectors: { id: number; name: string }[];
  testId: string;
}) {
  if (connectors.length === 0) return null;
  return (
    <div className="space-y-1.5 sm:col-span-2">
      <Label className="text-xs" htmlFor={testId}>
        Connect via
      </Label>
      <select
        id={testId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-9 rounded-md border px-3 text-sm bg-background"
        data-testid={testId}
      >
        <option value="">Directly from the server</option>
        {connectors.map((c) => (
          <option key={c.id} value={String(c.id)}>
            Site connector: {c.name}
          </option>
        ))}
      </select>
      <p className="text-[11px] text-gray-400">
        Choose a Site Connector when the server cannot reach this device (it is on a factory network). The address above
        is then the device's address on that network (192.168.x.x), as the connector's computer sees it.
      </p>
    </div>
  );
}

export default function DevicesTab() {
  const { toast } = useToast();

  // ── Biometric devices ────────────────────────────────────────────────────
  const { data: devices, isLoading: devicesLoading } = useListBiometricDevices();
  // a role without Attendance access cannot list connectors: then the choice is simply not offered
  const connectorList = useConnectors().data?.connectors ?? [];
  const connectorName = (id?: number | null) => connectorList.find((c) => c.id === id)?.name;

  const createDevice = useCreateBiometricDevice();

  const updateDevice = useUpdateBiometricDevice();

  const deleteDevice = useDeleteBiometricDevice();

  const [showAddDevice, setShowAddDevice] = useState(false);

  const [newDevice, setNewDevice] = useState({
    name: "",
    deviceType: "aiface_mars",
    host: "",
    port: "",
    apiKey: "",
    password: "",
    serialNumber: "",
    notes: "",
    connectorId: "",
  });

  const [editingDeviceId, setEditingDeviceId] = useState<number | null>(null);

  const [editDevice, setEditDevice] = useState({ host: "", port: "", password: "", serialNumber: "", connectorId: "" });

  const startEditDevice = (d: {
    id: number;
    host: string;
    port: number | null;
    serialNumber?: string;
    connectorId?: number | null;
    connectionConfig?: Record<string, unknown>;
  }) => {
    setEditingDeviceId(d.id);
    setEditDevice({
      host: d.host ?? "",
      port: d.port ? String(d.port) : "",
      password: String((d.connectionConfig as any)?.password ?? ""),
      serialNumber: d.serialNumber ?? "",
      connectorId: d.connectorId ? String(d.connectorId) : "",
    });
  };

  const saveEditDevice = async (id: number) => {
    try {
      await updateDevice.mutateAsync({
        id,
        data: {
          host: editDevice.host,
          port: editDevice.port ? Number(editDevice.port) : null,
          serialNumber: editDevice.serialNumber.trim(),
          connectorId: editDevice.connectorId ? Number(editDevice.connectorId) : null,
          connectionConfig: { password: editDevice.password },
        } as any,
      });
      toast({ title: "Device updated" });
      setEditingDeviceId(null);
    } catch (e: any) {
      toast({ title: "Failed to update device", description: e?.message, variant: "destructive" });
    }
  };

  const addDevice = async () => {
    if (!newDevice.name.trim()) {
      toast({ title: "Device name is required", variant: "destructive" });
      return;
    }
    try {
      await createDevice.mutateAsync({
        name: newDevice.name,
        deviceType: newDevice.deviceType,
        host: newDevice.host || undefined,
        port: newDevice.port ? Number(newDevice.port) : undefined,
        apiKey: newDevice.apiKey || undefined,
        notes: newDevice.notes || undefined,
        serialNumber: newDevice.serialNumber.trim() || undefined,
        connectorId: newDevice.connectorId ? Number(newDevice.connectorId) : undefined,
        connectionConfig: newDevice.password ? { password: newDevice.password } : undefined,
      } as any);
      toast({ title: "Device added" });
      setNewDevice({
        name: "",
        deviceType: "aiface_mars",
        host: "",
        port: "",
        apiKey: "",
        password: "",
        serialNumber: "",
        notes: "",
        connectorId: "",
      });
      setShowAddDevice(false);
    } catch (e: any) {
      toast({ title: "Failed to add device", description: e?.message, variant: "destructive" });
    }
  };

  return (
    <>
      <Card className="border-0 shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-bold flex items-center gap-2">
              <Fingerprint size={15} className="text-cyan-500" /> Biometric / Punching Devices
            </CardTitle>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setShowAddDevice((v) => !v)}>
              <Plus size={13} /> Add Device
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-gray-500">
            Add and enable/disable additional attendance devices -supports employees working across multiple units or
            branches. The <strong>.env</strong>-configured device (blue badge) always keeps working exactly as before;
            devices added here are extra. When syncing attendance (Attendance page), HR picks which device to pull from,
            including "All Devices" to merge every enabled device plus the .env device.
          </p>

          {showAddDevice && (
            <div className="p-4 border-2 border-cyan-100 bg-cyan-50/40 rounded-xl space-y-3">
              <div className="grid sm:grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Device Name</Label>
                  <Input
                    value={newDevice.name}
                    onChange={(e) => setNewDevice((d) => ({ ...d, name: e.target.value }))}
                    placeholder="e.g. Main Gate Scanner"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Device Type</Label>
                  <select
                    value={newDevice.deviceType}
                    onChange={(e) => setNewDevice((d) => ({ ...d, deviceType: e.target.value }))}
                    className="w-full h-9 rounded-md border px-3 text-sm bg-background"
                  >
                    <option value="aiface_mars">AiFace-Mars</option>
                    <option value="zkteco">ZKTeco</option>
                    <option value="essl">eSSL</option>
                    <option value="generic_http">Generic HTTP API</option>
                    <option value="other">Other</option>
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Host / IP Address</Label>
                  <Input
                    value={newDevice.host}
                    onChange={(e) => setNewDevice((d) => ({ ...d, host: e.target.value }))}
                    placeholder="192.168.1.201"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Port</Label>
                  <Input
                    type="number"
                    value={newDevice.port}
                    onChange={(e) => setNewDevice((d) => ({ ...d, port: e.target.value }))}
                    placeholder="4370"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Comm Password (ZKTeco, optional)</Label>
                  <Input
                    type="password"
                    value={newDevice.password}
                    onChange={(e) => setNewDevice((d) => ({ ...d, password: e.target.value }))}
                    placeholder="0"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Serial Number (optional)</Label>
                  <Input
                    value={newDevice.serialNumber}
                    onChange={(e) => setNewDevice((d) => ({ ...d, serialNumber: e.target.value }))}
                    placeholder="shown on the device, e.g. CQIK222560204"
                    data-testid="new-device-serial"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">API Key / Token (optional)</Label>
                  <Input
                    type="password"
                    value={newDevice.apiKey}
                    onChange={(e) => setNewDevice((d) => ({ ...d, apiKey: e.target.value }))}
                  />
                </div>
                <ConnectViaSelect
                  value={newDevice.connectorId}
                  onChange={(v) => setNewDevice((d) => ({ ...d, connectorId: v }))}
                  connectors={connectorList}
                  testId="new-device-connector"
                />
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs">Notes</Label>
                  <Input
                    value={newDevice.notes}
                    onChange={(e) => setNewDevice((d) => ({ ...d, notes: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={addDevice} disabled={createDevice.isPending}>
                  {createDevice.isPending ? "Adding…" : "Save Device"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowAddDevice(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {devicesLoading ? (
            <p className="text-sm text-muted-foreground">Loading devices…</p>
          ) : (devices ?? []).length === 0 ? (
            <p className="text-sm text-center text-muted-foreground py-6">No devices configured yet.</p>
          ) : (
            <div className="space-y-2">
              {(devices ?? []).map((d) => (
                <div key={d.id} className="border rounded-xl overflow-hidden">
                  <div className="flex items-center gap-3 p-3">
                    <div
                      className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${d.isActive ? "bg-cyan-50" : "bg-gray-100"}`}
                    >
                      <Fingerprint size={16} className={d.isActive ? "text-cyan-600" : "text-gray-400"} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-bold text-gray-800">{d.name}</p>
                        {d.isEnv && (
                          <span className="text-[10px] font-bold text-blue-700 bg-blue-100 px-1.5 py-0.5 rounded-full">
                            .env
                          </span>
                        )}
                        {!d.isActive && (
                          <span className="text-[10px] font-bold text-gray-500 bg-gray-100 px-1.5 py-0.5 rounded-full">
                            Disabled
                          </span>
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400">
                        {d.deviceType} {d.host ? `· ${d.host}${d.port ? `:${d.port}` : ""}` : ""}
                        {d.serialNumber ? ` · ${d.serialNumber}` : ""}
                        {d.connectorId
                          ? ` · via site connector ${connectorName(d.connectorId) ?? "#" + d.connectorId}`
                          : ""}
                        {d.isEnv ? " · configured in backend/.env" : ""}
                      </p>
                    </div>
                    {typeof d.id === "number" && !d.isEnv && (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          onClick={() =>
                            editingDeviceId === d.id ? setEditingDeviceId(null) : startEditDevice(d as any)
                          }
                          className="p-1.5 rounded-lg text-gray-400 hover:text-cyan-600 hover:bg-cyan-50"
                          title="Edit connection (host, port, password)"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => updateDevice.mutate({ id: d.id as number, data: { isActive: !d.isActive } })}
                          className={`p-1.5 rounded-lg hover:bg-gray-50 ${d.isActive ? "text-green-600" : "text-gray-400"}`}
                          title={d.isActive ? "Disable device" : "Enable device"}
                        >
                          <Power size={13} />
                        </button>
                        <button
                          onClick={() => deleteDevice.mutate(d.id as number)}
                          className="p-1.5 rounded-lg text-gray-300 hover:text-red-500 hover:bg-red-50"
                          title="Remove device"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )}
                  </div>
                  {editingDeviceId === d.id && (
                    <div className="p-3 border-t bg-gray-50 grid sm:grid-cols-4 gap-3">
                      <div className="space-y-1.5">
                        <Label className="text-xs">Host / IP Address</Label>
                        <Input
                          value={editDevice.host}
                          onChange={(e) => setEditDevice((v) => ({ ...v, host: e.target.value }))}
                          placeholder="192.168.1.201"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Port</Label>
                        <Input
                          type="number"
                          value={editDevice.port}
                          onChange={(e) => setEditDevice((v) => ({ ...v, port: e.target.value }))}
                          placeholder="4370"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Comm Password (ZKTeco)</Label>
                        <Input
                          type="password"
                          value={editDevice.password}
                          onChange={(e) => setEditDevice((v) => ({ ...v, password: e.target.value }))}
                          placeholder="0"
                        />
                      </div>
                      <div className="space-y-1.5">
                        <Label className="text-xs">Serial Number</Label>
                        <Input
                          value={editDevice.serialNumber}
                          onChange={(e) => setEditDevice((v) => ({ ...v, serialNumber: e.target.value }))}
                          placeholder="CQIK222560204"
                          data-testid="edit-device-serial"
                        />
                      </div>
                      <div className="sm:col-span-4">
                        <ConnectViaSelect
                          value={editDevice.connectorId}
                          onChange={(v) => setEditDevice((e) => ({ ...e, connectorId: v }))}
                          connectors={connectorList}
                          testId={`edit-device-connector-${d.id}`}
                        />
                      </div>
                      <div className="sm:col-span-4 flex gap-2">
                        <Button
                          size="sm"
                          onClick={() => saveEditDevice(d.id as number)}
                          disabled={updateDevice.isPending}
                        >
                          {updateDevice.isPending ? "Saving…" : "Save Connection"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={() => setEditingDeviceId(null)}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
