import type { ReactNode } from "react";
import type { SharedGuide } from "@/lib/api-client/custom-hooks";
import { CodeExamples } from "./CodeExamples";
import { CodeBox, Pill, ScrollTable, TD, TH, WRAP } from "./ui";

function Block({
  title,
  intro,
  children,
  testId,
}: {
  title: string;
  intro?: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <section className="space-y-2" data-testid={testId} aria-label={title}>
      <h5 className="text-sm font-semibold text-slate-900">{title}</h5>
      {intro && <p className="text-[13px] leading-relaxed text-slate-500">{intro}</p>}
      {children}
    </section>
  );
}

const sample = (value: unknown): string => {
  if (value === null || value === undefined) return "-";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
};

/** One endpoint's generated documentation, drawn from what the server sends: the server writes it from what is saved. */
export function GuideView({ guide }: { guide: SharedGuide }) {
  const json = guide.sampleResponse === null ? "" : JSON.stringify(guide.sampleResponse, null, 2);
  return (
    <div className="space-y-6" data-testid="guide-view">
      <Block
        testId="guide-url"
        title="Address"
        intro="Call this address with the method shown. Replace the key placeholder with a real key made on the Access section."
      >
        <CodeBox
          label={`${guide.method} request`}
          code={`${guide.method} ${guide.url}`}
          testId="guide-url-box"
          copyLabel="Copy address"
        />
        {guide.baseUrl && (
          <p className="text-xs text-slate-500">
            Base address of this system: <code className="font-mono">{guide.baseUrl}</code>
          </p>
        )}
      </Block>

      <Block
        testId="guide-headers"
        title="Headers"
        intro="Send the key in one of these headers. Never put a key in the address: addresses end up in logs."
      >
        {guide.headers.length === 0 ? (
          <p className="text-sm text-slate-500">No special headers.</p>
        ) : (
          <ScrollTable label="Headers" fit>
            <thead>
              <tr>
                <th className={TH}>Header</th>
                <th className={TH}>Value</th>
                <th className={TH}>Needed</th>
                <th className={TH}>What it is</th>
              </tr>
            </thead>
            <tbody>
              {guide.headers.map((h) => (
                <tr key={h.name + h.value}>
                  <td data-label="Header" className={`${TD} font-mono ${WRAP}`}>
                    {h.name}
                  </td>
                  <td data-label="Value" className={`${TD} font-mono ${WRAP}`}>
                    {h.value}
                  </td>
                  <td data-label="Needed" className={TD}>
                    {h.required ? <Pill tone="warn">Yes</Pill> : <Pill tone="muted">No</Pill>}
                  </td>
                  <td data-label="What it is" className={TD}>
                    {h.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </Block>

      <Block
        testId="guide-parameters"
        title="Parameters"
        intro="Added to the address as ?name=value. A name that is not in this table is refused with an error, so a typing mistake is caught."
      >
        {guide.parameters.length === 0 ? (
          <p className="text-sm text-slate-500">This endpoint takes no parameters.</p>
        ) : (
          <ScrollTable label="Parameters" fit>
            <thead>
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Type</th>
                <th className={TH}>Needed</th>
                <th className={TH}>Default</th>
                <th className={TH}>Allowed or example</th>
                <th className={TH}>What it does</th>
              </tr>
            </thead>
            <tbody>
              {guide.parameters.map((p) => (
                <tr key={p.name}>
                  <td data-label="Name" className={`${TD} font-mono ${WRAP}`}>
                    {p.name}
                  </td>
                  <td data-label="Type" className={TD}>
                    {p.type}
                  </td>
                  <td data-label="Needed" className={TD}>
                    {p.required ? <Pill tone="warn">Required</Pill> : <Pill tone="muted">Optional</Pill>}
                  </td>
                  <td data-label="Default" className={TD}>
                    {p.default ?? "-"}
                  </td>
                  <td data-label="Allowed or example" className={`${TD} font-mono ${WRAP}`}>
                    {p.values.length > 0 ? p.values.join(" | ") : (p.example ?? "-")}
                  </td>
                  <td data-label="What it does" className={TD}>
                    {p.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </Block>

      {guide.lockedFilters.length > 0 && (
        <Block
          testId="guide-locked"
          title="Locked on this endpoint"
          intro="These filters are fixed by the endpoint. They are not parameters: the caller cannot change them."
        >
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-slate-700">
            {guide.lockedFilters.map((l) => (
              <li key={l.name}>
                <code className="font-mono">{l.name}</code> is always <code className="font-mono">{l.value}</code>
              </li>
            ))}
          </ul>
        </Block>
      )}

      {guide.pagination && (
        <Block testId="guide-paging" title="Pages and limits">
          <p className="text-[13px] leading-relaxed text-slate-600">
            {guide.pagination.defaultPageSize} rows a page unless you ask for another size, at most{" "}
            {guide.pagination.maxPageSize}. One key may make {guide.pagination.rateLimitPerMinute} calls a minute; after
            that the answer is 429 with a Retry-After header.
          </p>
        </Block>
      )}

      <Block
        testId="guide-access"
        title="Who may call"
        intro="Browsers: only the websites below. Your own servers: see the switch. In every case a valid key is needed."
      >
        {guide.origins.length === 0 ? (
          <p className="text-sm text-slate-500">No website is allowed, so browsers are refused.</p>
        ) : (
          <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-slate-700">
            {guide.origins.map((o) => (
              <li key={o}>
                <code className="break-all font-mono">{o}</code>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[13px] text-slate-600">
          Calls with no origin (from a server) are {guide.allowNoOrigin ? "accepted" : "refused"}.
        </p>
      </Block>

      <Block
        testId="guide-response"
        title="What comes back"
        intro="JSON with the rows in data and the paging details in meta. Only the fields this endpoint shares are in each row."
      >
        {guide.responseFields.length > 0 && (
          <ScrollTable label="Fields in each row" fit>
            <thead>
              <tr>
                <th className={TH}>Field</th>
                <th className={TH}>Type</th>
                <th className={TH}>Example</th>
                <th className={TH}>What it is</th>
              </tr>
            </thead>
            <tbody>
              {guide.responseFields.map((f) => (
                <tr key={f.name}>
                  <td data-label="Field" className={`${TD} font-mono ${WRAP}`}>
                    {f.name}
                  </td>
                  <td data-label="Type" className={TD}>
                    {f.type}
                  </td>
                  <td data-label="Example" className={`${TD} font-mono ${WRAP}`}>
                    {sample(f.sample)}
                  </td>
                  <td data-label="What it is" className={TD}>
                    {f.description}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
        {json && <CodeBox label="An example answer" code={json} testId="guide-sample" />}
      </Block>

      <Block
        testId="guide-errors"
        title="Errors"
        intro="Every refusal is JSON with an error code and one plain sentence."
      >
        {guide.errors.length === 0 ? (
          <p className="text-sm text-slate-500">No error list came with this guide.</p>
        ) : (
          <ScrollTable label="Errors" fit>
            <thead>
              <tr>
                <th className={TH}>Status</th>
                <th className={TH}>Code</th>
                <th className={TH}>What it means</th>
              </tr>
            </thead>
            <tbody>
              {guide.errors.map((e) => (
                <tr key={`${e.status}-${e.code}`}>
                  <td data-label="Status" className={`${TD} font-mono`}>
                    {e.status}
                  </td>
                  <td data-label="Code" className={`${TD} font-mono ${WRAP}`}>
                    {e.code}
                  </td>
                  <td data-label="What it means" className={TD}>
                    {e.meaning}
                  </td>
                </tr>
              ))}
            </tbody>
          </ScrollTable>
        )}
      </Block>

      <Block
        testId="guide-examples"
        title="Example code"
        intro="Pick your language and copy it. The key is a placeholder: use your own, kept in your server's secret settings."
      >
        <CodeExamples examples={guide.examples} testId="guide-code" />
      </Block>

      {guide.notes.length > 0 && (
        <Block testId="guide-notes" title="Good to know">
          <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-slate-600">
            {guide.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Block>
      )}
    </div>
  );
}
