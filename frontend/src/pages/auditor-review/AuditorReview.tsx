import { useEffect, useState, type ReactNode } from "react";
import { useRoute } from "wouter";
import {
  AlertTriangle,
  Building2,
  CalendarClock,
  CalendarDays,
  CheckCircle2,
  ClipboardCheck,
  LayoutList,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Stamp,
  UserCheck,
} from "lucide-react";
import { useUrlParams } from "@/components/payroll/kit/url-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/pages/hr/settlement/shared";
import {
  useAuditorBulk,
  useAuditorChange,
  useAuditorSubmit,
  usePortal,
  useReloadPortal,
  type PortalBulkInput,
  type PortalChangeInput,
  type PortalData,
  type PortalDecision,
  type PortalItem,
} from "./api";
import ApprovalSection from "./ApprovalSection";
import AttendanceSection from "./AttendanceSection";
import {
  DECISION_LABEL,
  bankLines,
  linkValidity,
  portalBankFileName,
  portalBankSheet,
  portalProblem,
  portalTotals,
  refusalReloads,
  requestsWord,
  reviewRound,
  reviewStatus,
} from "./logic";
import OverviewSection from "./OverviewSection";
import { BODY_FONT, CARD, HEADING_FONT, TabBadge, TabBar } from "./parts";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const BAND = "linear-gradient(118deg, #00263d 0%, #004b72 42%, #006496 64%, #3640b0 100%)";

/** The page's one row of tabs (owner: never a tab inside a tab): each shows only its own section. */
export const PORTAL_TABS = ["overview", "attendance", "approval"] as const;
export type PortalTab = (typeof PORTAL_TABS)[number];
const URL_DEFAULTS = { tab: "" };
const asTab = (raw: string): PortalTab =>
  (PORTAL_TABS as readonly string[]).includes(raw) ? (raw as PortalTab) : "overview";

/** The bank file for Accounts, built here in the Payroll bank-file format from the approved settlement. */
async function buildPortalBankFile(data: PortalData): Promise<File> {
  const { buildBankFileWorkbook } = await import("@/lib/bankFile");
  const wb = await buildBankFileWorkbook(bankLines(data), portalBankSheet(data.settlement));
  const buffer = await wb.xlsx.writeBuffer();
  return new File([buffer], portalBankFileName(data.settlement), { type: XLSX_MIME });
}

