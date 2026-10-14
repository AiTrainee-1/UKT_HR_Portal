import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useParams, useSearch } from "wouter";
import HrLayout from "@/components/HrLayout";
import { dateTime } from "@/components/payroll/kit/format";
import { cameFromPayroll, payrollDetailsPath, payrollListPath } from "@/components/payroll/kit/url-state";
import { usePayrollSettings, type PayrollDetails, type PayrollKind } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { ACCENT, type Accent } from "./accent";
import { AttendanceCard } from "./AttendanceCard";
import { EmployeeCard } from "./EmployeeCard";
import { detailsExportItems } from "./exports";
import { DetailsHeader } from "./Header";
import { HistoryCard } from "./HistoryCard";
import { IssuesCard } from "./IssuesCard";
import { KpiStrip, NetBridge } from "./Kpis";
import {
  SECTION_IDS,
  backLabelFor,
  changedRules,
  fallbackListPath,
  isDegraded,
  normalizeDetails,
  parsePayrollId,
  parseSectionParam,
  severityCounts,
} from "./logic";
import { OverviewCard } from "./OverviewCard";
import { DegradedNotice, ErrorState, NotFoundState, PageSkeleton, StaleBar, SwitchingChip } from "./PageStates";
import { PayExtrasCard } from "./PayExtrasCard";
import { PRINT_CSS } from "./print";
import { RulesCard, type RuleFocus } from "./RulesCard";
import { scrollPageToTop, useSectionSpy } from "./scroll";
import { SectionNav } from "./SectionNav";
import { useIssueFilters } from "./use-issue-filters";
import { isMissingError, useMarkPaid, usePayrollDetailsView } from "./use-details";

/**
 * One payroll, broken down: its dashboard, the rules behind it, every issue payroll detected (with the day each was
 * detected), the days, the extras on the pay, the employee and their earlier payrolls. A page of its own (not a
 * dialog): the way back is a Back button that returns to the list exactly as it was left, and Previous / Next walk
 * the payrolls of the same period. It only ever reads what payroll already stored; it never recomputes anything.
 */
export function PayrollDetailsPage({ kind }: { kind: PayrollKind }) {
  const params = useParams<{ id: string }>();
  const id = parsePayrollId(params.id);
  const accent = ACCENT[kind];
  const [, navigate] = useLocation();
  const section = parseSectionParam(new URLSearchParams(useSearch()).get("section"));
  const query = usePayrollDetailsView(kind, id);

  const raw = query.data;
  const details = useMemo(() => (raw ? normalizeDetails(raw) : null), [raw]);
  // Previous / Next: the old payroll stays on screen while the next one loads.
  const switching = query.isPlaceholderData;
  const backLabel = backLabelFor(kind, details);

  // Back returns to the list exactly as it was (same tab, period and filters) when the list opened this page;
  // a pasted link has no list behind it, so it goes to the list of the payroll's own period.
  const goBack = useCallback(() => {
    if (cameFromPayroll()) window.history.back();
    else navigate(details ? payrollListPath(details.context) : fallbackListPath(kind));
  }, [details, kind, navigate]);

  // Previous / Next replace the entry (and keep its state), so Back still leaves for the list in one step.
  const goToPayroll = useCallback(
    (payrollId: number) =>
      navigate(payrollDetailsPath(kind, payrollId, section ?? undefined), {
        replace: true,
        state: window.history.state,
      }),
    [kind, navigate, section],
  );

  // Another payroll opened in this page (Previous / Next, or one of the earlier payrolls) starts at its top, not where
  // the last one was scrolled to: the shell's scroll area is the same element for every payroll. A section named in the
  // address wins (DetailsBody scrolls to it), and a page opened for the first time is left where the shell puts it.
  const page = useRef<HTMLDivElement>(null);
  const shownId = useRef<number | null>(null);
  const loadedId = !switching && details ? details.payrollId : null;
  useEffect(() => {
    if (loadedId === null) return;
    if (shownId.current !== null && shownId.current !== loadedId && !section) scrollPageToTop(page.current);
    shownId.current = loadedId;
  }, [loadedId, section]);

  let body: ReactNode;
  if (id === null) {
    body = <NotFoundState backLabel={backLabel} onBack={goBack} />;
  } else if (!details) {
    if (query.isError) {
      body = isMissingError(query.error) ? (
        <NotFoundState backLabel={backLabel} onBack={goBack} />
      ) : (
        <ErrorState
          message={query.error instanceof Error ? query.error.message : "The server did not answer."}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
          backLabel={backLabel}
          onBack={goBack}
        />
      );
    } else {
      body = <PageSkeleton accent={accent} backLabel={backLabel} onBack={goBack} />;
    }
  } else {
    body = (
      <DetailsBody
        // a different period starts with fresh filters; the next payroll of the same period keeps them
        key={`${details.period.start}_${details.period.end}`}
        details={details}
        kind={kind}
        accent={accent}
        switching={switching}
        stale={query.isError && !switching}
        refreshing={query.isFetching && !switching}
        backLabel={backLabel}
        section={section}
        onBack={goBack}
        onNeighbour={goToPayroll}
        onRefresh={() => void query.refetch()}
      />
    );
  }

  return (
    <HrLayout>
      <style>{PRINT_CSS}</style>
      <div ref={page} className="pd-root space-y-5" data-testid="payroll-details-page" data-kind={kind}>
        {body}
      </div>
      {switching && <SwitchingChip kind={kind} />}
    </HrLayout>
  );
}

