import { useLocation } from "wouter";
import { AlertTriangle, ArrowRight, CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FetchDeviceResult, FetchRun } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { StatCard } from "../account-management/parts";
import { TONE_CLASSES } from "../device-status/logic";
import { TonePill } from "../device-status/parts";
import { RESULT_STATUS_LABEL, RESULT_STATUS_TONE, describeRun, fetchProgress, formatDuration, pushLink } from "./logic";

const n = (v: number | undefined | null) => (v == null ? "–" : v.toLocaleString("en-IN"));

function DeviceRow({ r, update }: { r: FetchDeviceResult; update: boolean }) {
  const busy = r.status === "reading" || r.status === "processing";
  return (
    <TableRow data-testid={`fetch-device-${r.deviceId}`} data-status={r.status}>
      <TableCell className="font-semibold text-slate-800">{r.deviceName}</TableCell>
      <TableCell>
        <TonePill tone={RESULT_STATUS_TONE[r.status]}>
          {busy && <Loader2 size={11} className="animate-spin" />}
          {r.status === "done" && <CheckCircle2 size={11} />}
          {r.status === "failed" && <XCircle size={11} />}
          {RESULT_STATUS_LABEL[r.status]}
        </TonePill>
      </TableCell>
      {r.status === "failed" ? (
        <TableCell colSpan={5} className="text-xs text-red-600" data-testid={`fetch-device-${r.deviceId}-error`}>
          {r.error}
        </TableCell>
      ) : busy && r.inRange == null ? (
        <TableCell colSpan={5} className="text-xs text-slate-500">
          {r.phase || "Working…"}
        </TableCell>
      ) : (
        <>
          <TableCell className="tabular-nums">{n(r.inRange)}</TableCell>
          <TableCell className="tabular-nums">{n(r.alreadyInHrms)}</TableCell>
          <TableCell className="tabular-nums font-bold text-[#006496]" data-testid={`fetch-device-${r.deviceId}-new`}>
            {update ? n(r.created) : n(r.new)}
          </TableCell>
          <TableCell className="tabular-nums text-slate-600">
            {n(r.unmatchedPunches)}
            {r.unmatchedIds ? <span className="text-xs text-slate-400"> ({n(r.unmatchedIds)} IDs)</span> : null}
          </TableCell>
          <TableCell className="whitespace-nowrap text-xs text-slate-500">{formatDuration(r.durationMs)}</TableCell>
        </>
      )}
    </TableRow>
  );
}

