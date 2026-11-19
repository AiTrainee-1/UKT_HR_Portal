import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Clock3, ConciergeBell, LogOut, Repeat, UserCheck, UserPlus, UsersRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  getListBranchesQueryKey,
  invalidateVisitorQueries,
  useCheckOutVisitor,
  useListBranches,
  useVisitorDashboard,
  useVisitorQr,
  type VisitorVisit,
} from "@/lib/api-client/custom-hooks";
import { useLevel } from "@/lib/tab-access";
import { cn } from "@/lib/utils";
import { GateQrDialog } from "../GateQrDialog";
import { StatRow, StatTile, useGateFilters } from "../kit";
import { gateKey, gateTabPath } from "../routes";
import { CheckOutDialog } from "./CheckOutDialog";
import { PeoplePanel } from "./PeoplePanel";
import { RegisterVisitorDialog } from "./RegisterVisitorDialog";
import { VisitDrawer } from "./VisitDrawer";
import { VisitsPanel } from "./VisitsPanel";
import { VISIT_FILTER_DEFAULTS, VISIT_FILTER_KEEP, apiQuery, errorText, viewOf, type VisitorsView } from "./logic";

/**
 * Visitors: who is on the premises, whom they came to see and when they left. The actions (Register visitor for edit roles,
 * the branch's visitor QR, a link to the Manage Reception tab where the reception desk logins live), five figures, then
 * Visits (every visit, filtered) or People (everyone who has visited). Every filter is in the address and asks the server;
 * a row opens the visit in a panel with its history; an inside visitor can be checked out from the row or the panel.
 */
