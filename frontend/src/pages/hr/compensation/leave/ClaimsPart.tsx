import { useMemo, useState } from "react";
import {
  Cake,
  ClipboardCheck,
  Clock3,
  Loader2,
  PiggyBank,
  SearchX,
  Sun,
  Timer,
  UserCheck,
  XCircle,
} from "lucide-react";
import { SectionCard } from "@/components/payroll/kit/parts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { RejectReasonDialog } from "@/components/RejectReasonDialog";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import {
  CLAIM_KINDS,
  useDecidePlacement,
  useWithdrawCompensationClaim,
  type ClaimKind,
  type ClaimsListParams,
  type ClaimsSummary,
  type CompensationClaim,
  type useCompensationClaims,
} from "@/lib/api-client/custom-hooks";
import {
  ClearFilters,
  DataTable,
  FilterBar,
  PersonCell,
  SearchFilter,
  SelectFilter,
  StatRow,
  StatTile,
  StatusChip,
  type DataColumn,
  type TileTone,
} from "@/pages/hr/outpass-visitors/kit";
import { dateLong, dateShort, errorMessage, fmtShifts } from "../logic";
import { Notice, useSingleFlight } from "../ui";
import { useClaimRight } from "../visible";
import { ClaimDrawer } from "./ClaimDrawer";
import {
  CLAIM_STATUS_FILTER,
  KIND_LABEL,
  KIND_OPTIONS,
  RAISED_BY_OPTIONS,
  STATUS_TONE,
  claimAmountText,
  claimDateDetail,
  claimStatusText,
  decisionLine,
  kindText,
  raisedByText,
} from "./claims-logic";
import { EmployeeChip, MonthFilter, OrgFilters } from "./LeaveFilters";
import { idOf, monthChoice, monthChoiceLabel, pageOf, useLeaveUrl, type LeaveUrl } from "./leave-url";
import {
  canChooseDateFor,
  claimSource,
  hrMayApprovePlacement,
  hrMayRejectPlacement,
  placedDayLine,
  placementChip,
} from "./place-comp-logic";
import { PlaceCompDialog, type PlaceCompTarget } from "./PlaceCompDialog";

export const CLAIMS_PAGE_SIZE = 25;

/** What the Claims section asks the server for, from its filters in the address. */
export function claimsParamsOf(lu: LeaveUrl, today: string): ClaimsListParams {
  const month = monthChoice(lu.hmonth, lu.hyear, today);
  return {
    kind: lu.hkind || undefined,
    status: lu.hstatus === "all" || lu.hstatus === "" ? undefined : lu.hstatus,
    ...(month.all ? { anyMonth: true } : { month: month.month, year: month.year }),
    employeeId: idOf(lu.hemp),
    departmentId: idOf(lu.hdept),
    branchId: idOf(lu.hbranch),
    q: lu.hq.trim() || undefined,
    raisedBy: lu.hraised || undefined,
    page: pageOf(lu.hpage),
    pageSize: CLAIMS_PAGE_SIZE,
  };
}

const KIND_ICON: Record<ClaimKind, typeof Sun> = {
  holiday_work: Sun,
  ot_allowance: Clock3,
  ot_shift: Timer,
  birthday: Cake,
  use_balance: PiggyBank,
};

/**
 * The kind tiles' own short labels: the full kind names ("OT shift credit (Type 2)") do not fit five narrow tiles, so each
 * tile says it in a word or two (the tooltip and the table keep the full name).
 */
export const KIND_TILE_LABEL: Record<ClaimKind, string> = {
  holiday_work: "Sunday work",
  ot_allowance: "Allowance",
  ot_shift: "OT credit",
  birthday: "Birthday",
  use_balance: "Day off",
};

/**
 * The hint of the "Waiting for HOD" tile. When days off wait too, the credits waiting to go in and the days off waiting to
 * come out, both with two decimals: "1.00 in · 0.50 out", or "none in · 0.50 out" when only days off wait. With no day
 * off waiting: "1.75 shifts to add". An older backend sends only the one total: "2 shifts".
 */
export function pendingHint(summary: ClaimsSummary | undefined): string {
  if (!summary) return "0 shifts";
  const credit = summary.pendingCreditShifts;
  const use = summary.pendingUseShifts;
  if (credit === null || use === null) return `${fmtShifts(summary.pendingShifts)} shifts`;
  if (use <= 0) return `${fmtShifts(credit)} shifts to add`;
  return `${credit > 0 ? credit.toFixed(2) : "none"} in · ${use.toFixed(2)} out`;
}

