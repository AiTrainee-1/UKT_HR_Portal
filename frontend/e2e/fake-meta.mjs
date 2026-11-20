// A stand-in for Meta's WhatsApp Cloud API (the Graph API), used only by the end-to-end suite.
//
// The e2e backend is pointed here (WHATSAPP_CLOUD_API_BASE=http://127.0.0.1:8190) so the real send path runs -template
// resolution, variables, document upload, the bearer token, response parsing, logging- while nothing ever leaves the
// machine. Tests read what "was sent" from GET /messages, which is how they get the code a real employee would have
// received on WhatsApp (each record has `message`: the text the employee would read, so /\b(\d{6})\b/ finds a code).
//
// The Graph API (every path starts with the API version, e.g. /v23.0/...; a bearer token is required):
//   POST   /{ver}/{phone-number-id}/messages           a template message -> {messages: [{id: "wamid.FAKE…"}]}
//   POST   /{ver}/{phone-number-id}/media              a multipart upload -> {id: "FAKEMEDIA…"}
//   GET    /{ver}/{phone-number-id}?fields=…           the number's state (quality GREEN, tier TIER_1K, CONNECTED)
//   GET    /{ver}/{waba-id}/message_templates          the templates -> {data: [...], paging: {cursors}}
//   POST   /{ver}/{waba-id}/message_templates          create one -> {id, status, category}; it is APPROVED at once
//                                                      (FAKE_META_TEMPLATE_STATUS=PENDING to keep it pending)
//   DELETE /{ver}/{waba-id}/message_templates?name=…   delete (all languages, or one with hsm_id)
//   GET    /{ver}/{waba-id}?fields=pricing_analytics…  daily volume / cost per category, from what was sent here
//
// Control endpoints for the tests (no version prefix):
//   GET  /messages          everything sent so far: {id, to, number, template, language, category, params, header,
//                           button, message, receivedAt}
//   GET  /uploads           every media upload: {id, size, contentType, receivedAt}
//   GET  /templates         the templates this fake holds
//   POST /templates/status  {name, status, language?, reason?}: change a template's status (e.g. REJECTED)
//   POST /reset             forget the messages, uploads and pending failures (templates stay)
//   POST /reset-all         forget everything, templates included
//   POST /fail-next         make the next Graph call fail; optional JSON {code, message, status} (default 131026)
//   GET  /health
// FAKE_META_SEED_FILE=<path to a JSON list of templates> starts the fake with those templates (Meta's shape).
import { readFileSync } from "node:fs";
import http from "node:http";

const PORT = Number(process.env.FAKE_META_PORT ?? 8190);
const NEW_TEMPLATE_STATUS = (process.env.FAKE_META_TEMPLATE_STATUS ?? "APPROVED").toUpperCase();
// India rates (INR per message) the backend also assumes by default: only for the fake pricing figures.
const RATES = { authentication: 0.115, utility: 0.115, marketing: 0.8631, service: 0 };

let messages = [];
let uploads = [];
let failures = [];
let templates = [];
let counter = 0;

function seed() {
  const file = process.env.FAKE_META_SEED_FILE;
  if (!file) return [];
  try {
    const list = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(list)
      ? list.map((t) => ({ status: "APPROVED", language: "en", ...t, id: t.id ?? next("8") }))
      : [];
  } catch (err) {
    console.error(`fake Meta: could not read ${file}: ${err.message}`);
    return [];
  }
}

