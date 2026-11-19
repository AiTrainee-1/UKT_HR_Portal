import { useCallback, useMemo, useState } from "react";
import { ArrowLeft, ConciergeBell, Link2, LogIn, LogOut, MonitorSmartphone, Plus } from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { useAuth } from "@/contexts/AuthContext";
import {
  RECEPTION_ADMIN_API,
  getListBranchesQueryKey,
  useListBranches,
  useManagedDesk,
  useManagedDesks,
  useReceptionOverview,
  type DeskListParams,
} from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { ExportButton, StatRow, StatTile } from "../../kit";
import { CopyButton, GateButton } from "../../gates/parts";
import { AddDeskDialog } from "./DeskDialogs";
import { DeskDetail } from "./DeskDetail";
import { DeskList } from "./DeskList";
import { DeskRecords } from "./DeskRecords";
import {
  DESK_PAGE_DEFAULTS,
  DESK_PASSWORD_KEY,
  DESKS_KEY,
  DESKS_TAB_KEY,
  RECORD_KEYS,
  deskSignInAddress,
  readSelection,
  type DeskPageValues,
} from "./logic";

/**
 * Visitors -> Manage Reception (/hr/outpass-visitors/visitors/desks): every reception desk login in one place, the twin of
 * Gate Pass -> Manage Gates.
 *
 * Top: the one desk sign-in address every desk uses (with Copy), Export of the desk list and "Add desk"; the tiles (desks,
 * signed in now, check-ins and check-outs today). Left: the desks (search + on/off filter, both asked of the server) with
 * "All desks" on top. Right: the chosen desk (?desk=<id> in the address): its header and switch, its login with View
 * password, its counts and signed-in browsers, then its records (the visitors it checked in and out) with their own
 * filters and Export. "All desks" (?desk=all) shows the records of every desk with a Desk filter. On a phone the list
 * comes first and a chosen desk replaces it (with a way back).
 *
 * The address keys (desk, deskQ, deskStatus, rec*) are this tab's own (logic.ts), never the Visitors tab's.
 * Permissions: outpass_visitors.visitors.reception_devices (view = look only, every changing button is left out; edit =
 * all); View / Copy password also needs edit on outpass_visitors.visitors.reception_devices.view_password.
 */
