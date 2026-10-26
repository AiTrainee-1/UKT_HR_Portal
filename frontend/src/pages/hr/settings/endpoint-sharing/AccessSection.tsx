import { Field, ToggleField } from "../kit/Field";
import { SettingBlock } from "../kit/SettingBlock";
import { Input } from "@/components/ui/input";
import { KeysPanel } from "./KeysPanel";
import { OriginsPanel } from "./OriginsPanel";
import { RATE_LIMIT_MAX } from "./form";
import type { SectionProps } from "./sectionProps";

/** Access: who may call (websites, your own servers, keys) and how much (rate limit, page sizes). */
export function AccessSection({ draft, patch, readOnly, errors, saved, dataset, limits }: SectionProps) {
  return (
    <div className="space-y-1" data-testid="endpoint-access">
      <SettingBlock
        id="access-origins"
        title="Allowed websites (origins)"
        purpose="The websites whose pages may call this endpoint from a visitor's browser. Without a website on the list a browser is refused, even with a good key. This is a safety net for browsers, not a lock: the API key is the lock."
        note="Write each website as scheme://host or scheme://host:port. No path, no star."
        affects={[
          {
            where: "Browsers calling this endpoint",
            what: "A page on a website that is not on this list is refused by the browser, even with a valid API key.",
          },
        ]}
      >
        <OriginsPanel
          origins={draft.origins}
          onChange={(origins) => patch({ origins })}
          readOnly={readOnly}
          max={limits.maxOriginsPerEndpoint}
          serverError={errors.origins}
        />
      </SettingBlock>

      <SettingBlock
        id="access-server-to-server"
        labelFor="es-no-origin"
        title="Calls from your own servers"
        purpose="A program running on a server (not in a browser) sends no origin. When this is on, such calls are accepted with a valid key. When it is off, every call must come from an allowed website, so only browsers can use the endpoint."
        defaultText="On"
        note="Prefer server-to-server calls: the key stays on your server, where nobody can read it."
      >
        <ToggleField
          id="es-no-origin"
          checked={draft.allowNoOrigin}
          disabled={readOnly}
          onChange={(allowNoOrigin) => patch({ allowNoOrigin })}
          onLabel="Calls without an origin are accepted"
          offLabel="Calls without an origin are refused"
        >
          A valid key is still needed.
        </ToggleField>
      </SettingBlock>

      <SettingBlock
        id="access-rate-limit"
        labelFor="es-rate"
        title="Calls a minute, for each key"
        purpose="How many calls one key may make in a minute. Past it the answer is 'too many calls' and a wait time. It protects the HR system from a faulty program that asks over and over."
        defaultText="60 calls a minute"
      >
        <Field label="Calls a minute" htmlFor="es-rate" error={errors.rateLimit} hint={`From 1 to ${RATE_LIMIT_MAX}.`}>
          <Input
            id="es-rate"
            inputMode="numeric"
            className="w-32"
            value={draft.rateLimit}
            disabled={readOnly}
            aria-invalid={errors.rateLimit ? true : undefined}
            onChange={(e) => patch({ rateLimit: e.target.value })}
          />
        </Field>
      </SettingBlock>

      <SettingBlock
        id="access-page-size"
        title="Rows in a page"
        purpose="Results come in pages. The usual size is used when the caller does not ask for one. The largest size caps what a caller can ask for, so one call can never pull the whole table."
        defaultText="50 usually, 200 at most"
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Usual page size" htmlFor="es-page-default" error={errors.pageSizeDefault} unit="rows">
            <Input
              id="es-page-default"
              inputMode="numeric"
              value={draft.pageSizeDefault}
              disabled={readOnly}
              aria-invalid={errors.pageSizeDefault ? true : undefined}
              onChange={(e) => patch({ pageSizeDefault: e.target.value })}
            />
          </Field>
          <Field
            label="Largest page size"
            htmlFor="es-page-max"
            error={errors.pageSizeMax}
            unit="rows"
            hint={dataset ? `This dataset allows up to ${dataset.maxPageSize}.` : undefined}
          >
            <Input
              id="es-page-max"
              inputMode="numeric"
              value={draft.pageSizeMax}
              disabled={readOnly}
              aria-invalid={errors.pageSizeMax ? true : undefined}
              onChange={(e) => patch({ pageSizeMax: e.target.value })}
            />
          </Field>
        </div>
      </SettingBlock>

      <SettingBlock
        id="access-keys"
        title="API keys"
        purpose="A key is the password an application sends with every call. Make one key for each application, so you can revoke one without stopping the others. A key belongs to this endpoint only and can read nothing else."
        note="The whole key is shown once, when it is made. Copy it then."
      >
        <KeysPanel endpointId={saved?.id ?? null} readOnly={readOnly} maxLive={limits.maxLiveKeysPerEndpoint} />
      </SettingBlock>
    </div>
  );
}
