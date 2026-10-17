import type { SettingMeta } from "./kit/catalog";
import type { Subtab } from "./endpoint-sharing/address";

/** Section headings, so the cards and this list cannot drift apart. */
export const ENDPOINT_SHARING_SECTIONS = {
  endpoints: "Endpoints",
  guide: "Integration guide",
  activity: "Activity",
} as const;

const S = ENDPOINT_SHARING_SECTIONS;

/**
 * Every setting that has an anchor on the tab without an endpoint being open (the list, the guide and the log), with the
 * words they show. What is inside an endpoint (its fields, websites, keys and limits) is searched through the guide
 * sections that explain it (guide-cors, guide-keys, guide-security), because an endpoint's own editor only exists once one
 * is open.
 */
const BLOCKS: (Omit<SettingMeta, "tab"> & { sub: Subtab })[] = [
  {
    id: "endpoints-list",
    sub: "endpoints",
    section: S.endpoints,
    title: "Shared endpoints",
    purpose:
      "Each endpoint is a web address that gives one of your other applications a chosen slice of the HR data, read only. You choose the data, the fields and who may call it. Open one to change it, or make a new one.",
    keywords: [
      "api",
      "share",
      "sharing",
      "endpoint",
      "integration",
      "expose",
      "data",
      "fields",
      "key",
      "origin",
      "new",
    ],
  },
  {
    id: "guide-how",
    sub: "guide",
    section: S.guide,
    title: "How sharing works",
    purpose:
      "Endpoint Sharing lets one of your other applications read a chosen slice of the HR data, safely, and never change it.",
    keywords: ["api", "integration", "developer", "read only", "dataset", "endpoint"],
  },
  {
    id: "guide-auth",
    sub: "guide",
    section: S.guide,
    title: "Authentication: the API key",
    purpose:
      "Every call must carry an API key, in a header. The key is what proves the caller is allowed. A key belongs to one endpoint and can read nothing else.",
    keywords: ["api key", "bearer", "authorization", "x-api-key", "token", "header", "password"],
  },
  {
    id: "guide-request",
    sub: "guide",
    section: S.guide,
    title: "The request",
    purpose:
      "A call is a GET to the endpoint's address. The address is this system's address followed by /api/shared/ and the endpoint's own address.",
    keywords: ["get", "url", "base address", "parameters", "page", "pagesize", "filters"],
  },
  {
    id: "guide-pagination",
    sub: "guide",
    section: S.guide,
    title: "Pages of results",
    purpose:
      "Results come a page at a time, so one call can never pull a whole table. Keep asking for the next page until there are no more.",
    keywords: ["page", "pagination", "page size", "hasmore", "rows", "next page"],
  },
  {
    id: "guide-response",
    sub: "guide",
    section: S.guide,
    title: "What comes back",
    purpose:
      "JSON. The rows are in data and contain only the fields ticked on the endpoint. The details of the page are in meta.",
    keywords: ["json", "response", "format", "meta", "data", "dates", "money"],
  },
  {
    id: "guide-errors",
    sub: "guide",
    section: S.guide,
    title: "Errors",
    purpose:
      "A refused call answers with a status number and JSON holding a short code and one plain sentence. The code is for your program, the sentence is for a person.",
    keywords: ["401", "403", "404", "429", "400", "rate limit", "too many calls", "invalid key", "refused"],
  },
  {
    id: "guide-cors",
    sub: "guide",
    section: S.guide,
    title: "Browsers, CORS and allowed origins",
    purpose:
      "A browser only lets a web page call another address when that address agrees. The list of allowed websites is how an endpoint agrees. It is a rule for browsers, not a password.",
    keywords: ["cors", "origin", "origins", "allowed websites", "browser", "server to server", "preflight", "website"],
  },
  {
    id: "guide-keys",
    sub: "guide",
    section: S.guide,
    title: "Looking after keys",
    purpose: "A key is as powerful as a password for the data of its endpoint. Treat it like one.",
    keywords: ["api key", "revoke", "rotate", "expiry", "secret", "leak", "label"],
  },
  {
    id: "guide-examples",
    sub: "guide",
    section: S.guide,
    title: "Example code",
    purpose:
      "The same call in six languages. Replace the address, and keep the key in the environment variable shown, not in the code.",
    keywords: ["curl", "javascript", "python", "php", "c#", "csharp", "node", "code", "sample"],
  },
  {
    id: "guide-security",
    sub: "guide",
    section: S.guide,
    title: "Security checklist",
    purpose: "Go through this list for every new endpoint, and again now and then for the ones that already exist.",
    keywords: ["security", "checklist", "sensitive", "personal", "financial", "salary", "safe"],
  },
  {
    id: "activity-log",
    sub: "activity",
    section: S.activity,
    title: "Activity",
    purpose:
      "Every call that reached an endpoint, newest first: when, what the answer was, which key, which website and which address it came from. The log is kept for 90 days. Use it to see who uses an endpoint and to spot refused calls.",
    keywords: ["log", "access log", "calls", "history", "audit", "who called", "refused"],
  },
];

/** Which subtab holds each searchable setting: the address `#guide-cors` opens the Integration guide. */
export const ENDPOINT_SHARING_SUBTAB_OF: Record<string, Subtab> = Object.fromEntries(BLOCKS.map((b) => [b.id, b.sub]));

/** Every setting on the Endpoint Sharing tab, for the page's search (see kit/catalog.ts). */
export const ENDPOINT_SHARING_SETTINGS: SettingMeta[] = BLOCKS.map(({ sub: _sub, ...b }) => ({
  ...b,
  tab: "endpoint_sharing",
}));