/** The live view of a run, and what it found when it finished. */
export default function FetchResults({ run }: { run: FetchRun }) {
  const [, navigate] = useLocation();
  const progress = fetchProgress(run);
  const update = run.mode === "update";
  const s = run.summary;
  const running = run.status === "running";

  return (
    <div className="space-y-4" data-testid="fetch-run" data-status={run.status} data-mode={run.mode}>
      <Card className="rounded-2xl">
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="flex items-center gap-2 text-sm font-bold text-slate-800">
                {running && <Loader2 size={14} className="animate-spin text-[#006496]" />}
                {run.status === "done" && <CheckCircle2 size={15} className="text-emerald-600" />}
                {run.status === "failed" && <XCircle size={15} className="text-red-600" />}
                {update ? "Fetch and update" : "Preview"} · {run.rangeLabel}
              </p>
              <p className="mt-0.5 text-xs text-slate-500" data-testid="fetch-run-line">
                {running ? progress.label : describeRun(run)}
              </p>
            </div>
            <span className="text-xs text-slate-400">
              {formatDuration(run.elapsedSeconds * 1000)}
              {run.startedBy ? ` · ${run.startedBy}` : ""}
            </span>
          </div>
          <Progress value={progress.percent} className="h-1.5" aria-label="Progress" />
        </CardContent>
      </Card>

      {s && run.status !== "running" && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-5" data-testid="fetch-summary">
          <StatCard
            label="On the devices"
            value={n(s.onDevice)}
            sub="all punches stored"
            icon={CheckCircle2}
            tone="bg-slate-100 text-slate-800"
          />
          <StatCard
            label="In your dates"
            value={n(s.inRange)}
            sub={run.rangeLabel.toLowerCase()}
            icon={CheckCircle2}
            tone="bg-blue-50 text-blue-800"
          />
          <StatCard
            label="Already in the HRMS"
            value={n(s.alreadyInHrms)}
            sub="left as they are"
            icon={CheckCircle2}
            tone="bg-green-50 text-green-800"
          />
          <StatCard
            testId="fetch-stat-new"
            label={update ? "Added" : "New to the HRMS"}
            value={n(update ? s.created : s.new)}
            sub={update ? "written to the HRMS" : "an update would add"}
            icon={CheckCircle2}
            tone="bg-indigo-50 text-indigo-800"
          />
          <StatCard
            label="IDs not in the HRMS"
            value={n(s.unmatchedPunches)}
            sub="punches not matched"
            icon={AlertTriangle}
            tone={s.unmatchedPunches ? "bg-amber-50 text-amber-800" : "bg-slate-50 text-slate-500"}
          />
        </div>
      )}

      <Card className="overflow-hidden rounded-2xl">
        <CardContent className="p-0">
          <Table data-testid="fetch-devices">
            <TableHeader>
              <TableRow>
                {[
                  "Device",
                  "Status",
                  "In your dates",
                  "Already in HRMS",
                  update ? "Added" : "New",
                  "Not matched",
                  "Took",
                ].map((h) => (
                  <TableHead key={h} className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                    {h}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {run.results.map((r) => (
                <DeviceRow key={r.deviceId} r={r} update={update} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {s && s.suspiciousDays.length > 0 && (
        <div
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
          data-testid="fetch-suspicious"
        >
          <p className="flex items-center gap-2 font-bold">
            <AlertTriangle size={15} /> Six or more punches in a day
          </p>
          <p className="mt-1 text-xs leading-snug">
            That usually means two people share one ID on a device. Check:{" "}
            {s.suspiciousDays.map((d) => `${d.employeeName || d.employeeId} (${d.date}, ${d.punches})`).join("; ")}.
          </p>
        </div>
      )}

      {s && s.unmatched.length > 0 && (
        <Card className="overflow-hidden rounded-2xl" data-testid="fetch-unmatched">
          <CardContent className="p-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
              <div>
                <p className="text-sm font-bold text-slate-800">IDs on the devices with no active employee</p>
                <p className="text-xs text-slate-500">
                  Their punches are not recorded. Either the ID is not an Employee Code in the HRMS, or the employee is
                  Inactive.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => navigate(pushLink({ link: "device_only" }))}
              >
                See them in Data Push <ArrowRight size={13} />
              </Button>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  {["ID", "Name on the device", "Punches", "Last punch"].map((h) => (
                    <TableHead key={h} className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.unmatched.slice(0, 15).map((u) => (
                  <TableRow key={u.userId}>
                    <TableCell className="font-mono text-sm">{u.userId}</TableCell>
                    <TableCell>{u.deviceName || <span className="text-slate-400">–</span>}</TableCell>
                    <TableCell className="tabular-nums">{n(u.punches)}</TableCell>
                    <TableCell className="text-xs text-slate-500">{u.lastDate ?? "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {s.unmatched.length > 15 && (
              <p className="border-t px-4 py-2 text-xs text-slate-500">and {s.unmatched.length - 15} more IDs</p>
            )}
          </CardContent>
        </Card>
      )}

      {run.results.some((r) => r.samples && r.samples.length > 0) && (
        <Card className="overflow-hidden rounded-2xl" data-testid="fetch-samples">
          <CardContent className="p-0">
            <p className="border-b px-4 py-3 text-sm font-bold text-slate-800">
              {update ? "The first punches that were added" : "The first punches an update would add"}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  {["Device", "Employee", "Date", "Time", "Type"].map((h) => (
                    <TableHead key={h} className="text-[11px] font-bold uppercase tracking-wider text-[#006496]/60">
                      {h}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {run.results.flatMap((r) =>
                  (r.samples ?? []).slice(0, 5).map((p, i) => (
                    <TableRow key={`${r.deviceId}-${i}`}>
                      <TableCell className="text-xs text-slate-500">{r.deviceName}</TableCell>
                      <TableCell>
                        <span className="font-semibold">{p.name}</span>{" "}
                        <span className="font-mono text-xs text-slate-400">{p.code}</span>
                      </TableCell>
                      <TableCell className="text-sm">{p.date}</TableCell>
                      <TableCell className="font-mono text-sm">{p.time}</TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-bold",
                            p.type === "IN" ? TONE_CLASSES.good.chip : TONE_CLASSES.warn.chip,
                          )}
                        >
                          {p.type}
                        </span>
                      </TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
