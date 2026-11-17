import { useState } from "react";
import { Cable, Layers, Link2, Link2Off, Server, UserCheck, UserX, Users } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useLinkSummary, type EmploymentType } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatCard } from "../account-management/parts";
import { relativeTime } from "../device-status/logic";
import { EmploymentFilter } from "./SubTabs";

const n = (v: number) => v.toLocaleString("en-IN");

/**
 * Link / Unlink -> Home (owner 2026-11-17): how many employees there are, who is registered on which device, who is on
 * (and linked to) several devices, and every device's own numbers. "Registered" = in the device's user list as it was last
 * read (Data Push -> Read); "linked" = the device's punches are taken for them (all devices are, unless unlinked).
 */
export default function LinkSummary() {
  const [kind, setKind] = useState<EmploymentType | "">("");
  const q = useLinkSummary(kind);
  const s = q.data?.summary;
  const devices = q.data?.devices ?? [];
  const oldest = devices
    .map((d) => d.usersReadAt)
    .filter((v): v is string => !!v)
    .sort()[0];

  return (
    <div className="space-y-4" data-testid="link-summary">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <EmploymentFilter value={kind} onChange={setKind} testId="link-summary-kind" />
        {oldest && (
          <span className="text-xs text-slate-500" data-testid="link-summary-read">
            Device user lists read {relativeTime(oldest)} at the oldest (Data Push → Read to read them again)
          </span>
        )}
      </div>

      {q.isLoading || !s ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6" data-testid="link-summary-cards">
          <StatCard
            label="Employees"
            value={n(s.employees)}
            sub={kind ? `active ${kind}` : "active, staff and production"}
            icon={Users}
            tone="bg-slate-50 text-slate-700"
          />
          <StatCard
            label="On a device"
            value={n(s.onAnyDevice)}
            sub="registered on at least one"
            icon={UserCheck}
            tone="bg-emerald-50 text-emerald-800"
          />
          <StatCard
            label="On no device"
            value={n(s.onNoDevice)}
            sub="cannot punch anywhere"
            icon={UserX}
            tone={s.onNoDevice ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-500"}
          />
          <StatCard
            label="On several devices"
            value={n(s.onMultipleDevices)}
            sub="registered on 2 or more"
            icon={Layers}
            tone="bg-sky-50 text-sky-800"
          />
          <StatCard
            label="Linked to several"
            value={n(s.linkedToMultipleDevices)}
            sub="punches taken from 2 or more"
            icon={Link2}
            tone="bg-indigo-50 text-indigo-800"
          />
          <StatCard
            label="With a device unlinked"
            value={n(s.withUnlinkedDevices)}
            sub="see Modified"
            icon={Link2Off}
            tone={s.withUnlinkedDevices ? "bg-rose-50 text-rose-800" : "bg-slate-50 text-slate-500"}
          />
        </div>
      )}

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          <p className="border-b px-4 py-3 text-sm font-bold text-slate-800">Device by device</p>
          <div className="overflow-x-auto">
            <Table data-testid="link-summary-devices">
              <TableHeader>
                <TableRow>
                  {[
                    "Device",
                    "Users on it",
                    "Employees",
                    "Staff",
                    "Production",
                    "Also on other devices",
                    "Unlinked here",
                    "Inactive employees",
                    "Not in the HRMS",
                  ].map((h) => (
                    <TableHead key={h} className="whitespace-nowrap text-xs">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {devices.map((d) => (
                  <TableRow key={d.deviceId} data-testid={`link-summary-device-${d.deviceId}`}>
                    <TableCell className="whitespace-nowrap">
                      <span className="flex items-center gap-1.5 font-semibold text-slate-800">
                        {d.deviceName}
                        {!d.isActive && (
                          <span className="rounded bg-slate-100 px-1.5 text-[10px] text-slate-500">off</span>
                        )}
                      </span>
                      <span className="flex items-center gap-1 text-[11px] text-slate-400">
                        {d.via === "connector" ? <Cable size={11} /> : <Server size={11} />}
                        {d.via === "connector" ? "Site Connector" : "Direct"}
                        {d.usersReadAt ? ` · read ${relativeTime(d.usersReadAt)}` : " · never read"}
                      </span>
                    </TableCell>
                    <TableCell className="tabular-nums">{n(d.usersOnDevice)}</TableCell>
                    <TableCell className="font-bold tabular-nums text-slate-900">{n(d.employees)}</TableCell>
                    <TableCell className="tabular-nums">{n(d.staff)}</TableCell>
                    <TableCell className="tabular-nums">{n(d.production)}</TableCell>
                    <TableCell className="tabular-nums">{n(d.alsoOnOtherDevices)}</TableCell>
                    <TableCell className={cn("tabular-nums", d.unlinkedHere ? "font-semibold text-rose-700" : "")}>
                      {n(d.unlinkedHere)}
                    </TableCell>
                    <TableCell className={cn("tabular-nums", d.inactiveEmployees ? "text-amber-700" : "")}>
                      {n(d.inactiveEmployees)}
                    </TableCell>
                    <TableCell className="tabular-nums text-slate-500">{n(d.notInHrms)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
