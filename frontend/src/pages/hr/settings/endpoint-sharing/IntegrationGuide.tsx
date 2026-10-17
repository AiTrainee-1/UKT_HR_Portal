import { CircleCheck } from "lucide-react";
import { TabContents } from "../attendance/TabContents";
import { CodeExamples } from "./CodeExamples";
import { buildExamples } from "./examples";
import { AnchorSection, CodeBox, Notice, ScrollTable, TD, TH, WRAP } from "./ui";

const CONTENTS = [
  { id: "guide-how", label: "How it works" },
  { id: "guide-auth", label: "Authentication" },
  { id: "guide-request", label: "Request" },
  { id: "guide-pagination", label: "Pages" },
  { id: "guide-response", label: "Response" },
  { id: "guide-errors", label: "Errors" },
  { id: "guide-cors", label: "Browsers and origins" },
  { id: "guide-keys", label: "Looking after keys" },
  { id: "guide-examples", label: "Examples" },
  { id: "guide-security", label: "Security checklist" },
];

const ERRORS: { status: number; code: string; meaning: string }[] = [
  {
    status: 404,
    code: "not_found",
    meaning: "No endpoint has that address, or it is switched off. The answer is the same for both, on purpose.",
  },
  {
    status: 403,
    code: "origin_not_allowed",
    meaning: "The call came from a website that is not on the endpoint's list of allowed websites.",
  },
  {
    status: 403,
    code: "origin_required",
    meaning: "The call had no origin, and this endpoint accepts calls from browsers only.",
  },
  {
    status: 401,
    code: "invalid_key",
    meaning: "The key is missing, wrong, revoked, expired or belongs to another endpoint. One answer for all of them.",
  },
  {
    status: 429,
    code: "rate_limited",
    meaning:
      "The key made too many calls in a minute (or many wrong keys came from one address). Wait the number of seconds in the Retry-After header.",
  },
  {
    status: 400,
    code: "invalid_parameter",
    meaning: "A parameter is unknown, missing or has a bad value. The message names it.",
  },
  {
    status: 405,
    code: "method_not_allowed",
    meaning: "Only GET (and OPTIONS, for browsers) is accepted. Nothing can be written through an endpoint.",
  },
  {
    status: 500,
    code: "server_error",
    meaning: "Something failed on the server. Try again later, and tell the administrator if it keeps happening.",
  },
];

const CHECKLIST = [
  "Tick only the fields the other application really needs. Avoid personal and financial fields unless they are essential.",
  "Lock a filter wherever you can, for example status = active, so rows nobody needs are never exposed.",
  "Make one key for each application and label it. Then you can revoke one without stopping the others.",
  "Call from a server. Never put a key in a web page, a mobile app or any file a visitor can download.",
  "Keep keys in your server's secret settings (environment variables or a secret store), never in the code or in git.",
  "Allow only websites that you own. Never add a website you do not control to the list.",
  "Use https everywhere. Plain http is accepted for localhost only.",
  "Give a key an expiry when the access is temporary, and revoke keys that are no longer used.",
  "Keep the rate limit as low as the application allows.",
  "Look at Activity now and then. Many refused calls (401, 403) can mean somebody is guessing.",
  "Switch off an endpoint that is not used any more, or delete it.",
  "Escape everything you display (HTML) or export (CSV formulas starting with = + - @): treat the data as untrusted text.",
  "Treat the data you receive as confidential HR data: store only what you need and protect it like the original.",
];

