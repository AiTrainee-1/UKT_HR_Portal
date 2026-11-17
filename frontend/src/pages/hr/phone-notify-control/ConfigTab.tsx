import type { ReactNode } from "react";
import { ArrowRight, Activity, Cloud, Database, Server, Smartphone, SmartphoneNfc, Workflow } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useMobileMessagesConfig } from "@/lib/api-client/custom-hooks";
import { HEALTH_LABEL, formatNumber, formatWhen, healthTone, percent, plural } from "./logic";
import { LoadError, Notice, Panel, StatusCard, type Tone } from "./ui";

const BADGE_TONE: Record<Tone, "success" | "warning" | "danger" | "info" | "neutral"> = {
  good: "success",
  warn: "warning",
  bad: "danger",
  info: "info",
  neutral: "neutral",
};

function Step({ icon: Icon, title, children }: { icon: typeof Server; title: string; children: ReactNode }) {
  return (
    <li className="min-w-0 flex-1 rounded-xl border bg-card p-3">
      <p className="flex items-center gap-1.5 text-sm font-semibold">
        <Icon size={14} className="shrink-0 text-sky-600" /> {title}
      </p>
      <p className="mt-1 text-xs leading-snug text-muted-foreground">{children}</p>
    </li>
  );
}

function Arrow() {
  return (
    <li aria-hidden className="hidden shrink-0 items-center text-muted-foreground lg:flex">
      <ArrowRight size={16} />
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] gap-3 py-1.5 text-sm">
      <span className="pt-0.5 text-xs font-semibold text-muted-foreground">{label}</span>
      <div className="min-w-0 break-words">{children}</div>
    </div>
  );
}

/**
 * Configuration: how a phone notification travels (HRMS -> Expo -> Firebase -> the phone), the service it uses, how well it
 * has been doing in the last 30 days with the reasons pushes failed (and what to do about each), and the phones registered.
 * There is nothing secret here: the push service needs no key on the server.
 */