export function VisitorsTab({ isBranchScoped }: { isBranchScoped: boolean }) {
  const level = useLevel();
  const canEdit = level("outpass_visitors.visitors") === "edit";
  const f = useGateFilters(VISIT_FILTER_DEFAULTS, { keep: VISIT_FILTER_KEEP });
  const view = viewOf(f.filters.view);
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();
  // the reception desk logins have a tab of their own (Manage Reception): a link to it for a role that may open it
  const canSeeDesks = level(gateKey("visitors", "desks")) !== "hidden";

  const { data: branches } = useListBranches({ enabled: !isBranchScoped, queryKey: getListBranchesQueryKey() });
  const branchFilter = isBranchScoped ? "" : f.filters.branchId;
  // the QR is per branch: the chosen one, else the first (an account bound to a branch always gets its own)
  const qrBranch = isBranchScoped ? undefined : Number(branchFilter || branches?.[0]?.id) || undefined;
  const qr = useVisitorQr(qrBranch, { enabled: isBranchScoped || qrBranch !== undefined });
  const summary = useVisitorDashboard(apiQuery(f.params, { paging: false }));
  const s = summary.data;

  const [openId, setOpenId] = useState<number | null>(null);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [checkOutTarget, setCheckOutTarget] = useState<VisitorVisit | null>(null);
  const checkOut = useCheckOutVisitor();

  const setView = (next: VisitorsView) => f.set({ view: next });
  const showToday = (status: "inside" | "checked_out") =>
    f.set({ view: "visits", status: f.filters.status === status ? "" : status, range: "today", from: "", to: "" });

  const confirmCheckOut = async (note: string) => {
    const target = checkOutTarget;
    if (!target) return;
    try {
      await checkOut.mutateAsync({ id: target.id, note: note || undefined });
    } catch (err) {
      void invalidateVisitorQueries(queryClient);
      throw new Error(errorText(err, "Could not check out. Please try again."));
    }
    setCheckOutTarget(null);
    toast({ title: `${target.name} is checked out` });
    await invalidateVisitorQueries(queryClient);
  };

  return (
    <div className="space-y-4" data-testid="visitors-page">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          role="group"
          aria-label="Show"
          className="inline-flex rounded-xl border border-slate-200 bg-white p-1"
          data-testid="visitors-view"
        >
          {(
            [
              ["visits", "Visits"],
              ["people", "People"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={view === value}
              onClick={() => setView(value)}
              className={cn(
                "h-11 rounded-lg px-4 text-sm font-semibold transition-colors sm:h-8",
                view === value ? "bg-primary text-primary-foreground" : "text-slate-600 hover:bg-slate-50",
              )}
              data-testid={`visitors-view-${value}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <GateQrDialog kind="visitor" label="Visitor QR" token={qr.data?.token} branchName={qr.data?.branchName} />
          {canSeeDesks && (
            // a link, not an edit: a View-only role may follow it (the tab there locks what it may not change)
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-11 gap-1.5 sm:h-9"
              onClick={() => navigate(gateTabPath("visitors", "desks"))}
              data-testid="visitors-manage-reception"
            >
              <ConciergeBell size={15} aria-hidden="true" /> Manage Reception
            </Button>
          )}
          {canEdit && (
            <Button
              type="button"
              size="sm"
              className="h-11 gap-1.5 sm:h-9"
              onClick={() => setRegisterOpen(true)}
              data-testid="visitors-register"
            >
              <UserPlus size={15} aria-hidden="true" /> Register visitor
            </Button>
          )}
        </div>
      </div>

      <StatRow columns={5} testId="visitors-stats">
        <StatTile
          label="Inside now"
          value={s?.insideNow}
          icon={UserCheck}
          tone="amber"
          loading={!s}
          onClick={() => showToday("inside")}
          active={view === "visits" && f.filters.status === "inside"}
          title="Show who is inside now"
          testId="visitors-stat-inside"
        />
        <StatTile label="Visits today" value={s?.today} icon={UsersRound} loading={!s} testId="visitors-stat-today" />
        <StatTile
          label="Checked out today"
          value={s?.checkedOutToday}
          icon={LogOut}
          tone="teal"
          loading={!s}
          onClick={() => showToday("checked_out")}
          active={view === "visits" && f.filters.status === "checked_out"}
          title="Show today's check-outs"
          testId="visitors-stat-checked-out"
        />
        <StatTile
          label="Inside over 2 h"
          value={s?.longStayNow}
          icon={Clock3}
          tone="rose"
          emphasis={(s?.longStayNow ?? 0) > 0}
          loading={!s}
          testId="visitors-stat-long"
        />
        <StatTile
          label="Repeat visitors"
          value={s?.repeatThisMonth}
          hint="This month"
          icon={Repeat}
          tone="indigo"
          loading={!s}
          testId="visitors-stat-repeat"
        />
      </StatRow>

      {view === "visits" ? (
        <VisitsPanel
          filters={f}
          isBranchScoped={isBranchScoped}
          branches={branches}
          canEdit={canEdit}
          summary={s}
          selectedId={openId}
          onOpen={(v) => setOpenId(v.id)}
          onCheckOut={setCheckOutTarget}
          onRegister={() => setRegisterOpen(true)}
        />
      ) : (
        <PeoplePanel
          filters={f}
          isBranchScoped={isBranchScoped}
          branches={branches}
          selectedVisitId={openId}
          onOpen={setOpenId}
        />
      )}

      <VisitDrawer
        visitId={openId}
        onClose={() => setOpenId(null)}
        onOpenVisit={setOpenId}
        onCheckOut={setCheckOutTarget}
        canEdit={canEdit}
      />

      {canEdit && (
        <RegisterVisitorDialog
          open={registerOpen}
          onClose={() => setRegisterOpen(false)}
          isBranchScoped={isBranchScoped}
          branches={branches}
          defaultBranchId={branchFilter}
          onRegistered={(visit) => {
            setRegisterOpen(false);
            toast({ title: `${visit.name} is checked in`, description: `Meeting ${visit.whomToMeet}` });
            void invalidateVisitorQueries(queryClient);
          }}
          onOpenVisit={(id) => {
            setRegisterOpen(false);
            setOpenId(id);
          }}
        />
      )}

      <CheckOutDialog target={checkOutTarget} onClose={() => setCheckOutTarget(null)} onConfirm={confirmCheckOut} />
    </div>
  );
}