const KIND_TONE: Record<ClaimKind, TileTone> = {
  holiday_work: "amber",
  ot_allowance: "indigo",
  ot_shift: "indigo",
  birthday: "rose",
  use_balance: "teal",
};

/**
 * Claims: every claim of every kind (Sunday / holiday work, OT allowance, OT shift credit, birthday credit, use of the
 * balance), whoever raised it, with where it stands in the Department Head's approval. Filtered by month (or every month),
 * kind, status, who raised it, department, branch and the employee's name or code; the tiles count them by status and by
 * kind (a click filters). A row opens its drawer: the approval trail, what the claim is based on, and what it put on the
 * balance (with links to Credits and the employee's balance). A claim still waiting can be withdrawn. An approved credit
 * with some still to place offers Choose date (the calendar, PlaceCompDialog); a date HR chose shows its stage and day off,
 * and HR approves or rejects it here once the Department Head has approved it.
 */
export function ClaimsPart({
  query,
  canWithdraw,
  pausedReason,
  today,
  warnings,
  onDismissWarnings,
}: {
  query: ReturnType<typeof useCompensationClaims>;
  canWithdraw: boolean;
  pausedReason: string;
  today: string;
  warnings: string[];
  onDismissWarnings: () => void;
}) {
  const { toast } = useToast();
  const [lu, setLu] = useLeaveUrl();
  const withdraw = useWithdrawCompensationClaim();
  const [withdrawing, setWithdrawing] = useState<CompensationClaim | null>(null);
  const [placing, setPlacing] = useState<PlaceCompTarget | null>(null);
  const [rejecting, setRejecting] = useState<CompensationClaim | null>(null);
  const [rejectError, setRejectError] = useState<string | null>(null);
  const decide = useDecidePlacement();
  const { reason: rightProblem } = useClaimRight();
  const once = useSingleFlight();
  const month = monthChoice(lu.hmonth, lu.hyear, today);
  const rows = useMemo(() => query.data?.items ?? [], [query.data]);
  const summary = query.data?.summary;
  const openId = idOf(lu.hclaim) ?? null;
  const open = openId === null ? null : (rows.find((r) => r.id === openId) ?? null);
  const employeeName = idOf(lu.hemp) ? (rows.find((r) => r.employeeId === idOf(lu.hemp))?.employeeName ?? null) : null;

  const filter = (patch: Partial<LeaveUrl>) => setLu({ ...patch, hpage: "", hclaim: "" });
  const filtersOn = [
    lu.hkind,
    lu.hstatus === "all" ? "" : lu.hstatus,
    lu.hraised,
    lu.hdept,
    lu.hbranch,
    lu.hq,
    lu.hemp,
  ].filter((v) => v !== "").length;

  const confirmWithdraw = async () => {
    if (!withdrawing) return;
    try {
      await withdraw.mutateAsync(withdrawing.id);
      toast({
        title: "Claim withdrawn",
        description: `${withdrawing.employeeName}, ${kindText(withdrawing)}, ${dateShort(withdrawing.workDate)}.`,
      });
    } catch (err) {
      toast({ title: "Could not withdraw it", description: errorMessage(err, "Try again."), variant: "destructive" });
    } finally {
      setWithdrawing(null);
    }
  };

  const confirmReject = (comment: string) =>
    once(async () => {
      if (!rejecting) return;
      setRejectError(null);
      try {
        await decide.mutateAsync({ id: rejecting.id, status: "rejected", comment });
        toast({
          title: "Compensation day rejected",
          description: `${rejecting.employeeName}: ${placedDayLine(rejecting) ?? kindText(rejecting)}.`,
        });
        setRejecting(null);
      } catch (err) {
        setRejectError(errorMessage(err, "It could not be rejected. Check the connection and try again."));
      }
    });

  const columns = useMemo<DataColumn<CompensationClaim>[]>(
    () => [
      {
        key: "employee",
        header: "Employee",
        cell: (c) => <PersonCell name={c.employeeName} code={c.employeeCode} sub={c.department} size={28} />,
        text: (c) => `${c.employeeName} (${c.employeeCode})`,
        minWidth: 180,
        truncate: false,
      },
      {
        key: "kind",
        header: "Kind",
        cell: (c) => (
          <div className="leading-tight">
            <p className="font-medium text-slate-900">{kindText(c)}</p>
            <p className="text-[11px] text-slate-500">Raised by {raisedByText(c)}</p>
          </div>
        ),
        text: (c) => `${kindText(c)} · raised by ${raisedByText(c)}`,
        minWidth: 170,
      },
      {
        key: "date",
        header: "Date",
        cell: (c) => (
          <div className="leading-tight">
            <p className="font-semibold text-slate-900">{dateShort(c.workDate)}</p>
            <p className="text-[11px] text-slate-500">{claimDateDetail(c)}</p>
          </div>
        ),
        text: (c) => `${dateLong(c.workDate)} · ${claimDateDetail(c)}`,
        minWidth: 150,
        maxWidth: 260,
      },
      {
        key: "amount",
        header: "Claimed",
        cell: (c) => <span className="font-semibold text-slate-900">{claimAmountText(c)}</span>,
        minWidth: 100,
      },
      {
        key: "status",
        header: "Approval",
        truncate: false,
        minWidth: 170,
        cell: (c) => {
          const decided = decisionLine(c);
          const stage = placementChip(c);
          const dayOff = placedDayLine(c);
          return (
            <div className="flex flex-col items-start gap-0.5">
              <StatusChip
                tone={stage && c.stage === "hr" ? "amber" : (STATUS_TONE[c.status] ?? "slate")}
                title={stage?.title}
                testId={`claim-status-${c.id}`}
              >
                {stage?.text ?? claimStatusText(c)}
              </StatusChip>
              {stage?.done && (
                <span className="text-[11px] text-slate-500" data-testid={`claim-stage-${c.id}`}>
                  {stage.done}
                </span>
              )}
              {dayOff && (
                <span className="text-[11px] font-medium text-slate-700" data-testid={`claim-dayoff-${c.id}`}>
                  {dayOff}
                </span>
              )}
              {c.hrStep && c.status === "pending" ? null : c.status === "pending" ? (
                <span className="text-[11px] text-slate-500" data-testid={`claim-hod-${c.id}`}>
                  {c.hodName ? `HOD: ${c.hodName}` : "No Department Head assigned"}
                </span>
              ) : (
                decided && (
                  <span className="text-[11px] text-slate-500" data-testid={`claim-decision-${c.id}`}>
                    {decided}
                  </span>
                )
              )}
            </div>
          );
        },
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        align: "right",
        truncate: false,
        cell: (c) => (
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-11 sm:h-8"
              aria-label={`Details of the claim of ${c.employeeName} for ${dateShort(c.workDate)}`}
              onClick={() => setLu({ hclaim: String(c.id) })}
              data-view-safe=""
              data-testid={`claim-view-${c.id}`}
            >
              Details
            </Button>
            {canChooseDateFor(c) && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-11 sm:h-8"
                disabled={!canWithdraw || !!rightProblem}
                aria-label={`Choose a day off for ${c.employeeName} from this credit`}
                title={
                  !canWithdraw
                    ? pausedReason
                    : (rightProblem ??
                      `Choose date: place the ${fmtShifts(c.leftToPlace ?? 0)} left of this credit on a day off for ${c.employeeName} and send it to the Department Head, then HR`)
                }
                onClick={() =>
                  setPlacing({
                    employeeId: c.employeeId,
                    employeeName: c.employeeName,
                    employeeCode: c.employeeCode,
                    source: claimSource(c.id),
                  })
                }
                data-testid={`claim-place-${c.id}`}
              >
                Choose date
              </Button>
            )}
            {hrMayApprovePlacement(c) || hrMayRejectPlacement(c) ? (
              <PlacementDecision claim={c} onReject={setRejecting} onRejectOpen={() => setRejectError(null)} />
            ) : (
              c.status === "pending" && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-11 sm:h-8"
                  disabled={!canWithdraw}
                  aria-label={`Withdraw the claim of ${c.employeeName} for ${dateShort(c.workDate)}`}
                  title={canWithdraw ? "Withdraw and remove this claim from the Department Head's queue" : pausedReason}
                  onClick={() => setWithdrawing(c)}
                  data-testid={`claim-withdraw-${c.id}`}
                >
                  Withdraw
                </Button>
              )
            )}
          </div>
        ),
      },
    ],
    [canWithdraw, pausedReason, setLu, rightProblem],
  );

  // three tiles side by side on a tablet, two on a phone: the label and the hint wrap instead of being cut off
  const statusTile = (status: "pending" | "approved" | "rejected", label: string, hint: string, icon: typeof Sun) => (
    <StatTile
      label={label}
      wrapLabel
      value={summary?.byStatus[status] ?? 0}
      hint={hint}
      wrapHint
      icon={icon}
      tone={STATUS_TONE[status]}
      loading={query.isLoading}
      onClick={() => filter({ hstatus: lu.hstatus === status ? "all" : status })}
      active={lu.hstatus === status}
      title={`Show only the claims that are ${label.toLowerCase()}`}
      testId={`claim-kpi-${status}`}
    />
  );

  return (
    <SectionCard
      testId="claim-list"
      icon={ClipboardCheck}
      title="Claims"
      description="Every compensation claim, from the employees' apps and from HR, with where it stands in the Department Head's approval and what it put on the balance."
      bodyClassName="space-y-3"
    >
      {warnings.length > 0 && (
        <Notice accent="amber" testId="claim-warnings">
          <p className="font-semibold">Raised, but nobody can decide these yet:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
          <button
            type="button"
            className="font-semibold underline"
            onClick={onDismissWarnings}
            data-testid="claim-warnings-dismiss"
          >
            Dismiss
          </button>
        </Notice>
      )}

      <FilterBar label="Claim filters" testId="claim-filters" sticky={false}>
        <MonthFilter
          value={month}
          today={today}
          allowAll
          onChange={(m, y) => filter({ hmonth: m, hyear: y })}
          label="Month of the claim"
          testId="claim-month"
        />
        <SelectFilter
          label="Kind"
          value={lu.hkind}
          onChange={(v) => filter({ hkind: v })}
          options={KIND_OPTIONS}
          allLabel="Every kind"
          testId="claim-kind"
        />
        <SelectFilter
          label="Status"
          value={lu.hstatus === "all" ? "" : lu.hstatus}
          onChange={(v) => filter({ hstatus: v === "" ? "all" : v })}
          options={CLAIM_STATUS_FILTER}
          allLabel="Every status"
          testId="claim-status"
        />
        <SelectFilter
          label="Raised by"
          value={lu.hraised}
          onChange={(v) => filter({ hraised: v })}
          options={RAISED_BY_OPTIONS}
          allLabel="Raised by anyone"
          testId="claim-raised"
        />
        <OrgFilters
          dept={lu.hdept}
          branch={lu.hbranch}
          onDept={(v) => filter({ hdept: v })}
          onBranch={(v) => filter({ hbranch: v })}
          testId="claim"
        />
        <SearchFilter
          value={lu.hq}
          onChange={(v) => filter({ hq: v })}
          placeholder="Name or code"
          label="Search the claims by name or code"
          testId="claim-search"
        />
        {lu.hemp && <EmployeeChip name={employeeName} onClear={() => filter({ hemp: "" })} testId="claim-employee" />}
        <ClearFilters
          count={filtersOn}
          onClear={() => filter({ hkind: "", hstatus: "all", hraised: "", hdept: "", hbranch: "", hq: "", hemp: "" })}
          testId="claim-clear"
        />
      </FilterBar>

      <StatRow columns={3} testId="claim-kpis">
        {statusTile("pending", "Waiting for HOD", pendingHint(summary), UserCheck)}
        {statusTile(
          "approved",
          "Approved",
          `${fmtShifts(summary?.creditedShifts ?? summary?.approvedShifts ?? 0)} shifts credited`,
          ClipboardCheck,
        )}
        {statusTile("rejected", "Rejected", "nothing credited", XCircle)}
      </StatRow>
      {/* five tiles in a row only from 1280 px (with the sidebar they are too narrow before); short labels that wrap */}
      <StatRow columns={5} className="lg:grid-cols-3 xl:grid-cols-5" testId="claim-kinds">
        {CLAIM_KINDS.map((kind) => (
          <StatTile
            key={kind}
            label={KIND_TILE_LABEL[kind]}
            wrapLabel
            value={summary?.byKind[kind] ?? 0}
            icon={KIND_ICON[kind]}
            tone={KIND_TONE[kind]}
            loading={query.isLoading}
            onClick={() => filter({ hkind: lu.hkind === kind ? "" : kind })}
            active={lu.hkind === kind}
            title={`Show only: ${KIND_LABEL[kind]}`}
            testId={`claim-kpi-kind-${kind}`}
          />
        ))}
      </StatRow>

      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(c) => c.id}
        onRowClick={(c) => setLu({ hclaim: String(c.id) })}
        rowLabel={(c) => `Open the claim of ${c.employeeName}, ${kindText(c)}, ${dateShort(c.workDate)}`}
        selectedKey={openId}
        loading={query.isLoading}
        error={
          query.isError && !query.data
            ? `Could not load the claims. ${errorMessage(query.error, "Check the connection and try again.")}`
            : null
        }
        onRetry={() => void query.refetch()}
        empty={{
          icon: SearchX,
          title: filtersOn > 0 ? "No claim matches these filters" : `No claim for ${monthChoiceLabel(month)}`,
          hint: "Claims are filed under their date (the work, the OT, the birthday or the day off). Change the month or a filter, or raise one in the Raise a claim tab.",
        }}
        pagination={{
          page: pageOf(lu.hpage),
          pageSize: CLAIMS_PAGE_SIZE,
          total: query.data?.total ?? 0,
          onPageChange: (p) => setLu({ hpage: p > 1 ? String(p) : "" }),
        }}
        caption="Compensation claims"
        testId="claims-table"
      />

      <ClaimDrawer
        claim={open}
        onClose={() => setLu({ hclaim: "" })}
        canWithdraw={canWithdraw}
        pausedReason={pausedReason}
        onWithdraw={(c) => {
          setLu({ hclaim: "" });
          setWithdrawing(c);
        }}
      />

      <PlaceCompDialog target={placing} onClose={() => setPlacing(null)} />

      <RejectReasonDialog
        open={rejecting !== null}
        title="Reject this compensation day?"
        description={
          rejecting ? `${rejecting.employeeName}, ${placedDayLine(rejecting) ?? kindText(rejecting)}.` : undefined
        }
        confirmLabel="Reject"
        busy={decide.isPending}
        error={rejectError}
        onCancel={() => setRejecting(null)}
        onConfirm={(reason) => void confirmReject(reason)}
        testIdPrefix="claim-reject"
      />

      <AlertDialog
        open={withdrawing !== null}
        onOpenChange={(isOpen) => !isOpen && !withdraw.isPending && setWithdrawing(null)}
      >
        <AlertDialogContent data-testid="claim-withdraw-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Withdraw this claim?</AlertDialogTitle>
            <AlertDialogDescription>
              {withdrawing
                ? `${withdrawing.employeeName}, ${kindText(withdrawing)}, ${dateShort(withdrawing.workDate)}, ${claimAmountText(withdrawing)}. The claim leaves the Department Head's queue and nothing is credited. It can be raised again later.`
                : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={withdraw.isPending}>Keep the claim</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                void confirmWithdraw();
              }}
              disabled={withdraw.isPending}
              data-testid="claim-withdraw-confirm"
            >
              Withdraw claim
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SectionCard>
  );
}

