import { LogIn } from "lucide-react";
import AskAiButton from "@/components/md/kit/AskAiButton";
import { CHART } from "@/components/md/kit/chartTheme";
import SectionCard from "@/components/md/kit/SectionCard";
import { EmptyBlock, ErrorBanner } from "@/components/md/kit/states";
import TrendChart from "@/components/md/kit/TrendChart";
import { describeMdError, useMdQuery, type MdQueryParams } from "@/lib/api-client/custom-hooks/md";
import { dayShort, num } from "@/lib/md/format";
import { ask, changeText, plural } from "./logic";
import { ListHeading, MiniStat } from "./parts";
import SecuritySignals from "./SecuritySignals";
import SignInPeople from "./SignInPeople";
import type { ActivitySignIns } from "./types";

/** Sign-ins and devices: how many, who, from what, and the security signals (failed attempts, lock-outs, new devices,
 *  sessions open together, accounts nobody uses). */
export default function SignInsCard({ params, label }: { params: MdQueryParams; label: string }) {
  const q = useMdQuery<ActivitySignIns>("activity/sign-ins", { ...params, limit: 25 });
  const s = q.data;
  const nothing = s && s.signIns.value === 0 && s.failed.value === 0 && s.accounts.length === 0;
  const privilegedNew = s?.newDevices.some((d) => d.privileged) ?? false;
  return (
    <SectionCard
      title="Sign-ins and devices"
      subtitle="Who signed in to the HR portal, from what, and anything that looks wrong"
      provenance={s?.provenance}
      loading={q.isPending}
      actions={<AskAiButton question={ask.signIns(label)} />}
      testId="md-activity-sign-ins"
    >
      {q.isError ? (
        <ErrorBanner message={describeMdError(q.error)} onRetry={() => q.refetch()} />
      ) : nothing ? (
        <EmptyBlock icon={LogIn} title="No sign-ins in this period" testId="md-activity-signins-empty">
          Nobody signed in to the HR portal, and no accounts exist to list.
        </EmptyBlock>
      ) : s ? (
        <div className="space-y-5">
          <div
            className="grid grid-cols-2 gap-3 @md:grid-cols-3 @4xl:grid-cols-6"
            data-testid="md-activity-signin-stats"
          >
            <MiniStat label="Sign-ins" value={num(s.signIns.value)} sub={`${changeText(s.signIns.change)} vs before`} />
            <MiniStat
              label="People who signed in"
              value={num(s.signIns.people)}
              sub={`of ${num(s.totalAccounts)} ${plural(s.totalAccounts, "account")}`}
            />
            <MiniStat
              label="Failed attempts"
              value={num(s.failed.value)}
              tone={s.failed.lockouts > 0 ? "bad" : "neutral"}
              sub={
                s.failed.lockouts > 0
                  ? `${num(s.failed.lockouts)} ${plural(s.failed.lockouts, "lock-out")}`
                  : `${changeText(s.failed.change)} vs before`
              }
            />
            <MiniStat
              label="New devices"
              value={num(s.newDevicesTotal)}
              tone={privilegedNew ? "bad" : "neutral"}
              sub={privilegedNew ? "including a privileged account" : "first use of a device"}
            />
            <MiniStat
              label="Open at the same time"
              value={num(s.concurrent.overlappingSignIns)}
              sub={`${num(s.concurrent.liveNow.sessions)} signed in now`}
            />
            <MiniStat
              label="Dormant accounts"
              value={num(s.dormant.count)}
              tone={s.dormant.count > 0 ? "bad" : "good"}
              sub={`no sign-in for ${s.dormant.days}+ days`}
            />
          </div>

          <div className="md-panel p-4">
            <ListHeading>
              Sign-ins and failed attempts {s.granularity === "week" ? "each week" : "each day"}
            </ListHeading>
            <TrendChart
              data={s.daily}
              xKey="date"
              series={[
                { key: "signIns", label: "Sign-ins", kind: "bar", color: CHART.brand },
                { key: "failed", label: "Failed attempts", kind: "line", color: CHART.bad },
              ]}
              xFormat={dayShort}
              yFormat={(n) => num(n)}
              height={170}
            />
          </div>

          <div className="grid grid-cols-1 items-start gap-4 @4xl:grid-cols-12">
            <div className="md-panel min-w-0 p-4 @4xl:col-span-7">
              <ListHeading>People</ListHeading>
              <SignInPeople accounts={s.accounts} />
              {s.totalAccounts > s.accounts.length && (
                <p className="mt-2 text-xs text-md-ink-soft">
                  Showing {num(s.accounts.length)} of {num(s.totalAccounts)} accounts.
                </p>
              )}
            </div>
            <div className="min-w-0 @4xl:col-span-5">
              <SecuritySignals data={s} />
            </div>
          </div>
        </div>
      ) : null}
    </SectionCard>
  );
}