function DetailsBody({
  details,
  kind,
  accent,
  switching,
  stale,
  refreshing,
  backLabel,
  section,
  onBack,
  onNeighbour,
  onRefresh,
}: {
  details: PayrollDetails;
  kind: PayrollKind;
  accent: Accent;
  switching: boolean;
  stale: boolean;
  refreshing: boolean;
  backLabel: string;
  section: string | null;
  onBack: () => void;
  onNeighbour: (payrollId: number) => void;
  onRefresh: () => void;
}) {
  const filters = useIssueFilters();
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const [ruleFocus, setRuleFocus] = useState<RuleFocus>(null);
  const degraded = isDegraded(details);
  const { markPaid, busy } = useMarkPaid();
  const settings = usePayrollSettings();
  const company = settings.data?.companyName || "UK Textiles";
  const { active, jump } = useSectionSpy(SECTION_IDS);

  const counts = useMemo(() => severityCounts(details.issues), [details.issues]);
  const changed = useMemo(() => changedRules(details.rules).length, [details.rules]);
  const ruleKeys = useMemo(() => new Set(details.rules.flatMap((g) => g.items.map((i) => i.key))), [details.rules]);
  const exportItems = useMemo(() => detailsExportItems({ details, company }), [details, company]);

  // `?section=issues` opens the page scrolled to that section (once per payroll and section).
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (!section || switching) return;
    const stamp = `${details.payrollId}:${section}`;
    if (scrolledFor.current === stamp) return;
    const frame = requestAnimationFrame(() => {
      scrolledFor.current = stamp;
      jump(section, false);
    });
    return () => cancelAnimationFrame(frame);
  }, [section, switching, details.payrollId, jump]);

  const { setDay } = filters;
  const selectDay = useCallback(
    (date: string | null) => {
      setSelectedDay(date);
      setDay(date);
    },
    [setDay],
  );
  const showRule = useCallback(
    (key: string) => {
      jump("rules");
      setRuleFocus({ key, nonce: Date.now() });
    },
    [jump],
  );

  return (
    <div
      className={cn("space-y-5 transition-opacity", switching && "opacity-60")}
      aria-busy={switching || undefined}
      inert={switching || undefined}
      data-testid="pd-body"
      data-switching={switching ? "true" : "false"}
    >
      {stale && <StaleBar onRetry={onRefresh} retrying={refreshing} />}

      <div className="hidden print:block" data-testid="pd-print-header">
        <p className="text-lg font-black text-gray-900">{company}: payroll details</p>
        <p className="text-sm text-gray-700">
          {details.employee.name} ({details.employee.code}) · {details.period.label} · printed{" "}
          {dateTime(new Date().toISOString())}
        </p>
      </div>

      <DetailsHeader
        details={details}
        kind={kind}
        accent={accent}
        switching={switching}
        backLabel={backLabel}
        onBack={onBack}
        onNeighbour={onNeighbour}
        onMarkPaid={() => void markPaid(details.payrollId, details.employee.name)}
        markingPaid={busy}
        onRefresh={onRefresh}
        refreshing={refreshing}
        exportItems={exportItems}
      />

      {degraded && <DegradedNotice legacy={details.kind === "legacy_session"} notes={details.notes} />}

      <KpiStrip details={details} kind={kind} accent={accent} degraded={degraded} onJump={jump} />
      <NetBridge details={details} />

      <SectionNav
        active={active}
        onJump={jump}
        accent={accent}
        issues={details.issues.length}
        criticalIssues={counts.critical}
        changedRules={changed}
        who={`${details.employee.name} · ${details.employee.code}`}
      />

      <OverviewCard details={details} kind={kind} accent={accent} ruleKeys={ruleKeys} onShowRule={showRule} />
      <RulesCard groups={details.rules} accent={accent} focus={ruleFocus} />
      <IssuesCard details={details} accent={accent} state={filters} company={company} degraded={degraded} />
      <AttendanceCard
        details={details}
        kind={kind}
        accent={accent}
        selectedDay={selectedDay}
        onSelectDay={selectDay}
        onShowIssues={() => jump("issues")}
      />
      <PayExtrasCard details={details} accent={accent} />
      <EmployeeCard details={details} kind={kind} accent={accent} />
      <HistoryCard details={details} kind={kind} accent={accent} />
    </div>
  );
}

export default PayrollDetailsPage;
