// Journey History: the phone behind a journey and whether it can keep tracking with the app closed. The settings listed here
// (permission level, battery optimisation, background restriction) are the usual reasons a track has gaps.
import type { ReactNode } from "react";
import { BatteryCharging, Smartphone } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { JourneyDetail } from "@/lib/api-client/custom-hooks";
import { fmtDateTime, permissionClass, permissionLabel, timeAgo } from "./logic";
import { Chip } from "./ui";

function Item({ label, children, testId }: { label: string; children: ReactNode; testId?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5" data-testid={testId}>
      <dt className="text-xs text-gray-500">{label}</dt>
      <dd className="text-right text-sm font-semibold text-gray-900">{children}</dd>
    </div>
  );
}

/** Yes / No with the colour that says whether it is good: `badWhen` is the answer that costs tracking. */
function Flag({ value, badWhen, yes, no }: { value: boolean | null; badWhen: boolean; yes: string; no: string }) {
  if (value === null) return <span className="font-normal text-gray-500">Not reported</span>;
  const bad = value === badWhen;
  return <Chip className={bad ? "bg-amber-50 text-amber-800" : "bg-green-50 text-green-700"}>{value ? yes : no}</Chip>;
}

export default function DeviceCard({ detail, now }: { detail: JourneyDetail; now?: number }) {
  const device = detail.device;
  const track = detail.track;
  const seen = device?.lastSeenAt ?? track.lastPointAt;
  const battery = device?.lastBatteryPct ?? track.lastBatteryPct;
  return (
    <Card className="border-0 shadow-sm" data-testid="device-card">
      <CardContent className="p-4">
        <h3 className="flex items-center gap-2 text-sm font-bold text-gray-900">
          <Smartphone size={15} className="text-[#006496]" /> Phone and tracking health
        </h3>
        {!device ? (
          <p className="mt-3 text-sm text-gray-500" data-testid="device-empty">
            No phone has reported yet. Details appear after the first upload from the employee's app.
          </p>
        ) : (
          <dl className="mt-2 divide-y">
            <Item label="Phone" testId="device-model">
              {device.model || "Unknown model"}
            </Item>
            <Item label="System" testId="device-os">
              {[device.platform, device.osVersion].filter(Boolean).join(" ") || "Not reported"}
            </Item>
            <Item label="App version" testId="device-app">
              {device.appVersion || "Not reported"}
            </Item>
            <Item label="Location permission" testId="device-permission">
              <Chip className={permissionClass(device.permissionLevel)}>{permissionLabel(device.permissionLevel)}</Chip>
            </Item>
            <Item label="Location services" testId="device-location">
              <Flag value={device.locationEnabled} badWhen={false} yes="On" no="Off" />
            </Item>
            <Item label="Battery optimisation" testId="device-optimised">
              <Flag value={device.batteryOptimised} badWhen={true} yes="Restricting the app" no="Not restricted" />
            </Item>
            <Item label="Background restricted" testId="device-background">
              <Flag value={device.backgroundRestricted} badWhen={true} yes="Yes" no="No" />
            </Item>
            <Item label="Battery saver" testId="device-powersave">
              <Flag value={device.powerSave} badWhen={true} yes="On" no="Off" />
            </Item>
          </dl>
        )}
        <dl className={device ? "divide-y border-t" : "mt-2 divide-y"}>
          <Item label="Last seen" testId="device-last-seen">
            {seen ? (
              <>
                {timeAgo(seen, now)}
                <span className="block text-xs font-normal text-gray-500">{fmtDateTime(seen, true)}</span>
              </>
            ) : (
              <span className="font-normal text-gray-500">Never</span>
            )}
          </Item>
          <Item label="Battery" testId="device-battery">
            {battery !== null && battery !== undefined ? (
              <span className="inline-flex items-center gap-1">
                <BatteryCharging size={13} /> {Math.round(battery)}%
              </span>
            ) : (
              <span className="font-normal text-gray-500">Not reported</span>
            )}
          </Item>
          <Item label="Network" testId="device-network">
            {device?.lastNetwork ?? track.lastNetwork ?? (
              <span className="font-normal text-gray-500">Not reported</span>
            )}
          </Item>
        </dl>
      </CardContent>
    </Card>
  );
}
