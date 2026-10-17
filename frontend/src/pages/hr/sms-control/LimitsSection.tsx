import { Input } from "@/components/ui/input";
import { LIMIT_RULES, limitsAdvice, parseWhole, sectionDirty, validateLimits, type SectionProps } from "./logic";
import { Example, Notice, Panel, ReloadButton, SaveRow, SettingBlock } from "./ui";

/**
 * Settings > Limits: the seven numbers that keep codes safe and the SMS bill small. Every one says what it is for, what
 * changes when it changes, its default and its range, and works an example out from the number being typed. One Save for the
 * section; a number outside its range is refused before it is sent.
 */
export default function LimitsSection({
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
}: SectionProps) {
  const validation = validateLimits(draft);
  const advice = limitsAdvice(draft);
  const dirty = sectionDirty("limits", draft, saved);
  const blocked = validation.first !== null;

  return (
    <Panel
      title="Limits"
      description="How long a code lives, how often it can be asked for, and how many SMS the company may send. They protect employees from guessing and you from a surprise bill."
      testId="sms-section-limits"
    >
      {LIMIT_RULES.map((rule) => {
        const n = parseWhole(draft[rule.key]);
        const valid = n !== null && n >= rule.min && n <= rule.max;
        const problem = validation.errors[rule.key];
        const inputId = `sms-${rule.key}`;
        return (
          <SettingBlock
            key={rule.key}
            id={rule.key}
            title={<label htmlFor={inputId}>{rule.label}</label>}
            purpose={rule.purpose}
            affects={rule.affects}
            defaultText={`${rule.default.toLocaleString("en-IN")} ${rule.unit}`}
            preview={valid ? <Example testId={`sms-example-${rule.key}`}>{rule.example(n)}</Example> : undefined}
          >
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Input
                  id={inputId}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft[rule.key]}
                  onChange={(e) => patch({ [rule.key]: e.target.value })}
                  disabled={readOnly || busy}
                  aria-invalid={problem ? true : undefined}
                  aria-describedby={`${inputId}-help`}
                  className="max-w-[9rem] tabular-nums"
                  data-testid={`sms-input-${rule.key}`}
                />
                <span className="text-xs font-semibold text-muted-foreground">{rule.unit}</span>
              </div>
              {problem ? (
                <p id={`${inputId}-help`} role="alert" className="text-xs font-medium text-red-600 dark:text-red-400">
                  {problem}
                </p>
              ) : (
                <p id={`${inputId}-help`} className="text-xs text-muted-foreground">
                  From {rule.min.toLocaleString("en-IN")} to {rule.max.toLocaleString("en-IN")} {rule.unit}.
                </p>
              )}
            </div>
          </SettingBlock>
        );
      })}

      {advice.length > 0 && (
        <Notice tone="warn" testId="sms-limits-advice">
          <p className="font-semibold">Worth a look:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {advice.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Notice>
      )}
      {error && (
        <Notice tone="bad" role="alert" testId="sms-limits-error">
          <p>{error}</p>
          {stale && <ReloadButton onReload={onReload} />}
        </Notice>
      )}
      <SaveRow
        testId="sms-limits-save-row"
        dirty={dirty}
        saving={saving}
        readOnly={readOnly}
        saveLabel="Save limits"
        onSave={onSave}
        onDiscard={onDiscard}
        invalid={blocked}
        hint={!readOnly && dirty && blocked ? `Fix this first: ${validation.first}` : undefined}
      />
    </Panel>
  );
}