export function ManageReceptionPage() {
  const { user } = useAuth();
  const isBranchScoped = !!user?.branchId;
  const level = useLevel();
  // the tab follows the desks key while unset; a role that set the tab itself to View only gets a View-only page
  const canEdit = level(DESKS_KEY) === "edit" && level(DESKS_TAB_KEY) === "edit";
  const canSeePassword = canEdit && level(DESK_PASSWORD_KEY) === "edit";

  const [values, write] = useUrlParams(DESK_PAGE_DEFAULTS);
  /** A record filter goes back to the first page of records, unless it is the page itself. */
  const setRecords = useCallback(
    (patch: Partial<DeskPageValues>) => write("recPage" in patch ? patch : { ...patch, recPage: "1" }),
    [write],
  );
  const clearRecords = useCallback(() => {
    const patch: Partial<DeskPageValues> = { recPage: "1" };
    for (const key of RECORD_KEYS) patch[key] = DESK_PAGE_DEFAULTS[key];
    write(patch);
  }, [write]);

  const listParams: DeskListParams = useMemo(
    () => ({ q: values.deskQ || undefined, deskStatus: (values.deskStatus || "") as DeskListParams["deskStatus"] }),
    [values.deskQ, values.deskStatus],
  );
  const desksQuery = useManagedDesks(listParams);
  const desks = desksQuery.data;
  const overview = useReceptionOverview();
  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const [adding, setAdding] = useState(false);

  const asked = readSelection(values.desk);
  // nothing chosen: a wide screen shows the first desk (a phone shows the list)
  const shown: number | "all" | null = asked !== "" ? asked : (desks?.[0]?.id ?? (desks ? "all" : null));
  const chosen = asked !== "";
  // the same cache entry DeskDetail reads (no second request): the name for the records title
  const { data: shownDesk } = useManagedDesk(typeof shown === "number" ? shown : null);
  const signInUrl = deskSignInAddress(typeof window !== "undefined" ? window.location.origin : "");

  const select = (next: number | "all" | "") =>
    write({ desk: next === "" ? "" : String(next), recDesk: "", recPage: "1" });

  const o = overview.data;

  return (
    <div className="min-w-0 space-y-4" data-testid="visitors-desks">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="flex min-w-0 max-w-full items-center gap-2 rounded-xl border border-slate-200/80 bg-white py-1 pl-3 pr-1"
          data-testid="desk-signin-address"
        >
          <Link2 size={14} className="shrink-0 text-slate-400" aria-hidden="true" />
          <span className="shrink-0 text-xs text-slate-500">Desk sign-in address</span>
          <span className="min-w-0 truncate font-mono text-sm font-semibold text-primary" title={signInUrl}>
            {signInUrl}
          </span>
          <CopyButton
            value={signInUrl}
            what="Address"
            label="Copy the desk sign-in address"
            testId="desk-signin-address-copy"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ExportButton
            title="Reception desks"
            label="Export desks"
            path={RECEPTION_ADMIN_API.listExport}
            query={{ q: values.deskQ, deskStatus: values.deskStatus }}
            hints={{ xlsx: "The desks in the list, with their counts", pdf: "Never passwords or sign-in links" }}
            testId="desk-list-export"
          />
          {canEdit && (
            <GateButton tone="primary" icon={Plus} onClick={() => setAdding(true)} data-testid="desk-add">
              Add desk
            </GateButton>
          )}
        </div>
      </div>

      <StatRow testId="desk-tiles">
        <StatTile
          label="Desks"
          value={o?.desks}
          hint={o ? `${o.active} switched on` : undefined}
          icon={ConciergeBell}
          loading={overview.isLoading}
          testId="desk-tile-desks"
        />
        <StatTile
          label="Signed in now"
          value={o?.signedInNow}
          hint="seen in the last 10 min"
          icon={MonitorSmartphone}
          tone="teal"
          loading={overview.isLoading}
          testId="desk-tile-signed-in"
        />
        <StatTile
          label="Check-ins today"
          value={o?.checkInsToday}
          hint="walk-ins registered at a desk"
          icon={LogIn}
          tone="amber"
          loading={overview.isLoading}
          testId="desk-tile-check-ins"
        />
        <StatTile
          label="Check-outs today"
          value={o?.checkOutsToday}
          hint="recorded at a desk"
          icon={LogOut}
          tone="teal"
          loading={overview.isLoading}
          testId="desk-tile-check-outs"
        />
      </StatRow>

      {!canEdit && (
        <p
          className="rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-sm font-medium text-amber-800"
          data-testid="desks-view-only"
        >
          View only: you can look at the desks and their records, and export them, but not change them.
        </p>
      )}

      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(260px,320px)_minmax(0,1fr)]">
        <DeskList
          desks={desks}
          loading={desksQuery.isLoading}
          error={desksQuery.isError}
          selection={shown ?? ""}
          onSelect={select}
          search={values.deskQ}
          onSearch={(deskQ) => write({ deskQ })}
          status={values.deskStatus}
          onStatus={(deskStatus) => write({ deskStatus })}
          canEdit={canEdit}
          onAdd={() => setAdding(true)}
          className={cn(chosen && "hidden lg:block")}
        />

        <div className={cn("min-w-0 space-y-4", !chosen && "hidden lg:block")} data-testid="desk-pane">
          {shown === null ? null : shown === "all" ? (
            <button
              type="button"
              onClick={() => select("")}
              className="inline-flex h-11 items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 lg:hidden"
              data-testid="desk-back"
            >
              <ArrowLeft size={15} aria-hidden="true" /> All desks
            </button>
          ) : (
            <DeskDetail
              key={shown}
              deskId={shown}
              canEdit={canEdit}
              canSeePassword={canSeePassword}
              isBranchScoped={isBranchScoped}
              branches={branches}
              signInUrl={signInUrl}
              onDeleted={() => select("")}
              onBack={() => select("")}
            />
          )}
          {shown !== null && (
            <DeskRecords
              selection={shown}
              deskName={shownDesk?.name}
              desks={desks}
              values={values}
              set={setRecords}
              clear={clearRecords}
            />
          )}
        </div>
      </div>

      {canEdit && (
        <AddDeskDialog
          open={adding}
          onOpenChange={setAdding}
          isBranchScoped={isBranchScoped}
          branches={branches}
          onAdded={(desk) => select(desk.id)}
        />
      )}
    </div>
  );
}
