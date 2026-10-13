import type { ReactNode } from "react";
import { Fingerprint, FlaskConical } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { DEVICE_TYPES, addressText, deviceTypeLabel, type DeviceErrors, type DeviceForm } from "./deviceForm";

function Row({
  label,
  htmlFor,
  hint,
  error,
  children,
  wide,
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={cn("space-y-1", wide && "sm:col-span-2")}>
      <Label htmlFor={htmlFor} className="text-xs font-semibold text-gray-700">
        {label}
      </Label>
      {children}
      {error ? (
        <p role="alert" className="text-[11px] font-medium text-red-600">
          {error}
        </p>
      ) : (
        hint && <p className="text-[11px] leading-snug text-gray-500">{hint}</p>
      )}
    </div>
  );
}

/**
 * The fields of one device, for the add form and the edit panel. Each says in one line what it really does; the
 * "What each field does" section below the list has the whole story.
 */
export function DeviceFields({
  idPrefix,
  value,
  onChange,
  errors,
  connectors,
  serialTestId,
  connectorTestId,
}: {
  idPrefix: string;
  value: DeviceForm;
  onChange: (patch: Partial<DeviceForm>) => void;
  errors: DeviceErrors;
  connectors: { id: number; name: string }[];
  serialTestId: string;
  connectorTestId: string;
}) {
  const id = (name: string) => `${idPrefix}-${name}`;
  const connectorName = connectors.find((c) => String(c.id) === value.connectorId)?.name;
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Row
          label="Device Name"
          htmlFor={id("name")}
          hint="What HR sees for this machine everywhere."
          error={errors.name}
        >
          <Input
            id={id("name")}
            value={value.name}
            onChange={(e) => onChange({ name: e.target.value })}
            placeholder="e.g. Main Gate Scanner"
          />
        </Row>
        <Row
          label="Device Type"
          htmlFor={id("type")}
          hint="A label only: every model is read the same way (ZKTeco protocol)."
        >
          <select
            id={id("type")}
            value={value.deviceType}
            onChange={(e) => onChange({ deviceType: e.target.value })}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            {DEVICE_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
            {!DEVICE_TYPES.some((t) => t.value === value.deviceType) && (
              <option value={value.deviceType}>{value.deviceType}</option>
            )}
          </select>
        </Row>
        <Row
          label="Host / IP Address"
          htmlFor={id("host")}
          hint="Where the machine is read from. Leave empty for a machine that only pushes."
          error={errors.host}
        >
          <Input
            id={id("host")}
            value={value.host}
            onChange={(e) => onChange({ host: e.target.value })}
            placeholder="192.168.1.201"
          />
        </Row>
        <Row label="Port" htmlFor={id("port")} hint="Empty means 4370, the ZKTeco default." error={errors.port}>
          <Input
            id={id("port")}
            type="number"
            min={1}
            max={65535}
            value={value.port}
            onChange={(e) => onChange({ port: e.target.value })}
            placeholder="4370"
          />
        </Row>
        <Row
          label="Comm Password (ZKTeco, optional)"
          htmlFor={id("password")}
          hint="The machine's Comm Key: digits only, usually 0. Empty means 0."
          error={errors.password}
        >
          <Input
            id={id("password")}
            type="password"
            autoComplete="off"
            inputMode="numeric"
            value={value.password}
            onChange={(e) => onChange({ password: e.target.value })}
            placeholder="0"
          />
        </Row>
        <Row
          label="Serial Number (optional)"
          htmlFor={id("serial")}
          hint="Links the punches the machine pushes to this entry. Filled in by its first push when left empty."
          error={errors.serialNumber}
        >
          <Input
            id={id("serial")}
            value={value.serialNumber}
            onChange={(e) => onChange({ serialNumber: e.target.value })}
            placeholder="shown on the device, e.g. CQIK222560204"
            data-testid={serialTestId}
          />
        </Row>
        {connectors.length > 0 && (
          <Row
            label="Connect via"
            htmlFor={connectorTestId}
            wide
            hint="Choose a Site Connector when the server cannot reach this machine (it is on a factory network). The address above is then the machine's address on that network (192.168.x.x), as the connector's computer sees it."
          >
            <select
              id={connectorTestId}
              value={value.connectorId}
              onChange={(e) => onChange({ connectorId: e.target.value })}
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              data-testid={connectorTestId}
            >
              <option value="">Directly from the server</option>
              {connectors.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  Site connector: {c.name}
                </option>
              ))}
            </select>
          </Row>
        )}
        <Row label="Notes" htmlFor={id("notes")} wide hint="For HR only: shown under the device in this list.">
          <Input id={id("notes")} value={value.notes} onChange={(e) => onChange({ notes: e.target.value })} />
        </Row>
      </div>

      <div className="rounded-lg bg-blue-50/70 p-2.5" data-testid={`${idPrefix}-preview`}>
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-blue-600">
          <FlaskConical size={12} /> How it will look on Device Status
        </p>
        <div className="mt-1.5 flex items-center gap-2.5 rounded-lg bg-white p-2 ring-1 ring-blue-100">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-cyan-50">
            <Fingerprint size={15} className="text-cyan-600" />
          </span>
          <span className="min-w-0 text-[12px] leading-snug">
            <span className="block truncate font-bold text-gray-800">{value.name.trim() || "Device name"}</span>
            <span className="block text-gray-500">
              {deviceTypeLabel(value.deviceType)} · {addressText(value.host.trim(), value.port.trim())}
              {value.connectorId ? ` · read by ${connectorName ?? "a Site Connector"}` : " · read by the server"}
            </span>
            <span className="block text-gray-500">
              {value.serialNumber.trim()
                ? `Pushes from serial ${value.serialNumber.trim()} land on this card`
                : "No serial yet: the first push links one, if no other enabled device is waiting for one"}
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
