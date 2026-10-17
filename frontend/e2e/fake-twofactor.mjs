// A stand-in for 2Factor.in's SMS OTP API, used only by the end-to-end suite.
//
// The e2e backend is pointed here (TWOFACTOR_API_BASE=http://127.0.0.1:8192/API/V1) so the real SMS send path runs -request
// building, the API key in the path, response parsing, the log- while nothing ever leaves the machine. Tests read what "was
// sent" from this server: GET /last-code is how they get the code an employee would have received by SMS.
//
// What it accepts is what backend/api/twofactor_client.py sends (2Factor's custom-OTP call, the API key is in the PATH):
//
//   GET  /API/V1/<api key>/SMS/+919000000001/482913/<template name>
//                       recorded with authkey = the key from the path, code and templateId (the template NAME);
//                       answers 200 {"Status": "Success", "Details": "<session id>"}
//
//   GET  /last-code?mobile=9000000001   the code of the newest ACCEPTED request to that number (404 when there is none):
//                                       {"code", "mobile", "templateId", "id", "receivedAt"}
//   GET  /requests[?mobile=...]         everything recorded so far, oldest first (a request that was answered with an error
//                                       has "failed": true)
//   POST /reset                         forget everything, and any failure that was queued
//   POST /fail-next                     make the next request(s) fail: {"times": 1, "status": 400, "body": {...}}
//                                       (default: one answer 400 {"Status": "Error", "Details": "Invalid API Key"})
//   GET  /health
import http from "node:http";

const PORT = Number(process.env.FAKE_TWOFACTOR_PORT ?? 8192);

let requests = [];
let failures = [];
let counter = 0;

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** "919000000001", "+91 90000 00001" and "9000000001" are the same number: compare the last ten digits. */
const tail = (value) =>
  String(value ?? "")
    .replace(/\D/g, "")
    .slice(-10);

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const raw = Buffer.concat(chunks).toString();
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      /* fall through with an empty body */
    }
    const path = url.pathname;

    const call = req.method === "GET" ? /\/([^/]+)\/SMS\/\+?(\d+)\/(\d+)(?:\/([^/]+))?$/.exec(path) : null;
    if (call) {
      const [, key, mobile, code, template] = call;
      counter += 1;
      const entry = {
        id: `FAKE2F${String(counter).padStart(6, "0")}`,
        path: path.replace(key, "<key>"),
        authkey: key,
        templateId: template ?? null,
        mobile,
        code,
        receivedAt: new Date().toISOString(),
      };
      requests.push(entry);
      if (failures.length > 0) {
        const failure = failures[0];
        failure.times -= 1;
        if (failure.times <= 0) failures.shift();
        entry.failed = true;
        return json(res, failure.status, failure.body);
      }
      return json(res, 200, { Status: "Success", Details: entry.id });
    }
    if (req.method === "GET" && path === "/last-code") {
      const mobile = tail(url.searchParams.get("mobile"));
      // a request that was answered with an error was not delivered: it has no code to read
      const mine = requests.filter((r) => !r.failed && (!mobile || tail(r.mobile) === mobile));
      const last = mine[mine.length - 1];
      if (!last) return json(res, 404, { error: "no SMS was sent to that number" });
      return json(res, 200, {
        code: last.code,
        mobile: last.mobile,
        templateId: last.templateId,
        id: last.id,
        receivedAt: last.receivedAt,
      });
    }
    if (req.method === "GET" && path === "/requests") {
      const mobile = tail(url.searchParams.get("mobile"));
      return json(res, 200, mobile ? requests.filter((r) => tail(r.mobile) === mobile) : requests);
    }
    if (req.method === "POST" && path === "/reset") {
      requests = [];
      failures = [];
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && path === "/fail-next") {
      failures.push({
        times: Number(body.times ?? 1),
        status: Number(body.status ?? 400),
        body: body.body ?? { Status: "Error", Details: "Invalid API Key" },
      });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/health") return json(res, 200, { ok: true });
    return json(res, 404, { error: "not found" });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake 2Factor listening on ${PORT}`));