export default function ConfigTab() {
  const { data, isLoading, isError, refetch } = useMobileMessagesConfig();
  if (isLoading) return <Skeleton className="h-96 rounded-2xl" />;
  if (isError || !data)
    return <LoadError what="The configuration" onRetry={() => void refetch()} testId="pn-config-error" />;

  const { service, health, phones } = data;
  const tone = healthTone(health.state);
  const deliveredRate = percent(health.delivered30, health.sent30);

  return (
    <div className="space-y-4" data-testid="pn-config">
      <Panel
        title="How a phone notification travels"
        description="Every notification takes the same road. A switch, a mute or a missing phone stops it at step 2; it is still saved at step 1."
        icon={Workflow}
        testId="pn-config-flow"
      >
        <ol className="flex flex-col gap-2 lg:flex-row lg:items-stretch">
          <Step icon={Database} title="1. Saved in the HRMS">
            The notification is saved for the employee and shows in the Notifications page of the app and the Employee
            Web App.
          </Step>
          <Arrow />
          <Step icon={Server} title={`2. Handed to the ${service.provider}`}>
            Unless phone notifications, its kind or the employee are switched off, it is sent to every phone the
            employee has registered.
          </Step>
          <Arrow />
          <Step icon={Cloud} title={`3. ${service.transport}`}>
            The {service.provider} passes it to Google&apos;s Firebase, which delivers it to the phone. A minute later
            the HRMS reads the receipt: &quot;Sent&quot; becomes &quot;Delivered&quot; or &quot;Push failed&quot;.
          </Step>
          <Arrow />
          <Step icon={Smartphone} title="4. On the phone">
            It appears in the notification bar and on the lock screen of the employee app ({service.appPackage}).
          </Step>
        </ol>
      </Panel>

      <Panel
        title="Health (last 30 days)"
        icon={Activity}
        testId="pn-config-health"
        actions={
          <span data-testid="pn-health-state" data-state={health.state}>
            <StatusBadge tone={BADGE_TONE[tone]}>{HEALTH_LABEL[health.state] ?? health.state}</StatusBadge>
          </span>
        }
      >
        <Notice tone={tone === "neutral" ? "neutral" : tone} className="mb-3">
          {health.note}
        </Notice>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatusCard
            label="Pushed"
            icon={Server}
            value={formatNumber(health.sent30)}
            sub="to the push service"
            tone="info"
          />
          <StatusCard
            label="Delivered"
            icon={SmartphoneNfc}
            value={formatNumber(health.delivered30)}
            sub={deliveredRate === null ? "Nothing pushed yet" : `${deliveredRate}% of what was pushed`}
            tone={health.sent30 ? "good" : "neutral"}
          />
          <StatusCard
            label="Failed"
            icon={Activity}
            value={formatNumber(health.failed30)}
            sub={health.failed30 ? "See the reasons below" : "No push was refused"}
            tone={health.failed30 ? "bad" : "good"}
          />
          <StatusCard
            label="Last pushed"
            icon={Cloud}
            value={<span className="text-base">{formatWhen(health.lastSentAt)}</span>}
            sub={`Last delivered: ${formatWhen(health.lastDeliveredAt)}`}
          />
        </div>

        <h4 className="mb-2 mt-4 text-sm font-semibold">Why pushes failed</h4>
        {health.failureReasons.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="pn-no-failures">
            No push failed in the last 30 days.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border">
            <table className="w-full min-w-[36rem] text-xs" data-testid="pn-failure-reasons">
              <thead className="bg-muted text-muted-foreground">
                <tr className="text-left">
                  <th scope="col" className="px-3 py-2 font-semibold">
                    Reason
                  </th>
                  <th scope="col" className="px-3 py-2 text-right font-semibold">
                    Times
                  </th>
                  <th scope="col" className="px-3 py-2 font-semibold">
                    What to do
                  </th>
                </tr>
              </thead>
              <tbody>
                {health.failureReasons.map((r) => (
                  <tr key={r.reason} className="border-t align-top">
                    <td className="px-3 py-2">
                      <p className="font-semibold">{r.label}</p>
                      <p className="font-mono text-[10px] text-muted-foreground">{r.reason}</p>
                    </td>
                    <td className="px-3 py-2 text-right font-bold tabular-nums">{formatNumber(r.count)}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.advice || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="The push service" icon={Server} testId="pn-config-service">
          <div className="divide-y">
            <Field label="Service">{service.provider}</Field>
            <Field label="Delivered through">{service.transport}</Field>
            <Field label="Address">
              <code className="break-all text-xs">{service.url}</code>
            </Field>
            <Field label="Android channel">
              <code className="text-xs">{service.androidChannel}</code>
            </Field>
            <Field label="Employee app">
              <code className="text-xs">{service.appPackage}</code>
            </Field>
            <Field label="Phone notifications">
              {data.pushEnabled ? (
                <span className="font-semibold text-emerald-700">ON</span>
              ) : (
                <span className="font-semibold text-red-700">OFF (Controls tab)</span>
              )}
            </Field>
          </div>
        </Panel>
        <Panel title="Phones registered" icon={SmartphoneNfc} testId="pn-config-phones">
          <div className="divide-y">
            <Field label="Employees with a phone">{formatNumber(phones.employeesWithPhone)}</Field>
            <Field label="Phones in all">{plural(phones.tokens, "phone")}</Field>
            <Field label="Last registered">{formatWhen(phones.lastRegisteredAt)}</Field>
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            A phone registers itself when the employee signs in on the app and allows notifications. Removing one on the
            Employees tab makes it register again the next time the app is opened on it.
          </p>
        </Panel>
      </div>

      <Notice tone="neutral">
        Nothing secret is kept or shown here. The Firebase key that lets Google accept the pushes lives with the
        app&apos;s Expo account, not on this server: if Google refuses pushes (&quot;Firebase key missing or
        wrong&quot;), it is fixed there and in the app build, not on this page.
      </Notice>
    </div>
  );
}
