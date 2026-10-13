import { useState } from "react";
import { Fingerprint, Plus, Radar } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useConnectors, useCreateBiometricDevice, useListBiometricDevices } from "@/lib/api-client/custom-hooks";
import { ManagedElsewhere, SettingsSection } from "./kit/SettingBlock";
import { TabContents } from "./attendance/TabContents";
import { DeviceFields } from "./devices/DeviceFields";
import { DeviceRow } from "./devices/DeviceRow";
import {
  EMPTY_DEVICE,
  createBody,
  deviceProblems,
  hasProblems,
  type DeviceErrors,
  type DeviceForm,
} from "./devices/deviceForm";
import { FieldGuide } from "./devices/FieldGuide";

const CONTENTS = [
  { id: "devices-list", label: "Devices" },
  { id: "devices-elsewhere", label: "Watching and operating" },
  { id: "device-field-guide", label: "What each field does" },
];

/**
 * Settings -> Devices: the biometric machines the portal reads punches from or receives them from. Watching them
 * (Device Status) and operating them (Device Control) are separate pages; this tab only says which machines exist and
 * how each is reached.
 */
export default function DevicesTab() {
  const { toast } = useToast();
  const { data: devices, isLoading } = useListBiometricDevices();
  // a role without Attendance access cannot list connectors: then the choice is simply not offered
  const connectors = useConnectors().data?.connectors ?? [];
  const create = useCreateBiometricDevice();

  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<DeviceForm>(EMPTY_DEVICE);
  const [errors, setErrors] = useState<DeviceErrors>({});
  const [editingId, setEditingId] = useState<number | string | null>(null);

  const addDevice = async () => {
    const problems = deviceProblems(form);
    setErrors(problems);
    if (problems.name) {
      toast({ title: "Device name is required", variant: "destructive" });
      return;
    }
    if (hasProblems(problems)) {
      toast({ title: "Check the device details", description: Object.values(problems)[0], variant: "destructive" });
      return;
    }
    try {
      await create.mutateAsync(createBody(form));
      toast({ title: "Device added" });
      setForm(EMPTY_DEVICE);
      setErrors({});
      setAdding(false);
    } catch (e) {
      toast({
        title: "Failed to add device",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const list = devices ?? [];

  return (
    <div className="space-y-4">
      <TabContents items={CONTENTS} />

      <SettingsSection
        id="devices-list"
        icon={Fingerprint}
        title="Biometric / Punching Devices"
        purpose="The machines the portal gets punches from: it reads them from each machine's address (Sync Biometric and Auto Sync on the Attendance page, or a Site Connector), and it accepts the punches a machine sends by itself, matched by its serial number."
        usedBy={[
          { label: "Staff Attendance sync", to: "/hr/attendance/staff" },
          { label: "Device Status", to: "/hr/Biometric-Connectors/device-status" },
          { label: "Device Control", to: "/hr/Biometric-Connectors/DeviceControl" },
        ]}
        testId="devices-list"
      >
        <div className="mt-3 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="min-w-0 flex-1 basis-72 text-[12px] leading-relaxed text-gray-600">
              The device set up on the server itself (blue <b>.env</b> badge) keeps working as before and can only be
              changed on the server; devices added here are extra. "All Devices" in Sync Biometric reads every enabled
              device plus the .env one. A device behind a Site Connector is not read by Sync Biometric: its connector
              sends the punches.
            </p>
            <Button size="sm" variant="outline" className="gap-1.5" onClick={() => setAdding((v) => !v)}>
              <Plus size={13} /> Add Device
            </Button>
          </div>

          {adding && (
            <div className="settings-glass space-y-3 rounded-2xl p-4" data-testid="add-device-form">
              <p className="text-sm font-bold text-gray-900">New device</p>
              <DeviceFields
                idPrefix="new-device"
                value={form}
                onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
                errors={errors}
                connectors={connectors}
                serialTestId="new-device-serial"
                connectorTestId="new-device-connector"
              />
              <div className="flex gap-2">
                <Button size="sm" onClick={() => void addDevice()} disabled={create.isPending}>
                  {create.isPending ? "Adding…" : "Save Device"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {isLoading ? (
            <p className="text-sm text-muted-foreground">Loading devices…</p>
          ) : list.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No devices configured yet.</p>
          ) : (
            <div className="space-y-2" data-testid="device-list">
              {list.map((d) => (
                <DeviceRow
                  key={d.id}
                  device={d}
                  connectors={connectors}
                  editing={editingId === d.id}
                  onEdit={(open) => setEditingId(open ? d.id : null)}
                />
              ))}
            </div>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        id="devices-elsewhere"
        icon={Radar}
        title="Where devices are watched and operated"
        purpose="This tab only says which machines exist and how each is reached. Everything else about them is on these pages."
        testId="devices-elsewhere"
      >
        <div className="mt-3 space-y-2">
          <ManagedElsewhere
            title="Watching them: Device Status"
            to="/hr/Biometric-Connectors/device-status"
            linkLabel="Open Device Status"
            testId="devices-status-link"
          >
            Whether each machine can be reached and is sending, its last data, punches today, machines that send but are
            not registered here, and a connection check you can run.
          </ManagedElsewhere>
          <ManagedElsewhere
            title="Operating them: Device Control"
            to="/hr/Biometric-Connectors/DeviceControl"
            linkLabel="Open Device Control"
            testId="devices-control-link"
          >
            The overview, reading users and data from a machine (Data Fetch), sending users to it (Data Push), and
            creating and pairing Site Connectors.
          </ManagedElsewhere>
          <ManagedElsewhere
            title="Pulling punches: Staff Attendance"
            to="/hr/attendance/staff"
            linkLabel="Open Staff Attendance"
            testId="devices-sync-link"
          >
            Sync Biometric (choose which devices to read now) and the Auto Sync rules that read them on a schedule.
          </ManagedElsewhere>
        </div>
      </SettingsSection>

      <FieldGuide />
    </div>
  );
}
