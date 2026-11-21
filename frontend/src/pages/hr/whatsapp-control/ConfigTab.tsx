import { useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  IndianRupee,
  KeyRound,
  Loader2,
  Lock,
  RefreshCw,
  Server,
  ShieldAlert,
  Smartphone,
  Webhook,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import {
  WHATSAPP_DEFAULT_PRICE_RATES,
  WHATSAPP_PRICING_CATEGORIES,
  useUpdateWhatsAppControlSettings,
  useWhatsAppConnection,
  useWhatsAppControlSettings,
  whatsAppErrorMessage,
  type WhatsAppConnection,
  type WhatsAppControlSettings,
  type WhatsAppPricingCategory,
} from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import { Chip, CopyField, Dot, Fact, Notice, Panel } from "./kit";
import {
  PRICING_HELP,
  PRICING_LABEL,
  employeeCodesText,
  formatInr,
  formatRate,
  moneyError,
  numberStatusInfo,
  qualityInfo,
  tierInfo,
  timeAgo,
} from "./logic";
import { fmtDateTime } from "./shared";

const RATE_MAX = 100;

/** The environment variables, one row each: set, missing, or optional with its default in use (a value is never shown,
 *  secret or not). */
function EnvChecklist({ env }: { env: WhatsAppConnection["env"] }) {
  if (env.length === 0)
    return <p className="text-sm text-muted-foreground">The server did not list its environment variables.</p>;
  return (
    <ul className="divide-y rounded-xl border" data-testid="wa-env">
      {env.map((e) => (
        <li
          key={e.name}
          className="flex flex-wrap items-center justify-between gap-2 px-3 py-2"
          data-testid={`wa-env-${e.name}`}
        >
          <span className="flex min-w-0 items-center gap-2">
            {e.set ? (
              <CheckCircle2 size={15} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : (
              <CircleDashed
                size={15}
                className={e.required ? "shrink-0 text-red-600 dark:text-red-400" : "shrink-0 text-muted-foreground"}
              />
            )}
            <code className="truncate font-mono text-xs">{e.name}</code>
            {e.secret && (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
                title="A secret: its value is never shown"
              >
                <Lock size={10} /> secret
              </span>
            )}
          </span>
          {e.set ? (
            <Chip tone="good">Set</Chip>
          ) : e.required ? (
            <Chip tone="bad">Missing</Chip>
          ) : (
            <Chip tone="neutral" title="Optional: the server uses its default while this is not set">
              Optional · default used
            </Chip>
          )}
        </li>
      ))}
    </ul>
  );
}

function ConnectionPanel() {
  const { data, isLoading, isFetching, error, refetch } = useWhatsAppConnection();
  return (
    <Panel
      title="Meta account set-up"
      description="Read live from this server and from Meta. Keys live only in the server's environment (.env or the hosting's variables): changing one needs a restart."
      icon={Server}
      testId="wa-connection"
      actions={
        <Button
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={() => void refetch()}
          disabled={isFetching}
          data-testid="wa-connection-recheck"
        >
          {isFetching ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Check again
        </Button>
      }
    >
      {isLoading ? (
        <Skeleton className="h-56 rounded-xl" />
      ) : !data ? (
        <Notice tone="bad" role="alert" title="The check could not run" testId="wa-connection-error">
          {whatsAppErrorMessage(error, "Try again in a moment.")}
        </Notice>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2" data-testid="wa-connection-verdict">
            <Chip tone={data.configured ? "good" : "bad"}>{data.configured ? "Keys set" : "Keys missing"}</Chip>
            <Chip tone={data.tokenOk === true ? "good" : data.tokenOk === false ? "bad" : "neutral"}>
              {data.tokenOk === true
                ? "Token accepted by Meta"
                : data.tokenOk === false
                  ? "Token refused by Meta"
                  : "Token not tried"}
            </Chip>
            <Chip tone={data.sendingAllowed ? "good" : "warn"}>
              {data.sendingAllowed ? "Sending allowed" : "Sending blocked here"}
            </Chip>
            {data.apiVersion && <Chip tone="neutral">Graph API {data.apiVersion}</Chip>}
          </div>
          {data.error && (
            <Notice tone="bad" role="alert" title="Meta's answer" testId="wa-connection-meta-error">
              {data.error}
            </Notice>
          )}
          {data.blockReasons.length > 0 && (
            <Notice tone="warn" icon={ShieldAlert} title="Why nothing is sent from here" testId="wa-connection-block">
              <ul className="list-disc space-y-0.5 pl-4">
                {data.blockReasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </Notice>
          )}
          {data.devLock.onlyToEmployees && (
            <Notice tone="info" icon={Lock} testId="wa-connection-devlock">
              Development lock: this machine may only message {employeeCodesText(data.devLock.onlyToEmployees)}{" "}
              (WHATSAPP_ONLY_TO_EMPLOYEES). Every other message is skipped with that reason.
            </Notice>
          )}
          <div className="grid gap-4 lg:grid-cols-2">
            <div className="min-w-0 space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <KeyRound size={12} /> Environment
              </p>
              <EnvChecklist env={data.env} />
            </div>
            <div className="min-w-0 space-y-2">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <Smartphone size={12} /> The business number at Meta
              </p>
              {data.phone ? (
                <div className="rounded-xl border px-3" data-testid="wa-connection-phone">
                  <Fact label="Number">{data.phone.displayPhoneNumber ?? "—"}</Fact>
                  <Fact label="Verified name">
                    {data.phone.verifiedName ?? "—"}
                    {data.phone.nameStatus && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({data.phone.nameStatus.toLowerCase().replace(/_/g, " ")})
                      </span>
                    )}
                  </Fact>
                  <Fact label="Quality">
                    <Dot tone={qualityInfo(data.phone.qualityRating).tone}>
                      {qualityInfo(data.phone.qualityRating).label}
                    </Dot>
                  </Fact>
                  <Fact label="Messaging limit">{tierInfo(data.phone.messagingLimitTier).label}</Fact>
                  <Fact label="Status">
                    <Dot tone={numberStatusInfo(data.phone.status).tone}>
                      {numberStatusInfo(data.phone.status).label}
                    </Dot>
                  </Fact>
                  {data.phone.codeVerificationStatus && (
                    <Fact label="Number verified">
                      {data.phone.codeVerificationStatus.toLowerCase().replace(/_/g, " ")}
                    </Fact>
                  )}
                  {data.phone.throughput && <Fact label="Throughput">{data.phone.throughput.toLowerCase()}</Fact>}
                  {data.phone.platformType && (
                    <Fact label="Platform">{data.phone.platformType.replace(/_/g, " ")}</Fact>
                  )}
                </div>
              ) : (
                <p className="rounded-xl border border-dashed px-3 py-6 text-center text-sm text-muted-foreground">
                  {data.configured ? "Meta did not answer about the number." : "Set the keys first."}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
    </Panel>
  );
}

function WebhookPanel() {
  const { data } = useWhatsAppConnection();
  if (!data) return null;
  const w = data.webhook;
  const last = timeAgo(w.lastWebhookAt);
  return (
    <Panel
      title="Webhook"
      description="Meta tells this server when a message is delivered, read or fails, when a template is approved or rejected, and when the number's quality changes."
      icon={Webhook}
      testId="wa-webhook"
    >
      <div className="space-y-3">
        <div className="space-y-1">
          <Label className="text-xs">Callback URL (paste it into Meta)</Label>
          <CopyField value={w.url} label="the webhook URL" testId="wa-webhook-url" />
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl bg-muted px-3 py-2.5">
            <p className="text-[11px] text-muted-foreground">Verify token</p>
            <p className="text-sm font-semibold">
              <Dot tone={w.verifyTokenSet ? "good" : "bad"}>{w.verifyTokenSet ? "Set" : "Missing"}</Dot>
            </p>
          </div>
          <div className="rounded-xl bg-muted px-3 py-2.5">
            <p className="text-[11px] text-muted-foreground">App secret (signature check)</p>
            <p className="text-sm font-semibold">
              <Dot tone={w.appSecretSet ? "good" : "bad"}>{w.appSecretSet ? "Set" : "Missing"}</Dot>
            </p>
          </div>
          <div className="rounded-xl bg-muted px-3 py-2.5" data-testid="wa-webhook-last">
            <p className="text-[11px] text-muted-foreground">Last received</p>
            <p className="text-sm font-semibold" title={fmtDateTime(w.lastWebhookAt)}>
              <Dot tone={last ? "good" : "warn"}>{last ?? "Never"}</Dot>
            </p>
          </div>
        </div>
        <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Meta App Dashboard → WhatsApp → Configuration → Webhook → Edit.</li>
          <li>
            Paste the URL above, and as the verify token the value of <code>WHATSAPP_CLOUD_WEBHOOK_VERIFY_TOKEN</code>.
          </li>
          <li>
            Subscribe to <b>messages</b>, <b>message_template_status_update</b> and <b>phone_number_quality_update</b>.
          </li>
          <li>
            Every delivery receipt is checked against WHATSAPP_CLOUD_APP_SECRET; one that does not match is refused.
          </li>
        </ol>
      </div>
    </Panel>
  );
}

function PricesPanel({ settings, locked }: { settings: WhatsAppControlSettings; locked: boolean }) {
  const { toast } = useToast();
  const update = useUpdateWhatsAppControlSettings();
  const ratesOf = (s: WhatsAppControlSettings) =>
    Object.fromEntries(WHATSAPP_PRICING_CATEGORIES.map((c) => [c, String(s.priceRates[c])])) as Record<
      WhatsAppPricingCategory,
      string
    >;
  const [rates, setRates] = useState(() => ratesOf(settings));
  const [budget, setBudget] = useState(settings.monthlyBudget === null ? "" : String(settings.monthlyBudget));
  const [serverError, setServerError] = useState<string | null>(null);
  // start again from the saved values only when they really change (a save, another HR user's)
  const savedKey = JSON.stringify([settings.priceRates, settings.monthlyBudget]);
  const [seen, setSeen] = useState(savedKey);
  if (seen !== savedKey) {
    setSeen(savedKey);
    setRates(ratesOf(settings));
    setBudget(settings.monthlyBudget === null ? "" : String(settings.monthlyBudget));
  }

  const rateErrors = Object.fromEntries(
    WHATSAPP_PRICING_CATEGORIES.map((c) => [c, moneyError(rates[c], { max: RATE_MAX })]),
  ) as Record<WhatsAppPricingCategory, string | null>;
  const budgetError = moneyError(budget, { optional: true });
  const invalid = Object.values(rateErrors).some(Boolean) || Boolean(budgetError);
  const ratesChanged = WHATSAPP_PRICING_CATEGORIES.some((c) => Number(rates[c]) !== settings.priceRates[c]);
  const budgetValue = budget.trim() === "" ? null : Number(budget);
  const budgetChanged = budgetValue !== settings.monthlyBudget;
  const dirty = ratesChanged || budgetChanged;

  const save = () => {
    setServerError(null);
    const body: Record<string, Record<string, number> | number | null> = {};
    if (ratesChanged)
      body.priceRates = Object.fromEntries(WHATSAPP_PRICING_CATEGORIES.map((c) => [c, Number(rates[c])]));
    if (budgetChanged) body.monthlyBudget = budgetValue;
    update.mutate(body, {
      onSuccess: () => toast({ title: "Prices and budget saved", description: "The cost figures use them now." }),
      onError: (e) => setServerError(whatsAppErrorMessage(e, "Couldn't save the prices.")),
    });
  };

  return (
    <Panel
      title="Prices and monthly budget"
      description="What each delivered, charged message costs, before GST, by Meta's pricing category. Defaults are Meta's India rates; change them when Meta's rate card changes."
      icon={IndianRupee}
      testId="wa-prices"
      actions={
        <Button
          size="sm"
          variant="ghost"
          className="h-8 text-xs"
          disabled={locked}
          onClick={() =>
            setRates(
              Object.fromEntries(
                WHATSAPP_PRICING_CATEGORIES.map((c) => [c, String(WHATSAPP_DEFAULT_PRICE_RATES[c])]),
              ) as Record<WhatsAppPricingCategory, string>,
            )
          }
          data-testid="wa-prices-defaults"
        >
          Use Meta's India rates
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {WHATSAPP_PRICING_CATEGORIES.map((c) => (
            <div key={c} className="space-y-1">
              <Label htmlFor={`wa-rate-${c}`} className="text-xs" title={PRICING_HELP[c]}>
                {PRICING_LABEL[c]}
              </Label>
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                  ₹
                </span>
                <Input
                  id={`wa-rate-${c}`}
                  inputMode="decimal"
                  value={rates[c]}
                  disabled={locked}
                  onChange={(e) => {
                    setServerError(null);
                    setRates((prev) => ({ ...prev, [c]: e.target.value }));
                  }}
                  className={cn("pl-6 tabular-nums", rateErrors[c] && "border-red-400")}
                  aria-invalid={Boolean(rateErrors[c])}
                  data-testid={`wa-rate-${c}`}
                />
              </div>
              {rateErrors[c] ? (
                <p className="text-[11px] text-red-600" data-testid={`wa-rate-error-${c}`}>
                  {rateErrors[c]}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">{formatRate(Number(rates[c]) * 1.18)} with GST</p>
              )}
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-[16rem_minmax(0,1fr)] sm:items-start">
          <div className="space-y-1">
            <Label htmlFor="wa-budget" className="text-xs">
              Monthly budget (before GST)
            </Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                ₹
              </span>
              <Input
                id="wa-budget"
                inputMode="decimal"
                placeholder="No budget"
                value={budget}
                disabled={locked}
                onChange={(e) => {
                  setServerError(null);
                  setBudget(e.target.value);
                }}
                className={cn("pl-6 tabular-nums", budgetError && "border-red-400")}
                aria-invalid={Boolean(budgetError)}
                data-testid="wa-budget"
              />
            </div>
            {budgetError ? (
              <p className="text-[11px] text-red-600" data-testid="wa-budget-error">
                {budgetError}
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                {budgetValue === null ? "Leave empty for no budget." : `${formatInr(budgetValue * 1.18)} with GST.`}
              </p>
            )}
          </div>
          <Notice tone="neutral" className="sm:mt-5">
            The Overview warns at 80% of the budget, and as soon as the month's projection passes it. Every figure on
            this page is before 18% GST unless it says "with GST". Messages are never stopped by the budget.
          </Notice>
        </div>
        {serverError && (
          <Notice tone="bad" role="alert" testId="wa-prices-error">
            {serverError}
          </Notice>
        )}
        <Button
          size="sm"
          onClick={save}
          disabled={locked || !dirty || invalid || update.isPending}
          data-testid="wa-prices-save"
        >
          {update.isPending ? "Saving…" : "Save prices and budget"}
        </Button>
      </div>
    </Panel>
  );
}

/** Settings: the Meta account set-up check (environment variables by name, the number at Meta, the token), the
 *  webhook to paste into Meta, the development lock, and the prices and monthly budget the cost figures use. */
export default function ConfigTab({ locked = false }: { locked?: boolean }) {
  const { data: settings, error, isError } = useWhatsAppControlSettings();
  return (
    <div className="space-y-4" data-testid="wa-config">
      <ConnectionPanel />
      <WebhookPanel />
      {settings ? (
        <PricesPanel settings={settings} locked={locked} />
      ) : isError ? (
        <Notice tone="bad" role="alert" title="The prices and budget could not be loaded" testId="wa-prices-load-error">
          {whatsAppErrorMessage(error, "Try Refresh in a moment.")}
        </Notice>
      ) : (
        <Skeleton className="h-56 rounded-2xl" />
      )}
    </div>
  );
}