function next(prefix) {
  counter += 1;
  return `${prefix}${String(counter).padStart(6, "0")}`;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function metaError(res, status, code, message) {
  return json(res, status, {
    error: {
      message,
      type: "OAuthException",
      code,
      error_data: { messaging_product: "whatsapp", details: message },
      fbtrace_id: "FAKE",
    },
  });
}

function findTemplate(name, language) {
  return (
    templates.find((t) => t.name === name && t.language === language) ?? templates.find((t) => t.name === name) ?? null
  );
}

// The text the employee would read: the template's body with its variables filled in.
function render(template, params, code) {
  if (template && String(template.category).toUpperCase() === "AUTHENTICATION") {
    return `${code ?? params["1"] ?? ""} is your verification code. For your security, do not share this code.`;
  }
  const body = template?.components?.find((c) => String(c.type).toUpperCase() === "BODY")?.text;
  if (body) {
    return body.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_, name) => params[name] ?? "");
  }
  const values = Object.entries(params).map(([k, v]) => `${k}: ${v}`);
  return [template?.name ?? "template", ...values].join(" | ");
}

function sendMessage(res, body) {
  const tpl = body.template ?? {};
  if (body.messaging_product !== "whatsapp" || body.type !== "template" || !tpl.name) {
    return metaError(res, 400, 100, "(#100) Only template messages are accepted by this fake.");
  }
  const language = tpl.language?.code ?? "";
  const template = findTemplate(tpl.name, language);
  if (template && template.status !== "APPROVED") {
    return metaError(
      res,
      400,
      132001,
      `(#132001) Template name does not exist in the translation (${template.status})`,
    );
  }
  const params = {};
  let header = null;
  let button = null;
  for (const comp of tpl.components ?? []) {
    const list = comp.parameters ?? [];
    if (comp.type === "body") {
      list.forEach((p, i) => {
        params[p.parameter_name ?? String(i + 1)] = p.text;
      });
    } else if (comp.type === "header" && list.length) {
      header = list[0];
    } else if (comp.type === "button" && list.length) {
      button = list[0].text ?? null;
    }
  }
  const id = `wamid.${next("FAKE")}`;
  const category = String(template?.category ?? (button ? "AUTHENTICATION" : "UTILITY")).toLowerCase();
  messages.push({
    id,
    to: body.to,
    number: body.to,
    type: "template",
    template: tpl.name,
    language,
    category,
    params,
    header,
    button,
    message: render(template, params, button),
    receivedAt: new Date().toISOString(),
  });
  return json(res, 200, {
    messaging_product: "whatsapp",
    contacts: [{ input: body.to, wa_id: body.to }],
    messages: [{ id }],
  });
}

function createTemplate(res, payload) {
  if (!payload.name || !/^[a-z0-9_]+$/.test(payload.name)) {
    return metaError(res, 400, 100, "(#100) Template name must be lowercase letters, numbers and underscores.");
  }
  const language = payload.language ?? "en";
  templates = templates.filter((t) => !(t.name === payload.name && t.language === language));
  const template = {
    id: next("9"),
    name: payload.name,
    language,
    category: String(payload.category ?? "UTILITY").toUpperCase(),
    status: NEW_TEMPLATE_STATUS,
    parameter_format: payload.parameter_format ?? "named",
    components: payload.components ?? [],
    quality_score: { score: "UNKNOWN" },
    rejected_reason: "NONE",
  };
  templates.push(template);
  return json(res, 200, { id: template.id, status: template.status, category: template.category });
}

function pricing(fields) {
  const start = Number(/start\((\d+)\)/.exec(fields)?.[1] ?? 0);
  const end = Number(/end\((\d+)\)/.exec(fields)?.[1] ?? Date.now() / 1000);
  const buckets = new Map();
  for (const m of messages) {
    const at = Date.parse(m.receivedAt) / 1000;
    if (at < start || at >= end) continue;
    const day = start + Math.floor((at - start) / 86400) * 86400;
    const key = `${day}|${m.category}`;
    const b = buckets.get(key) ?? {
      start: day,
      end: day + 86400,
      volume: 0,
      cost: 0,
      pricing_category: m.category.toUpperCase(),
      pricing_type: "REGULAR",
    };
    b.volume += 1;
    b.cost = Math.round((b.cost + (RATES[m.category] ?? 0)) * 10000) / 10000;
    buckets.set(key, b);
  }
  return { pricing_analytics: { data: [{ data_points: [...buckets.values()] }] } };
}

