import { CheckCircle2, XCircle } from "lucide-react";
import { ApprovalTrail } from "@/components/ApprovalTrail";
import { Skeleton } from "@/components/ui/skeleton";
import { useInOutDetail, type InOutRow, type InOutScan } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  DetailDrawer,
  DrawerFields,
  DrawerSection,
  PersonCell,
  StatusChip,
  NONE,
  fmtDateTime,
  fmtMinutes,
  toneOf,
} from "../kit";
import { TimeOut, statusTitle } from "./inout-cells";

const SCAN_TYPE: Record<InOutScan["type"], string> = { exit: "Exit", return: "Return" };

/** One gate scan of the pass: what it was for, where, when, and whether the gate let it through (and why not). */
function ScanItem({ scan }: { scan: InOutScan }) {
  const allowed = scan.result === "allowed";
  const Icon = allowed ? CheckCircle2 : XCircle;
  return (
    <li className="flex min-w-0 gap-2.5 py-2" data-testid="inout-scan" data-result={scan.result}>
      <Icon
        size={16}
        className={cn("mt-0.5 shrink-0", allowed ? "text-teal-600" : "text-rose-600")}
        aria-hidden="true"
      />
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-medium text-slate-900">
            {SCAN_TYPE[scan.type]} at {scan.gateName ?? "an unknown gate"}
          </span>
          <span className="tabular-nums text-slate-500">{fmtDateTime(scan.at)}</span>
        </p>
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-2">
          <StatusChip tone={allowed ? "teal" : "rose"}>
            {allowed ? "Allowed" : `Denied${scan.reasonLabel ? `: ${scan.reasonLabel}` : ""}`}
          </StatusChip>
          {scan.message && (
            <span className="min-w-0 flex-1 truncate text-xs text-slate-500" title={scan.message}>
              {scan.message}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * The details of one pass that went out (a row of In/Out): the pass, out and back, how it was approved and every scan
 * of it at a gate, the refused ones included. The row's own data shows at once; the approval and the scans come with the
 * details call.
 */
export function InOutDrawer({ row, onClose }: { row: InOutRow | null; onClose: () => void }) {
  const { data: detail, isLoading, error } = useInOutDetail(row?.id ?? null);
  const pass = detail ?? row;
  const emp = pass?.employee;
  return (
    <DetailDrawer
      open={row !== null}
      onOpenChange={(open) => !open && onClose()}
      title={emp?.name ?? "Gate pass"}
      subtitle={pass ? [emp?.employeeCode, emp?.department, pass.statusLabel].filter(Boolean).join(" · ") : undefined}
      testId="inout-drawer"
    >
      {pass && (
        <>
          <div className="flex items-center justify-between gap-3">
            <PersonCell
              name={emp?.name}
              code={emp?.employeeCode}
              sub={emp?.designation ?? emp?.department}
              photoUrl={emp?.photoUrl}
              size={40}
            />
            <StatusChip tone={toneOf(pass.status)} title={statusTitle(pass)} testId="inout-drawer-status">
              {pass.statusLabel}
            </StatusChip>
          </div>

          <DrawerSection title="Pass">
            <DrawerFields
              items={[
                { label: "Pass type", value: pass.passTypeLabel },
                { label: "Raised", value: pass.source === "on_duty" ? "By an On-Duty approval" : "In the app" },
                { label: "Destination", value: pass.destination, wide: true },
                ...(pass.reason && pass.reason.trim() !== pass.destination.trim()
                  ? [{ label: "Reason", value: pass.reason, wide: true }]
                  : []),
                { label: "Asked for", value: detail?.requestedAt ? fmtDateTime(detail.requestedAt) : null },
                { label: "Approved", value: pass.approvedAt ? fmtDateTime(pass.approvedAt) : null },
                { label: "Approved by", value: pass.approvedBy },
                { label: "Expected back", value: pass.expectedReturnAt ? fmtDateTime(pass.expectedReturnAt) : null },
              ]}
            />
          </DrawerSection>

          <DrawerSection title="Out and back">
            <DrawerFields
              items={[
                {
                  label: "Went out",
                  value: `${fmtDateTime(pass.exitedAt)}${pass.exitGateName ? ` · ${pass.exitGateName}` : ""}`,
                },
                {
                  label: "Came back",
                  value: pass.enteredAt
                    ? `${fmtDateTime(pass.enteredAt)}${pass.entryGateName ? ` · ${pass.entryGateName}` : ""}`
                    : "Not yet",
                },
                { label: "Time out", value: <TimeOut row={pass} />, wide: true },
                ...(pass.overMinutes
                  ? [{ label: "Past the expected return", value: fmtMinutes(pass.overMinutes) }]
                  : []),
              ]}
            />
          </DrawerSection>

          <DrawerSection title="Approval">
            {isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : detail?.approvalTrail ? (
              <div className="overflow-x-auto pb-1">
                <ApprovalTrail approval={detail.approvalTrail} submittedBy="Asked" />
              </div>
            ) : detail ? (
              <p className="text-sm text-slate-600">
                Made by an On-Duty approval: it had no approval steps of its own.
              </p>
            ) : (
              <p className="text-sm text-slate-500">{NONE}</p>
            )}
            {detail?.reviewComment && (
              <p className="text-sm text-slate-600">
                <span className="text-slate-500">Comment: </span>
                {detail.reviewComment}
              </p>
            )}
          </DrawerSection>

          <DrawerSection title="Gate scans" testId="inout-scans">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : error ? (
              <p className="text-sm text-rose-700">
                Could not load the scans of this pass. Close it and open it again.
              </p>
            ) : detail && detail.scans.length > 0 ? (
              <ol className="divide-y divide-slate-100">
                {detail.scans.map((s, i) => (
                  <ScanItem key={s.id ?? i} scan={s} />
                ))}
              </ol>
            ) : (
              <p className="text-sm text-slate-500">No gate scans were recorded for this pass.</p>
            )}
          </DrawerSection>
        </>
      )}
    </DetailDrawer>
  );
}
