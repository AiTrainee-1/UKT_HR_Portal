import { useMemo, useState } from "react";
import { ArrowLeft, DoorOpen, Link2, MonitorSmartphone, Plus, ShieldAlert, ScrollText } from "lucide-react";
import { useAuth } from "@/contexts/AuthContext";
import {
  GATE_ADMIN_API,
  getListBranchesQueryKey,
  useGateAdminSummary,
  useListBranches,
  useManagedGate,
  useManagedGates,
  type GateListParams,
} from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { ExportButton, StatRow, StatTile, useGateFilters } from "../kit";
import { AddGateDialog } from "./GateDialogs";
import { GateDetail } from "./GateDetail";
import { GateList } from "./GateList";
import { GATE_PAGE_DEFAULTS, GateRecords } from "./GateRecords";
import { CopyButton, GateButton } from "./parts";
import { GATES_KEY, PASSWORD_KEY, SCREEN_KEYS, monitorAddress, readSelection } from "./logic";

/**
 * Gate Pass -> Manage Gates (/hr/outpass-visitors/outpass/gates): every gate login in one place.
 *
 * Top: the one gate monitor address every gate signs in at (with Copy), Export of the gate list and "Add gate"; the tiles
 * (gates, signed in now, records today, denied today). Left: the gates (search + on/off filter, both asked of the server)
 * with "All gates" on top. Right: the chosen gate (?gate=<id> in the address): its header and switches, its login with
 * View password, what it scans, its counts and sessions, then its records with their own filters and Export. "All gates"
 * (?gate=all) shows the records of every gate with a Gate filter. On a phone the list comes first and a chosen gate
 * replaces it (with a way back).
 *
 * Permissions: outpass_visitors.outpass.gate_devices (view = look only, every changing button is left out; edit = all);
 * View / Copy password also needs edit on outpass_visitors.outpass.gate_devices.view_password ("See gate passwords").
 */
export function ManageGatesPage() {
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;
  const level = useLevel();
  const canEdit = level(GATES_KEY) === "edit";
  const canSeePassword = canEdit && level(PASSWORD_KEY) === "edit";

  const f = useGateFilters(GATE_PAGE_DEFAULTS, { keep: SCREEN_KEYS });
  const listParams: GateListParams = useMemo(
    () => ({ q: f.filters.gq || undefined, status: (f.filters.gstatus || "") as GateListParams["status"] }),
    [f.filters.gq, f.filters.gstatus],
  );
  const gatesQuery = useManagedGates(listParams);
  const gates = gatesQuery.data;
  const summary = useGateAdminSummary();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const [adding, setAdding] = useState(false);

  const asked = readSelection(f.filters.gate);
  // nothing chosen: a wide screen shows the first gate (a phone shows the list)
  const shown: number | "all" | null = asked !== "" ? asked : (gates?.[0]?.id ?? (gates ? "all" : null));
  const chosen = asked !== "";
  // the same cache entry GateDetail reads (no second request): the name for the records title, even when the gate is
  // not in the filtered list
  const { data: shownGate } = useManagedGate(typeof shown === "number" ? shown : null);
  const monitorUrl = monitorAddress(typeof window !== "undefined" ? window.location.origin : "");

  const select = (next: number | "all" | "") => f.set({ gate: next === "" ? "" : String(next), gateId: "" });

  const s = summary.data;

  return (
    <div className="min-w-0 space-y-4" data-testid="outpass-gates">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-slate-200/80 bg-white py-1 pl-3 pr-1"
          data-testid="gate-monitor-address"
        >
          <Link2 size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="shrink-0 text-xs text-slate-500">Gate monitor address</span>
          <span className="min-w-0 truncate font-mono text-sm font-semibold text-primary" title={monitorUrl}>
            {monitorUrl}
          </span>
          <CopyButton
            value={monitorUrl}
            what="Address"
            label="Copy the gate monitor address"
            testId="gate-monitor-address-copy"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportButton
            title="Gates"
            label="Export gates"
            path={GATE_ADMIN_API.listExport}
            query={{ q: f.filters.gq, status: f.filters.gstatus }}
            hints={{ xlsx: "The gates in the list, with their counts", pdf: "Never passwords or sign-in links" }}
            testId="gate-list-export"
          />
          {canEdit && (
            <GateButton tone="primary" icon={Plus} onClick={() => setAdding(true)} data-testid="gate-add">
              Add gate
            </GateButton>
          )}
        </div>
      </div>

      <StatRow testId="gate-tiles">
        <StatTile
          label="Gates"
          value={s?.gates}
          hint={s ? `${s.active} switched on` : undefined}
          icon={DoorOpen}
          loading={summary.isLoading}
          testId="gate-tile-gates"
        />
        <StatTile
          label="Signed in now"
          value={s?.signedInNow}
          hint="seen in the last 10 min"
          icon={MonitorSmartphone}
          tone="teal"
          loading={summary.isLoading}
          testId="gate-tile-signed-in"
        />
        <StatTile
          label="Records today"
          value={s?.recordsToday}
          hint="every gate"
          icon={ScrollText}
          loading={summary.isLoading}
          testId="gate-tile-records"
        />
        <StatTile
          label="Denied today"
          value={s?.deniedToday}
          icon={ShieldAlert}
          tone="rose"
          emphasis={!!s?.deniedToday}
          loading={summary.isLoading}
          testId="gate-tile-denied"
        />
      </StatRow>

      {!canEdit && (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm font-medium text-amber-800"
          data-testid="gates-view-only"
        >
          View only: you can look at the gates and their records, and export them, but not change them.
        </p>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
        <GateList
          gates={gates}
          loading={gatesQuery.isLoading}
          error={gatesQuery.isError}
          selection={shown ?? ""}
          onSelect={select}
          search={f.filters.gq}
          onSearch={(gq) => f.set({ gq })}
          status={f.filters.gstatus}
          onStatus={(gstatus) => f.set({ gstatus })}
          canEdit={canEdit}
          onAdd={() => setAdding(true)}
          className={cn(chosen && "hidden lg:block")}
        />

        <div className={cn("min-w-0 space-y-4", !chosen && "hidden lg:block")} data-testid="gate-pane">
          {shown === null ? null : shown === "all" ? (
            <button
              type="button"
              onClick={() => select("")}
              className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 lg:hidden"
              data-testid="gate-back"
            >
              <ArrowLeft size={15} aria-hidden="true" /> All gates
            </button>
          ) : (
            <GateDetail
              key={shown}
              gateId={shown}
              canEdit={canEdit}
              canSeePassword={canSeePassword}
              isBranchScoped={isBranchScoped}
              branches={branches}
              monitorUrl={monitorUrl}
              onDeleted={() => select("")}
              onBack={() => select("")}
            />
          )}
          {shown !== null && <GateRecords selection={shown} gateName={shownGate?.name} gates={gates} f={f} />}
        </div>
      </div>

      {canEdit && (
        <AddGateDialog
          open={adding}
          onOpenChange={setAdding}
          isBranchScoped={isBranchScoped}
          branches={branches}
          onAdded={(gate) => select(gate.id)}
        />
      )}
    </div>
  );
}