/** The general guide for a developer who will connect an application: how everything works, in plain words. */
export function IntegrationGuide({ origin }: { origin: string }) {
  const base = origin.replace(/\/+$/, "");
  const url = `${base}/api/shared/your-endpoint`;
  return (
    <div className="space-y-4" data-testid="integration-guide">
      <TabContents items={CONTENTS} />

      <AnchorSection
        id="guide-how"
        title="How it works"
        purpose="Endpoint Sharing lets one of your other applications read a chosen slice of the HR data, safely, and never change it."
      >
        <ol className="list-decimal space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-700">
          <li>
            In <strong>Endpoints</strong> you make an endpoint, choose its dataset and tick the fields it may share.
          </li>
          <li>
            In its <strong>Access</strong> section you list the websites that may call it and make an API key for each
            application.
          </li>
          <li>The developer of the other application calls the endpoint's address with the key. That is all.</li>
          <li>
            Each call is checked: the endpoint exists and is on, the website is allowed, the key is valid for this
            endpoint, the rate is fine, the parameters are known. Only then the rows come back, with only the ticked
            fields.
          </li>
        </ol>
        <Notice testId="guide-read-only">
          Every call only reads. Nothing in the HR system can be added, changed or deleted through an endpoint. The only
          thing a call writes is its own line in the Activity log.
        </Notice>
      </AnchorSection>

      <AnchorSection
        id="guide-auth"
        title="Authentication: the API key"
        purpose="Every call must carry an API key, in a header. The key is what proves the caller is allowed. A key belongs to one endpoint and can read nothing else."
      >
        <ScrollTable label="Ways to send the key" fit>
          <thead>
            <tr>
              <th className={TH}>Header</th>
              <th className={TH}>Looks like</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="Header" className={`${TD} font-mono`}>
                Authorization
              </td>
              <td data-label="Looks like" className={`${TD} font-mono ${WRAP}`}>
                Bearer uks_xxxxxxxx_...
              </td>
            </tr>
            <tr>
              <td data-label="Header" className={`${TD} font-mono`}>
                X-API-Key
              </td>
              <td data-label="Looks like" className={`${TD} font-mono ${WRAP}`}>
                uks_xxxxxxxx_...
              </td>
            </tr>
          </tbody>
        </ScrollTable>
        <p className="text-[13px] leading-relaxed text-slate-600">
          Use either one, not both. A key is never accepted in the address (?key=...) because addresses are written to
          logs and browser history. The key starts with <code className="font-mono">uks_</code>. It is shown once, when
          it is made.
        </p>
      </AnchorSection>

      <AnchorSection
        id="guide-request"
        title="The request"
        purpose="A call is a GET to the endpoint's address. The address is this system's address followed by /api/shared/ and the endpoint's own address."
      >
        <CodeBox label="Base address and method" code={`GET ${url}`} testId="guide-base-url" copyLabel="Copy address" />
        <p className="text-[13px] leading-relaxed text-slate-600">
          Each endpoint's own Guide section shows its exact address, the parameters it takes and the fields it returns.
          Beyond the filters of its dataset, two parameters work on every endpoint:
        </p>
        <ScrollTable label="Parameters on every endpoint" fit>
          <thead>
            <tr>
              <th className={TH}>Parameter</th>
              <th className={TH}>Meaning</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td data-label="Parameter" className={`${TD} font-mono`}>
                page
              </td>
              <td data-label="Meaning" className={TD}>
                Which page of rows. The first page is 1.
              </td>
            </tr>
            <tr>
              <td data-label="Parameter" className={`${TD} font-mono`}>
                pageSize
              </td>
              <td data-label="Meaning" className={TD}>
                How many rows in a page. It can never go above the endpoint's largest page size.
              </td>
            </tr>
          </tbody>
        </ScrollTable>
        <p className="text-[13px] leading-relaxed text-slate-600">
          A parameter the endpoint does not know is refused with an error, so a typing mistake is caught at once. A
          filter that is locked on the endpoint cannot be changed by the caller.
        </p>
      </AnchorSection>

      <AnchorSection
        id="guide-pagination"
        title="Pages of results"
        purpose="Results come a page at a time, so one call can never pull a whole table. Keep asking for the next page until there are no more."
      >
        <p className="text-[13px] leading-relaxed text-slate-600">
          Each answer says in <code className="font-mono">meta</code> which page it is, how many rows there are in all (
          <code className="font-mono">total</code>) and whether another page follows (
          <code className="font-mono">hasMore</code>). Ask for <code className="font-mono">page=2</code>, then 3, until
          hasMore is false.
        </p>
      </AnchorSection>

      <AnchorSection
        id="guide-response"
        title="What comes back"
        purpose="JSON. The rows are in data and contain only the fields ticked on the endpoint. The details of the page are in meta."
      >
        <CodeBox
          label="The shape of every answer"
          testId="guide-response-shape"
          code={JSON.stringify(
            {
              data: [{ "<a ticked field>": "<its value>" }],
              meta: {
                endpoint: "your-endpoint",
                dataset: "departments",
                fields: ["<the ticked fields, in order>"],
                page: 1,
                pageSize: 50,
                total: 123,
                hasMore: true,
                generatedAt: "2026-10-17T10:30:00+05:30",
              },
            },
            null,
            2,
          )}
        />
        <ul className="list-disc space-y-1 pl-5 text-[13px] leading-relaxed text-slate-600">
          <li>Dates are written 2026-10-14, times 09:30:00, and date-and-times in ISO 8601 with the time zone.</li>
          <li>Money is a number in rupees with two decimals, never text.</li>
          <li>An empty value is null.</li>
          <li>
            Answers are never cached (<code className="font-mono">Cache-Control: no-store</code>): ask again when you
            need fresh data.
          </li>
        </ul>
      </AnchorSection>

      <AnchorSection
        id="guide-errors"
        title="Errors"
        purpose="A refused call answers with a status number and JSON holding a short code and one plain sentence. The code is for your program, the sentence is for a person."
      >
        <CodeBox
          label="An error answer"
          code={JSON.stringify(
            { error: "invalid_key", message: "The API key is not valid for this endpoint." },
            null,
            2,
          )}
        />
        <ScrollTable label="Errors" testId="guide-error-table" fit>
          <thead>
            <tr>
              <th className={TH}>Status</th>
              <th className={TH}>Code</th>
              <th className={TH}>What it means</th>
            </tr>
          </thead>
          <tbody>
            {ERRORS.map((e) => (
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
        <p className="text-[13px] leading-relaxed text-slate-600">
          Every refused call is written to the Activity log, which is how you find out why an application cannot
          connect.
        </p>
      </AnchorSection>

      <AnchorSection
        id="guide-cors"
        title="Browsers, CORS and allowed origins"
        purpose="A browser only lets a web page call another address when that address agrees. The list of allowed websites is how an endpoint agrees. It is a rule for browsers, not a password."
      >
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-700">
          <li>
            When a web page calls an endpoint, the browser adds an <strong>origin</strong>: the page's own website. The
            endpoint answers a browser only if that origin is in its list. The browser first asks permission (a call
            named OPTIONS), and the endpoint answers it without needing a key.
          </li>
          <li>
            A program on a server sends no origin at all, or any origin it likes. Origins can be faked outside a
            browser, so they can never protect the data on their own.
          </li>
          <li>
            <strong>The key is the protection.</strong> That is why a key must never be placed in a web page: anyone who
            opens the page can read it and use it from anywhere.
          </li>
          <li>
            Better: let your own server call the endpoint (server to server), and let your web page ask your server. The
            key then never leaves the server. Turn on "Calls from your own servers" in the endpoint's Access section for
            this.
          </li>
          <li>
            Only add websites you own, in the form <code className="font-mono">https://host</code> or{" "}
            <code className="font-mono">https://host:port</code>. A star, a path, or plain http (except localhost) is
            refused.
          </li>
        </ul>
        <Notice tone="warn" title="Do not do this" testId="guide-no-browser-keys">
          Do not paste a key into JavaScript that runs in a visitor's browser, into a mobile app, or into a page that is
          published. If you must call from a browser, make a key just for that, ticking only harmless basic fields, with
          an expiry, and expect it to be copied.
        </Notice>
      </AnchorSection>

      <AnchorSection
        id="guide-keys"
        title="Looking after keys"
        purpose="A key is as powerful as a password for the data of its endpoint. Treat it like one."
      >
        <ul className="list-disc space-y-1.5 pl-5 text-[13px] leading-relaxed text-slate-700">
          <li>
            The whole key is shown once, when it is made. The system keeps only a fingerprint, so a lost key cannot be
            recovered: make a new one.
          </li>
          <li>
            Keep it in your server's secret settings, such as an environment variable. Never in the code, in git, in
            e-mail or in a chat.
          </li>
          <li>Make one key for each application and label it with the application's name.</li>
          <li>
            To change a key: make the new one, switch the application to it, then revoke the old one. Nothing stops in
            between.
          </li>
          <li>
            If a key may have leaked, revoke it at once. A revoked key is refused immediately and can not be brought
            back.
          </li>
          <li>Give a key an expiry date when the access is only for a while.</li>
        </ul>
      </AnchorSection>

      <AnchorSection
        id="guide-examples"
        title="Example code"
        purpose="The same call in six languages. Replace the address, and keep the key in the environment variable shown, not in the code."
      >
        <CodeExamples examples={buildExamples(url)} testId="general-code" />
      </AnchorSection>

      <AnchorSection
        id="guide-security"
        title="Security checklist"
        purpose="Go through this list for every new endpoint, and again now and then for the ones that already exist."
      >
        <ul className="space-y-1.5" data-testid="security-checklist">
          {CHECKLIST.map((item) => (
            <li key={item} className="flex items-start gap-2 text-[13px] leading-snug text-slate-700">
              <CircleCheck size={15} className="mt-0.5 shrink-0 text-emerald-600" aria-hidden />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </AnchorSection>
    </div>
  );
}
