// A stand-in for Google's Gemini API, used only by the end-to-end suite.
//
// The e2e backend is pointed here (GEMINI_API_BASE_URL) so the REAL assistant runs end to end (the prompt it builds, its
// tool loop, the read-only tools against the real e2e database, privacy, the explanation) while nothing ever leaves the
// machine and no API key or quota is involved. The "model" is a small script keyed on the question, because what the
// tests care about is what the server sends, runs and shows, not how clever Gemini is.
//
//   POST /v1beta/models/<model>:generateContent   scripted function-calling replies (see script() below)
//   GET  /v1beta/models                            the model list the settings page offers
//   GET  /requests                                 every request body received (to check what was SENT: no names)
//   POST /reset                                    forget requests and any queued failure
//   POST /fail-next  {"status": 503|429, ...}      make the next generateContent answer with that error
//   GET  /health
import http from "node:http";

const PORT = Number(process.env.FAKE_GEMINI_PORT ?? 8191);
let received = [];
let failures = [];
let counter = 0;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

const textOf = (content) => (content?.parts ?? []).map((p) => p.text ?? "").join(" ");
const call = (name, args, id) => ({ functionCall: { id: id ?? `call-${++counter}`, name, args } });
const submit = (fields) =>
  call("submit_answer", {
    answer_type: "answer",
    confidence: "high",
    explanation: ["I looked up the figure in the company's records."],
    suggested_pages: [],
    follow_ups: [],
    ...fields,
  });

/** The scripted "model": what to say given the conversation so far. */
function script(body) {
  const contents = body.contents ?? [];
  const system = body.systemInstruction?.parts?.[0]?.text ?? "";
  const last = contents[contents.length - 1];

  // speech to text (the fallback when the browser cannot recognise speech)
  if (/speech-to-text engine/i.test(system)) {
    return { parts: [{ text: JSON.stringify({ text: "how many employees are active", language: "en-IN" }) }] };
  }

  // a connection test from the settings page
  if (!body.tools) return { parts: [{ text: "OK" }] };

  // the answer to a lookup that just came back: turn it into the final answer
  const responses = (last?.parts ?? []).filter((p) => p.functionResponse);
  if (responses.length > 0) {
    const first = responses[0].functionResponse.response;
    if (first.error) {
      return {
        parts: [
          submit({
            answer_type: "cannot_answer",
            answer: `I could not look that up: ${first.error}`,
            spoken_summary: "I could not look that up.",
          }),
        ],
      };
    }
    const rows = first.result?.rows ?? [];
    const total = rows.reduce((n, r) => n + (r.count ?? 0), 0);
    const byStatus = rows.map((r) => `${r.status ?? r.department ?? "all"}: ${r.count}`).join(", ");
    return {
      parts: [
        submit({
          answer: `**${total}** records match.\n\n- Breakdown: ${byStatus || "no groups"}.`,
          spoken_summary: `${total} records match.`,
          explanation: ["I counted the matching records in the dataset.", "I grouped them as asked."],
          assumptions: ["Everyone in the company was included."],
          suggested_pages: [{ page: "employees", reason: "See who these people are, with tenure and movement." }],
          follow_ups: ["And by department?"],
        }),
      ],
    };
  }

  const question = textOf(last).toLowerCase();

  if (question.includes("@emp-")) {
    // privacy: the question reached the "model" with the name already replaced by a token; echo it back
    const token = question.match(/@emp-\d+/)[0];
    return {
      parts: [
        submit({
          answer: `${token} is one of the active people, working in **Stitching**.`,
          spoken_summary: `${token} works in stitching.`,
        }),
      ],
    };
  }
  if (question.includes("headcount") || question.includes("how many employees")) {
    return {
      parts: [
        call(
          "query_data",
          { dataset: "employees", filters: [{ field: "status", op: "eq", value: "active" }], group_by: ["department"] },
          "q1",
        ),
      ],
    };
  }
  if (question.includes("attendance")) {
    return {
      parts: [call("query_data", { dataset: "attendance_days", period: "this_year", group_by: ["status"] }, "q2")],
    };
  }
  if (question.includes("invalid lookup")) {
    return { parts: [call("query_data", { dataset: "no_such_dataset" }, "q3")] };
  }
  if (question.includes("write")) {
    return {
      parts: [
        submit({
          answer_type: "cannot_answer",
          answer:
            "I can only read and analyse data; I cannot change anything. A person can do that on the Employees page.",
          spoken_summary: "I can only read data, not change it.",
          suggested_pages: [{ page: "employees", reason: "Where a person can make that change." }],
        }),
      ],
    };
  }
  return {
    parts: [
      submit({
        answer: "This is a scripted answer from the test model.",
        spoken_summary: "This is a scripted answer.",
      }),
    ],
  };
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString();
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* an empty body */
    }
    const url = (req.url ?? "").split("?")[0];

    if (req.method === "GET" && url === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && url === "/requests") return json(res, 200, received);
    if (req.method === "POST" && url === "/reset") {
      received = [];
      failures = [];
      counter = 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && url === "/fail-next") {
      failures.push({ status: body.status ?? 503, daily: !!body.daily });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && url === "/v1beta/models") {
      return json(res, 200, {
        models: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"].map((name) => ({
          name: `models/${name}`,
          supportedGenerationMethods: ["generateContent"],
        })),
      });
    }

    const match = url.match(/^\/v1beta\/models\/([^/:]+):generateContent$/);
    if (req.method === "POST" && match) {
      received.push({ model: match[1], key: req.headers["x-goog-api-key"] ?? null, body });
      const failure = failures.shift();
      if (failure) {
        const detail = failure.daily
          ? [
              {
                "@type": "type.googleapis.com/google.rpc.QuotaFailure",
                violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier" }],
              },
            ]
          : [];
        return json(res, failure.status, {
          error: {
            code: failure.status,
            status: failure.status === 429 ? "RESOURCE_EXHAUSTED" : "UNAVAILABLE",
            message: "scripted failure",
            details: detail,
          },
        });
      }
      const reply = script(body);
      return json(res, 200, {
        candidates: [{ content: { role: "model", parts: reply.parts }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 30 },
        modelVersion: match[1],
      });
    }

    json(res, 404, { error: { code: 404, status: "NOT_FOUND", message: `no route ${req.method} ${url}` } });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake gemini listening on ${PORT}`));