/**
 * HR's step on a date HR chose, once the Department Head has approved it: Approve gives the day (one click), Reject asks
 * for the reason first (the shared dialog, opened by the list).
 */
function PlacementDecision({
  claim,
  onReject,
  onRejectOpen,
}: {
  claim: CompensationClaim;
  onReject: (claim: CompensationClaim) => void;
  onRejectOpen: () => void;
}) {
  const { toast } = useToast();
  const decide = useDecidePlacement();
  const once = useSingleFlight();
  const approve = () =>
    once(async () => {
      try {
        await decide.mutateAsync({ id: claim.id, status: "approved" });
        toast({
          title: "Compensation day approved",
          description: `${claim.employeeName}: ${placedDayLine(claim) ?? kindText(claim)}.`,
        });
      } catch (err) {
        toast({ title: "Could not approve it", description: errorMessage(err, "Try again."), variant: "destructive" });
      }
    });
  return (
    <>
      {hrMayApprovePlacement(claim) && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-11 border-teal-200 text-teal-700 hover:bg-teal-50 sm:h-8"
          disabled={decide.isPending}
          aria-label={`Approve the compensation day of ${claim.employeeName}`}
          title="Approve: HR's step after the Department Head; the day is given"
          onClick={() => void approve()}
          data-testid={`claim-approve-${claim.id}`}
        >
          {decide.isPending && <Loader2 size={13} className="mr-1 animate-spin" aria-hidden />}
          Approve
        </Button>
      )}
      {hrMayRejectPlacement(claim) && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-11 text-rose-600 sm:h-8"
          disabled={decide.isPending}
          aria-label={`Reject the compensation day of ${claim.employeeName}`}
          title="Reject: a reason is required; the employee sees it"
          onClick={() => {
            onRejectOpen();
            onReject(claim);
          }}
          data-testid={`claim-reject-${claim.id}`}
        >
          Reject
        </Button>
      )}
    </>
  );
}