const PHONE = {
  display_phone_number: "+91 98765 00000",
  verified_name: "UK Textiles (e2e)",
  quality_rating: "GREEN",
  messaging_limit_tier: "TIER_1K",
  status: "CONNECTED",
  name_status: "APPROVED",
  code_verification_status: "VERIFIED",
  throughput: { level: "STANDARD" },
  platform_type: "CLOUD_API",
};

function graph(req, res, url, parts, raw) {
  if (!/^Bearer \S+/.test(req.headers.authorization ?? "")) {
    return metaError(res, 401, 190, "Invalid OAuth access token - Cannot parse access token");
  }
  if (failures.length) {
    const f = failures.shift();
    return metaError(res, f.status ?? 400, f.code ?? 131026, f.message ?? "Message undeliverable.");
  }
  const [id, edge] = parts;
  let body = {};
  if ((req.headers["content-type"] ?? "").includes("application/json")) {
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      return metaError(res, 400, 100, "(#100) Invalid JSON");
    }
  }
  if (req.method === "POST" && edge === "messages") return sendMessage(res, body);
  if (req.method === "POST" && edge === "media") {
    const media = {
      id: next("FAKEMEDIA"),
      size: raw.length,
      contentType: req.headers["content-type"] ?? "",
      receivedAt: new Date().toISOString(),
    };
    uploads.push(media);
    return json(res, 200, { id: media.id });
  }
  if (edge === "message_templates") {
    if (req.method === "GET") {
      return json(res, 200, { data: templates, paging: { cursors: { before: "BEFORE", after: "AFTER" } } });
    }
    if (req.method === "POST") return createTemplate(res, body);
    if (req.method === "DELETE") {
      const name = url.searchParams.get("name");
      const hsm = url.searchParams.get("hsm_id");
      const before = templates.length;
      templates = templates.filter((t) => !(t.name === name && (!hsm || t.id === hsm)));
      if (templates.length === before) return metaError(res, 400, 100, "(#100) Template not found");
      return json(res, 200, { success: true });
    }
  }
  if (req.method === "GET" && !edge) {
    const fields = url.searchParams.get("fields") ?? "";
    if (fields.startsWith("pricing_analytics")) return json(res, 200, { ...pricing(fields), id });
    return json(res, 200, { ...PHONE, id });
  }
  return metaError(res, 400, 100, `(#100) Unsupported request ${req.method} ${url.pathname}`);
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length && /^v\d+(\.\d+)?$/.test(parts[0])) return graph(req, res, url, parts.slice(1), raw);

    let body = {};
    try {
      body = raw.length ? JSON.parse(raw.toString("utf8")) : {};
    } catch {
      /* fall through with an empty body */
    }
    const path = url.pathname;
    if (req.method === "GET" && path === "/messages") return json(res, 200, messages);
    if (req.method === "GET" && path === "/uploads") return json(res, 200, uploads);
    if (req.method === "GET" && path === "/templates") return json(res, 200, templates);
    if (req.method === "POST" && path === "/templates/status") {
      const t = findTemplate(body.name, body.language);
      if (!t) return json(res, 404, { error: "no such template" });
      t.status = String(body.status ?? "APPROVED").toUpperCase();
      t.rejected_reason = body.reason ?? "NONE";
      return json(res, 200, t);
    }
    if (req.method === "POST" && path === "/reset") {
      messages = [];
      uploads = [];
      failures = [];
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/reset-all") {
      messages = [];
      uploads = [];
      failures = [];
      templates = seed();
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/fail-next") {
      failures.push({ code: body.code, message: body.message, status: body.status });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
    return json(res, 404, { error: "not found" });
  });
});

templates = seed();
server.listen(PORT, "127.0.0.1", () => console.log(`fake Meta WhatsApp Cloud API listening on ${PORT}`));