/** The brand band behind the header (a short one on the message pages). */
function Band({ children, tall = true }: { children?: ReactNode; tall?: boolean }) {
  return (
    <div className="relative overflow-hidden text-white" style={{ background: BAND }}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-[0.09]"
        style={{
          backgroundImage: "radial-gradient(circle at 1px 1px, #ffffff 1px, transparent 0)",
          backgroundSize: "22px 22px",
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-[#4f8fff]/25 blur-3xl"
      />
      <div
        className={cn(
          "relative mx-auto flex max-w-[100rem] flex-wrap items-center justify-between gap-3 px-4 pt-5 sm:px-6",
          tall ? "pb-24" : "pb-16",
        )}
      >
        {children ?? (
          <p className="inline-flex items-center gap-2 text-[13px] font-semibold text-white/90">
            <ShieldCheck size={16} aria-hidden /> Auditor Review Portal
          </p>
        )}
      </div>
    </div>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <div
      className="min-h-screen bg-[#f3f5f9] text-slate-900 antialiased"
      style={{ fontFamily: BODY_FONT }}
      data-testid="auditor-portal"
    >
      {children}
      <footer className="mx-auto flex max-w-[100rem] flex-wrap items-center justify-center gap-x-2 gap-y-1 px-4 pb-10 pt-4 text-center text-[11.5px] text-slate-500 sm:px-6">
        <Lock size={12} aria-hidden />
        <span>A private review link for the auditor. Please do not forward it.</span>
      </footer>
    </div>
  );
}

/** The link does not open (not valid, replaced, expired, or the server cannot be reached): a clear message. */
function Problem({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const p = portalProblem(error);
  return (
    <Shell>
      <Band tall={false} />
      <main className="mx-auto -mt-10 max-w-lg px-4">
        <div
          className={cn(CARD, "space-y-3 p-8 text-center shadow-[0_12px_40px_-16px_rgba(0,45,71,0.35)]")}
          role="alert"
          data-testid="portal-problem"
          data-kind={p.kind}
        >
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-50 text-rose-600">
            <ShieldAlert size={26} aria-hidden />
          </div>
          <p className="text-xs font-semibold text-[#006496]">Auditor Review Portal</p>
          <h1
            className="text-xl font-bold text-slate-900"
            style={{ fontFamily: HEADING_FONT }}
            data-testid="portal-problem-title"
          >
            {p.title}
          </h1>
          <p className="text-sm text-slate-600" data-testid="portal-problem-text">
            {p.text}
          </p>
          {p.hint && (
            <p
              className="rounded-xl bg-slate-50 px-3 py-2 text-[12.5px] text-slate-500"
              data-testid="portal-problem-hint"
            >
              {p.hint}
            </p>
          )}
          {p.kind === "unavailable" && (
            <Button
              variant="outline"
              onClick={onRetry}
              className="border-[#006496]/30 text-[#006496]"
              data-testid="portal-retry"
            >
              Try again
            </Button>
          )}
        </div>
      </main>
    </Shell>
  );
}

function Fact({
  icon,
  label,
  children,
  testId,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 bg-white px-4 py-3 sm:gap-2.5 sm:px-5 sm:py-3.5">
      <span className="mt-0.5 shrink-0 text-slate-400">{icon}</span>
      <div className="min-w-0">
        <dt className="text-[11px] font-medium text-slate-500">{label}</dt>
        <dd className="text-[13px] font-medium text-slate-800" data-testid={testId}>
          {children}
        </dd>
      </div>
    </div>
  );
}

function Header({ data, tabs }: { data: PortalData; tabs: ReactNode }) {
  const c = data.company;
  const s = data.settlement;
  const status = reviewStatus(data);
  const t = portalTotals(data);
  const left = linkValidity(data.link.expiresAt);
  const round = reviewRound(data);
  const sub = [c.tagline, c.address, c.contact].filter(Boolean).join(" · ");
  return (
    <header data-testid="portal-header">
      <Band>
        <div className="flex min-w-0 items-center gap-3">
          {c.logo ? (
            <img src={c.logo} alt="" className="h-11 w-11 shrink-0 rounded-xl bg-white object-contain p-1 shadow-sm" />
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/15 ring-1 ring-white/25">
              <Building2 size={22} aria-hidden />
            </span>
          )}
          <div className="min-w-0">
            <p
              className="truncate text-[17px] font-bold leading-tight"
              style={{ fontFamily: HEADING_FONT }}
              data-testid="portal-company"
            >
              {c.name}
            </p>
            {sub && <p className="truncate text-[12px] text-white/70">{sub}</p>}
          </div>
        </div>
        <p className="inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/10 px-3 py-1.5 text-[12px] font-semibold text-white backdrop-blur-sm">
          <ShieldCheck size={14} aria-hidden /> Auditor Review Portal
        </p>
      </Band>

      <div className="relative mx-auto -mt-[4.5rem] max-w-[100rem] px-4 sm:px-6">
        <div className={cn(CARD, "shadow-[0_14px_44px_-18px_rgba(0,38,61,0.4)]")}>
          <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#006496]" data-testid="portal-eyebrow">
                {s.typeLabel} settlement · Audit
                {round > 1 && (
                  <span className="ml-2 inline-flex items-center rounded-full bg-violet-50 px-2 py-px text-[11px] font-semibold text-violet-700 ring-1 ring-violet-200">
                    Revised · round {round}
                  </span>
                )}
              </p>
              <h1
                className="mt-1 text-[24px] font-bold leading-tight text-slate-900 sm:text-[30px]"
                style={{ fontFamily: HEADING_FONT }}
                data-testid="portal-title"
              >
                {s.title}
              </h1>
              <p
                className="mt-1 inline-flex items-center gap-1.5 text-[14px] font-medium text-slate-600"
                data-testid="portal-period"
              >
                <CalendarDays size={15} className="text-slate-400" aria-hidden />
                {s.period} · {requestsWord(t.requests)}
              </p>
            </div>
            <span
              className={cn(
                "inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border px-3 py-1 text-[12.5px] font-semibold",
                status.tone === "success" && "border-emerald-200 bg-emerald-50 text-emerald-800",
                status.tone === "info" && "border-[#006496]/25 bg-[#006496]/[0.07] text-[#00466a]",
                status.tone === "neutral" && "border-slate-200 bg-slate-50 text-slate-600",
              )}
              data-testid="portal-status"
            >
              {status.tone === "success" ? (
                <CheckCircle2 size={14} aria-hidden />
              ) : status.tone === "info" ? (
                <span className="relative flex h-2 w-2" aria-hidden>
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[#006496] opacity-40" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-[#006496]" />
                </span>
              ) : (
                <Lock size={13} aria-hidden />
              )}
              {status.text}
            </span>
          </div>

          <dl className="grid grid-cols-2 gap-px border-t border-slate-100 bg-slate-100 lg:grid-cols-4">
            <Fact icon={<CalendarDays size={15} />} label="Settlement month">
              {s.period} · Batch {s.number}
            </Fact>
            <Fact icon={<ClipboardCheck size={15} />} label="Finalized by HR" testId="portal-finalized">
              {s.finalizedAt ? formatDateTime(s.finalizedAt) : "-"}
              {s.finalizedBy ? ` by ${s.finalizedBy}` : ""}
            </Fact>
            <Fact icon={<UserCheck size={15} />} label="Confirmed by the MD">
              {s.mdConfirmedBy ?? "-"}
            </Fact>
            <Fact icon={<CalendarClock size={15} />} label="Link valid until" testId="portal-valid-until">
              {formatDateTime(data.link.expiresAt)}
              {left && !data.link.submittedAt && (
                <span
                  className={cn(
                    "ml-1.5 inline-block rounded-full px-1.5 py-px text-[11px] font-semibold",
                    left === "Expired" || left === "Expires today"
                      ? "bg-rose-50 text-rose-700"
                      : "bg-slate-100 text-slate-600",
                  )}
                  data-testid="portal-days-left"
                >
                  {left}
                </span>
              )}
            </Fact>
          </dl>

          {(s.finalNote || s.mdNote) && (
            <div className="grid gap-2 border-t border-slate-100 px-5 py-3.5 text-[12.5px] md:grid-cols-2">
              {s.mdNote && (
                <p className="rounded-xl border-l-[3px] border-indigo-400 bg-indigo-50/60 px-3 py-2 text-slate-700">
                  <b className="font-semibold text-slate-900">
                    MD&apos;s instructions{s.mdConfirmedBy ? ` (${s.mdConfirmedBy})` : ""}:
                  </b>{" "}
                  {s.mdNote}
                </p>
              )}
              {s.finalNote && (
                <p className="rounded-xl border-l-[3px] border-[#006496] bg-[#006496]/[0.05] px-3 py-2 text-slate-700">
                  <b className="font-semibold text-slate-900">HR&apos;s note:</b> {s.finalNote}
                </p>
              )}
            </div>
          )}

          <div className="border-t border-slate-100 px-2 sm:px-4" id="portal-tabs-anchor">
            {tabs}
          </div>
        </div>
      </div>
    </header>
  );
}

/**
 * The Auditor Review Portal (owner 2026-11-27): a public page opened from the e-mailed link, no HRMS login. The auditor
 * reviews one settlement (one type's batch of a month) as HR finalized it: Overview (the summary and the requests in the
 * report's format for the batch's type, with selection, bulk approve / reject and each request's own actions),
 * Attendance & Time Card (the employees' attendance behind the figures), Approval (the changes and the answer). One row
 * of tabs in the header, each showing only its own section; read-only once answered.
 */
export default function AuditorReview() {
  const [, params] = useRoute("/auditor-review/:token");
  const token = params?.token ?? "";
  const { toast } = useToast();
  const portal = usePortal(token);
  const reload = useReloadPortal(token);
  const change = useAuditorChange(token);
  const bulk = useAuditorBulk(token);
  const submit = useAuditorSubmit(token);
  const [url, setUrl] = useUrlParams(URL_DEFAULTS);
  const [warning, setWarning] = useState<string | null>(null);
  const tab = asTab(url.tab);
  const data = portal.data;

  useEffect(() => {
    if (data) document.title = `${data.settlement.title} · ${data.settlement.period} · Auditor Review`;
  }, [data]);

  if (!token) return <Problem error={null} onRetry={() => undefined} />;
  if (portal.isLoading) {
    return (
      <Shell>
        <Band />
        <div
          className="relative mx-auto -mt-[4.5rem] max-w-[100rem] space-y-5 px-4 sm:px-6"
          data-testid="portal-loading"
        >
          <Skeleton className="h-56 w-full rounded-2xl bg-white" />
          <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
            {[0, 1, 2, 3, 4].map((n) => (
              <Skeleton key={n} className="h-28 rounded-2xl bg-white" />
            ))}
          </div>
          <Skeleton className="h-80 w-full rounded-2xl bg-white" />
        </div>
      </Shell>
    );
  }
  if (portal.isError || !data) return <Problem error={portal.error} onRetry={() => void portal.refetch()} />;

  // a change or an answer the server refuses because the review changed (answered, closed, expired): read it again
  const onChange = async (item: PortalItem, body: PortalChangeInput) => {
    try {
      await change.mutateAsync({ itemId: item.id, body });
    } catch (err) {
      if (refusalReloads(err)) void reload();
      throw err;
    }
  };
  const onBulk = async (body: PortalBulkInput) => {
    try {
      await bulk.mutateAsync(body);
    } catch (err) {
      if (refusalReloads(err)) void reload();
      throw err;
    }
  };
  const onSubmit = async (decision: PortalDecision, note: string) => {
    try {
      const bank = decision === "approved_send_accounts" ? await buildPortalBankFile(data) : undefined;
      const reply = await submit.mutateAsync({ decision, note, bank });
      setWarning(reply.warning ?? null);
      toast({ title: "Review submitted", description: DECISION_LABEL[decision] });
    } catch (err) {
      if (refusalReloads(err)) void reload();
      throw err;
    }
  };
  const goTo = (next: PortalTab) => {
    setUrl({ tab: next === "overview" ? "" : next });
    document.getElementById("portal-tabs-anchor")?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  };

  const t = portalTotals(data);
  const tabBar = (
    <TabBar<PortalTab>
      value={tab}
      onChange={(next) => setUrl({ tab: next === "overview" ? "" : next })}
      tabs={[
        {
          value: "overview",
          label: "Overview",
          icon: LayoutList,
          badge: t.changes > 0 ? <TabBadge tone="warning">{t.changes}</TabBadge> : undefined,
        },
        {
          value: "attendance",
          label: (
            <>
              Attendance<span className="hidden sm:inline"> &amp; Time Card</span>
            </>
          ),
          icon: CalendarClock,
        },
        {
          value: "approval",
          label: "Approval",
          icon: Stamp,
          badge: data.link.submittedAt ? (
            <CheckCircle2 size={14} className="text-emerald-600" aria-label="submitted" />
          ) : undefined,
        },
      ]}
    />
  );

  return (
    <Shell>
      <Header data={data} tabs={tabBar} />

      <main className="mx-auto w-full max-w-[100rem] space-y-4 px-4 py-5 sm:px-6 sm:py-6">
        {data.link.submittedAt && (
          <div
            className="flex items-start gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900"
            role="status"
            data-testid="portal-submitted"
          >
            <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-emerald-700" aria-hidden />
            <p>
              <b>Review submitted on {formatDateTime(data.link.submittedAt)}</b>
              {data.link.decision ? ` — ${DECISION_LABEL[data.link.decision]}` : ""}. Thank you.{" "}
              {data.link.decision === "changes_forward_hr"
                ? "HR reworks it and sends you the revised settlement with a new link for your approval. This one is shown read-only."
                : "The settlement is shown read-only."}
            </p>
          </div>
        )}
        {warning && (
          <div
            className="flex items-start gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
            role="alert"
            data-testid="portal-warning"
          >
            <AlertTriangle size={20} className="mt-0.5 shrink-0 text-amber-700" aria-hidden />
            <p>{warning}</p>
          </div>
        )}
        {!data.link.submittedAt && !data.canReview && (
          <div
            className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600"
            role="status"
            data-testid="portal-read-only"
          >
            <Lock size={18} className="mt-0.5 shrink-0 text-slate-400" aria-hidden />
            <p>This settlement is no longer waiting for your review. It is shown read-only.</p>
          </div>
        )}

        <div role="tabpanel" id={`portal-panel-${tab}`} aria-labelledby={`portal-tab-${tab}`}>
          {tab === "overview" ? (
            <OverviewSection
              data={data}
              token={token}
              onChange={onChange}
              onBulk={onBulk}
              onGoApproval={() => goTo("approval")}
            />
          ) : tab === "attendance" ? (
            <AttendanceSection data={data} token={token} />
          ) : (
            <ApprovalSection data={data} onSubmit={onSubmit} onGoOverview={() => goTo("overview")} />
          )}
        </div>
      </main>
    </Shell>
  );
}
