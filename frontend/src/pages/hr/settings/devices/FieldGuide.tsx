import type { ReactNode } from "react";
import { BookOpen, Fingerprint } from "lucide-react";
import { PreviewCard, PreviewLine, SettingBlock, SettingsSection } from "../kit/SettingBlock";

const STATUS = "/hr/Biometric-Connectors/device-status";
const CONTROL = "/hr/Biometric-Connectors/DeviceControl";
const CONNECTORS = "/hr/Biometric-Connectors/DeviceControl/connectors";
const ATTENDANCE = "/hr/attendance/staff";

/** A small drawing of where a value shows up, for blocks that only label something. */
function Sample({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2.5 rounded-lg bg-white p-2 text-[12px] ring-1 ring-slate-200">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-50">
        <Fingerprint size={15} className="text-cyan-600" />
      </span>
      <span className="min-w-0 leading-snug">{children}</span>
    </div>
  );
}

/**
 * What each field of a device really does, and which pages read it. The fields themselves are in the add form and the
 * edit panel above; this is where the page's search lands for each of them.
 */
export function FieldGuide() {
  return (
    <SettingsSection
      id="device-field-guide"
      icon={BookOpen}
      title="What each device field does"
      purpose="The same fields as the add form and the edit panel above, with what changes in the portal when they change."
      testId="device-field-guide"
    >
      <SettingBlock
        id="device-name"
        title="Device name"
        purpose="The name HR sees for this machine everywhere in the portal."
        affects={[
          { where: "Device Status and Device Control", what: "the card title", to: STATUS },
          {
            where: "Staff Attendance",
            what: "the Sync Biometric device checklist, the sync progress and the Auto Sync rule picker",
            to: ATTENDANCE,
          },
        ]}
        preview={
          <PreviewCard title="Where it shows">
            <Sample>
              <b>Main Gate Scanner</b>
              <span className="block text-gray-500">a card on Device Status, and a tick box in Sync Biometric</span>
            </Sample>
          </PreviewCard>
        }
      >
        <p className="text-[12px] text-gray-500">Set when the device is added; it can be changed in the edit panel.</p>
      </SettingBlock>

      <SettingBlock
        id="device-type"
        title="Device type"
        purpose="A label for the machine's model, shown beside its name. It does not change how the portal talks to the machine: every machine is read with the ZKTeco protocol, and every machine that pushes uses the same ADMS push."
        affects={[{ where: "Device Status and Device Control", what: "shown on the card only", to: STATUS }]}
        note="Choosing 'Generic HTTP API' does not give another way of connecting."
      >
        <p className="text-[12px] text-gray-500">AiFace-Mars, ZKTeco, eSSL, Generic HTTP API or Other.</p>
      </SettingBlock>

      <SettingBlock
        id="device-address"
        title="Host / IP address and port"
        purpose="Where the server (or its Site Connector) connects to read this machine's punches: its network address and TCP port. An empty port means 4370, the ZKTeco default."
        affects={[
          {
            where: "Attendance sync",
            what: "Sync Biometric and the Auto Sync rules pull from this address",
            to: ATTENDANCE,
          },
          {
            where: "Device Status",
            what: "the connection check pings the address, then tries the port and a handshake",
            to: STATUS,
          },
          { where: "Device Control", what: "reading users, fetching data and pushing to the machine", to: CONTROL },
        ]}
        note="A wrong address stops reading from this machine only (the others carry on); punches it pushes by itself still arrive. From a cloud server a factory address such as 192.168.x.x cannot be reached unless a Site Connector reads it. An entry with the same address as the server's own .env device replaces that device in the list and in syncs."
        preview={
          <PreviewCard title="Example" scenario="Host 192.168.1.201, port empty:">
            <PreviewLine label="The check pings" result="192.168.1.201" />
            <PreviewLine label="then connects to" result="192.168.1.201:4370" />
            <PreviewLine
              label="A machine set to port 81 or 8000"
              result="'not accepting this port' until they match"
              tone="warn"
            />
          </PreviewCard>
        }
      >
        <p className="text-[12px] text-gray-500">Leave the host empty for a machine that only pushes.</p>
      </SettingBlock>

      <SettingBlock
        id="device-comm-password"
        title="Comm password"
        purpose="The machine's Comm Key, needed to open the reading connection. Usually 0; digits only."
        affects={[
          {
            where: "Attendance sync",
            what: "a value that is not a number fails that device's sync with 'Comm password is not valid'",
            to: ATTENDANCE,
          },
          {
            where: "Device Status",
            what: "a key that does not match the machine shows as an authentication failure",
            to: STATUS,
          },
          { where: "Device Control", what: "uses it for every read and push", to: CONTROL },
        ]}
        note="It is kept as typed and anyone who can open this tab can read it back in the edit panel."
        preview={
          <PreviewCard title="Example">
            <PreviewLine label="Machine's Comm Key 123456, Settings 0" result="authentication failed" tone="bad" />
            <PreviewLine label="Both 0" result="connects" tone="good" />
          </PreviewCard>
        }
      >
        <p className="text-[12px] text-gray-500">Empty is the same as 0.</p>
      </SettingBlock>

      <SettingBlock
        id="device-serial"
        title="Serial number"
        purpose="Ties the punches and heartbeats the machine sends by itself (ADMS push) to this entry: a pushing machine identifies itself only by its serial number. Two devices cannot share one."
        affects={[
          {
            where: "Device Status",
            what: "connected or silent, last data, punches today, push delay; a serial it does not know is listed under unknown senders",
            to: STATUS,
          },
        ]}
        note="Left empty, it is filled in automatically by the first push seen while exactly one enabled device has no serial. Punches are recorded from every machine that pushes, registered here or not, so a wrong serial only makes this card look silent."
        preview={
          <PreviewCard title="Example">
            <PreviewLine
              label="Serial CQIK222560204 saved"
              result="the next push with SN=CQIK222560204 updates this card"
              tone="good"
            />
            <PreviewLine
              label="A typing mistake"
              result="the card looks silent; the machine is an unknown sender"
              tone="warn"
            />
          </PreviewCard>
        }
      >
        <p className="text-[12px] text-gray-500">It is on the machine's Cloud Server / ADMS screen.</p>
      </SettingBlock>

      <SettingBlock
        id="device-connect-via"
        title="Connect via"
        purpose="Who talks to the machine: the server itself, or a Site Connector (a small Windows service on a computer inside the factory network) when the server cannot reach it."
        affects={[
          {
            where: "Attendance sync",
            what: "a connector's devices are not pulled from the Attendance page: the connector sends their punches on its own schedule",
            to: ATTENDANCE,
          },
          {
            where: "Device Status and Device Control",
            what: "checks, reads and pushes are queued for the connector instead of made by the server",
            to: CONTROL,
          },
          {
            where: "Device Control - Site connectors",
            what: "lists the devices each connector serves",
            to: CONNECTORS,
          },
        ]}
        note="The choice appears only when Site Connectors exist and you can see them (it needs Attendance access). Connectors are created and paired in Device Control - Site connectors. While its connector is offline nothing is read from the machine; punches it pushes still arrive."
      >
        <p className="text-[12px] text-gray-500">Directly from the server, or Site connector: (name).</p>
      </SettingBlock>

      <SettingBlock
        id="device-notes"
        title="Notes"
        purpose="A free note for HR about this machine, such as where it hangs or who looks after it."
        affects={[{ where: "This list", what: "shown under the device; no other page reads it" }]}
      >
        <p className="text-[12px] text-gray-500">Optional.</p>
      </SettingBlock>

      <SettingBlock
        id="device-enabled"
        title="Enable or disable a device"
        purpose="Takes a machine out of the portal's reading and checks, or back into them, without deleting it."
        affects={[
          {
            where: "Attendance sync",
            what: "a disabled device is not offered, 'All devices' skips it, and an Auto Sync rule that names only it fails",
            to: ATTENDANCE,
          },
          { where: "Device Status", what: "marks it disabled and stops counting it as a problem", to: STATUS },
          { where: "Device Control", what: "no reading, fetching or pushing for it", to: CONTROL },
        ]}
        note="Punches the machine pushes by itself are still recorded. Switching off asks for a confirmation first; switching on is immediate."
      >
        <p className="text-[12px] text-gray-500">The power button on the device's row.</p>
      </SettingBlock>

      <SettingBlock
        id="device-remove"
        title="Remove a device"
        purpose="Deletes the device entry for good, with its cached list of device users and its connection-check history."
        tone="danger"
        affects={[
          {
            where: "Device Status and Device Control",
            what: "the card disappears; pushes from its serial then show as an unknown sender",
            to: STATUS,
          },
          { where: "Auto Sync rules", what: "a rule that names it fails until it is edited", to: ATTENDANCE },
        ]}
        note="Cannot be undone, so it asks first. Punches already recorded are kept, and new pushes from the machine are still recorded. The .env device cannot be removed here: it is set on the server."
      >
        <p className="text-[12px] text-gray-500">The bin button on the device's row.</p>
      </SettingBlock>
    </SettingsSection>
  );
}
