// A stand-in for WAClient's /send endpoint, used only by the end-to-end suite.
//
// The e2e backend is pointed here (WACLIENT_API_URL) so the real send path runs
// -request building, credentials, response parsing, logging- while nothing ever
// leaves the machine. Tests read what "was sent" from GET /messages, which is how
// they get the OTP a real employee would have received on WhatsApp.
//
//   POST /send      accepts the same JSON as WAClient, records it, answers success
//   POST /send_contact  a contact card (the visitor's tap-to-call card), recorded with kind: "contact"
//   GET  /messages  everything recorded so far
//   POST /reset     forget everything
//   POST /fail-next make the next /send answer with an error (to test failure paths)
import http from "node:http";

const PORT = Number(process.env.FAKE_WACLIENT_PORT ?? 8190);
let messages = [];
let failNext = 0;
let counter = 0;

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
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
      /* fall through with an empty body */
    }

    if (req.method === "POST" && req.url === "/send") {
      if (failNext > 0) {
        failNext -= 1;
        return json(res, 200, { status: "error", message: "Instance not connected" });
      }
      counter += 1;
      const id = `FAKE${String(counter).padStart(6, "0")}`;
      messages.push({ ...body, id, receivedAt: new Date().toISOString() });
      return json(res, 200, {
        status: "success",
        message: "Success",
        message_payload: { key: { remoteJid: `${body.number}@s.whatsapp.net`, fromMe: true, id }, status: "PENDING" },
      });
    }
    if (req.method === "POST" && req.url === "/send_contact") {
      // A contact card: recorded next to the text messages, marked so tests can tell them apart.
      counter += 1;
      const id = `FAKE${String(counter).padStart(6, "0")}`;
      messages.push({ ...body, kind: "contact", id, receivedAt: new Date().toISOString() });
      return json(res, 200, {
        status: "success",
        message: "Success",
        data: { chat_id: `${body.number}@s.whatsapp.net`, sent: true },
      });
    }
    if (req.method === "GET" && req.url === "/messages") return json(res, 200, messages);
    if (req.method === "POST" && req.url === "/reset") {
      messages = [];
      failNext = 0;
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && req.url === "/fail-next") {
      failNext += 1;
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
    return json(res, 404, { error: "not found" });
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`fake WAClient listening on ${PORT}`));
