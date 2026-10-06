import { HelpCircle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { UnknownPusher } from "@/lib/api-client/custom-hooks";
import { relativeTime } from "./logic";

/** Machines that contact the server under a serial number no configured device has: new ones nobody added yet, or a
 *  configured device whose serial was typed wrongly. */
export default function UnknownSenders({ senders }: { senders: UnknownPusher[] }) {
  if (senders.length === 0) return null;
  return (
    <Card className="border-0 shadow-sm ring-1 ring-amber-200" data-testid="device-unknown-senders">
      <CardContent className="space-y-3 p-4">
        <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
          <HelpCircle size={15} className="text-amber-500" />
          {senders.length === 1
            ? "A device is contacting the server that is not set up here"
            : `${senders.length} devices are contacting the server that are not set up here`}
        </p>
        <p className="text-xs leading-relaxed text-slate-600">
          Their attendance is arriving, but the portal does not know which device they are. Add each one in Settings →
          Devices with this serial number (or correct the serial of the device it belongs to).
        </p>
        <div className="divide-y divide-slate-100 rounded-xl border border-slate-100">
          {senders.map((s) => (
            <div key={s.serialNumber} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
              <span className="font-mono font-semibold text-slate-800">{s.serialNumber}</span>
              <span className="text-slate-500">
                last heard {relativeTime(s.lastSeenAt)}
                {s.lastRemoteIp ? ` · from ${s.lastRemoteIp}` : ""} · {s.punches} punch{s.punches === 1 ? "" : "es"}{" "}
                received
              </span>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
