import { Input } from "@/components/ui/input";
import type { SmsOverview } from "@/lib/api-client/custom-hooks";
import {
  DEFAULT_PRICE_PER_SMS,
  PRICE_MAX,
  PROVIDER_NAME,
  costExample,
  formatNumber,
  formatRupees,
  parseRupees,
  projectMonth,
  sectionDirty,
  thisMonth,
  validateCost,
  type SectionProps,
} from "./logic";
import { Example, Notice, Panel, ReloadButton, SaveRow, SettingBlock } from "./ui";

/**
 * Settings > Cost: what one SMS costs (for the estimates on Overview and Usage & Cost) and the monthly budget HR wants to stay
 * under (the Overview warns as the month's cost comes close to it, or is on course to pass it). Neither stops a code from
 * being sent: they are for the estimate and the warning only. One Save for the section.
 */
export default function CostSection({
  draft,
  saved,
  patch,
  readOnly,
  saving,
  busy,
  error,
  stale,
  onSave,
  onDiscard,
  onReload,
  month,
  defaultPrice = DEFAULT_PRICE_PER_SMS,
}: SectionProps & {
  /** The overview, for "this month at this price" (null until it has loaded). */
  month: SmsOverview | null;
  /** The price the server uses when the box is left empty. */
  defaultPrice?: number;
}) {
  const validation = validateCost(draft);
  const dirty = sectionDirty("cost", draft, saved);
  const blocked = validation.first !== null;
  const locked = readOnly || busy;

  const typedPrice = parseRupees(draft.pricePerSms);
  const price = typedPrice === "" || typedPrice === null ? defaultPrice : typedPrice;
  const typedBudget = parseRupees(draft.monthlyBudget);
  const budget = typeof typedBudget === "number" && typedBudget > 0 ? typedBudget : null;
  const sent = month?.month.sent ?? null;
  const soFar = sent !== null ? sent * price : null;
  const projected = soFar !== null ? projectMonth(soFar, thisMonth()) : null;

  return (
    <Panel
      title="Cost"
      description={`What one SMS costs you at ${PROVIDER_NAME}, and the monthly budget you want to stay under. They are for the estimates and the warnings only: neither stops a code from being sent.`}
      testId="sms-section-cost"
    >
      <SettingBlock
        id="pricePerSms"
        title={<label htmlFor="sms-pricePerSms">Price per SMS</label>}
        purpose={`What ${PROVIDER_NAME} charges you for one SMS, in rupees, as on your plan or invoice. Every cost figure on this page is the SMS sent times this price.`}
        affects={[
          { where: "Overview and Usage & Cost", what: "the cost so far, the projection and the cost per purpose" },
        ]}
        defaultText={formatRupees(defaultPrice, true)}
        preview={
          !validation.errors.pricePerSms ? (
            <Example testId="sms-example-pricePerSms">{costExample(price)}</Example>
          ) : undefined
        }
      >
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-muted-foreground">₹</span>
            <Input
              id="sms-pricePerSms"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={draft.pricePerSms}
              placeholder={String(defaultPrice)}
              onChange={(e) => patch({ pricePerSms: e.target.value })}
              disabled={locked}
              aria-invalid={validation.errors.pricePerSms ? true : undefined}
              aria-describedby="sms-pricePerSms-help"
              className="max-w-[9rem] tabular-nums"
              data-testid="sms-input-pricePerSms"
            />
            <span className="text-xs font-semibold text-muted-foreground">per SMS</span>
          </div>
          {validation.errors.pricePerSms ? (
            <p id="sms-pricePerSms-help" role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {validation.errors.pricePerSms}
            </p>
          ) : (
            <p id="sms-pricePerSms-help" className="text-xs text-muted-foreground">
              From ₹0 to ₹{PRICE_MAX}, up to 4 decimals. Leave it empty for the default,{" "}
              {formatRupees(defaultPrice, true)}.
            </p>
          )}
        </div>
      </SettingBlock>

      <SettingBlock
        id="monthlyBudget"
        title={<label htmlFor="sms-monthlyBudget">Monthly budget</label>}
        purpose="The most you want to spend on SMS in a month. The Overview shows how much of it is used, and warns when the month's cost is close to it or on course to pass it."
        affects={[
          { where: "Overview", what: "the budget bar and the warnings in Needs attention" },
          { where: "Sending", what: "is not stopped by the budget: the limits do that" },
        ]}
        defaultText="No budget"
        preview={
          soFar !== null ? (
            <Example testId="sms-example-monthlyBudget">
              {formatNumber(sent ?? 0)} SMS so far this month cost about {formatRupees(soFar)}
              {projected !== null ? `, about ${formatRupees(projected)} by the month's end at this pace` : ""}.
              {budget !== null &&
                (projected !== null && projected > budget
                  ? ` That passes a budget of ${formatRupees(budget)}.`
                  : ` That stays within a budget of ${formatRupees(budget)}.`)}
            </Example>
          ) : undefined
        }
      >
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-muted-foreground">₹</span>
            <Input
              id="sms-monthlyBudget"
              type="text"
              inputMode="decimal"
              autoComplete="off"
              value={draft.monthlyBudget}
              placeholder="No budget"
              onChange={(e) => patch({ monthlyBudget: e.target.value })}
              disabled={locked}
              aria-invalid={validation.errors.monthlyBudget ? true : undefined}
              aria-describedby="sms-monthlyBudget-help"
              className="max-w-[11rem] tabular-nums"
              data-testid="sms-input-monthlyBudget"
            />
            <span className="text-xs font-semibold text-muted-foreground">a month</span>
          </div>
          {validation.errors.monthlyBudget ? (
            <p id="sms-monthlyBudget-help" role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
              {validation.errors.monthlyBudget}
            </p>
          ) : (
            <p id="sms-monthlyBudget-help" className="text-xs text-muted-foreground">
              In rupees. Leave it empty for no budget.
            </p>
          )}
        </div>
      </SettingBlock>

      {error && (
        <Notice tone="bad" role="alert" testId="sms-cost-error">
          <p>{error}</p>
          {stale && <ReloadButton onReload={onReload} />}
        </Notice>
      )}
      <SaveRow
        testId="sms-cost-save-row"
        dirty={dirty}
        saving={saving}
        readOnly={readOnly}
        saveLabel="Save price and budget"
        onSave={onSave}
        onDiscard={onDiscard}
        invalid={blocked}
        hint={!readOnly && dirty && blocked ? `Fix this first: ${validation.first}` : undefined}
      />
    </Panel>
  );
}
