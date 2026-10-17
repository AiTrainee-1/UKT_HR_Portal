import { describe, expect, it } from "vitest";
import { checkOrigin, ORIGIN_EXAMPLES } from "./origin";

// The allowed-origin rules, mirroring the server's (backend/api/shared_endpoint_admin_views.py normalize_origin): scheme://host
// with an optional port, lower case, http only for localhost, no wildcard, no path.

describe("checkOrigin: values that are kept (and how they are written down)", () => {
  const valid: [input: string, saved: string][] = [
    ["https://intranet.example.com", "https://intranet.example.com"],
    ["  https://Intranet.Example.COM  ", "https://intranet.example.com"],
    ["https://reports.example.com:8443", "https://reports.example.com:8443"],
    ["https://intranet.example.com:443", "https://intranet.example.com"],
    ["http://localhost", "http://localhost"],
    ["http://localhost:5173", "http://localhost:5173"],
    ["http://127.0.0.1:8000", "http://127.0.0.1:8000"],
    ["http://[::1]:3000", "http://[::1]:3000"],
    ["https://10.1.2.3", "https://10.1.2.3"],
    ["https://a.b-c.example.co.in", "https://a.b-c.example.co.in"],
    // a lone trailing slash is forgiven (it is dropped)
    ["https://intranet.example.com/", "https://intranet.example.com"],
  ];
  it.each(valid)("%s", (input, saved) => {
    expect(checkOrigin(input)).toEqual({ ok: true, origin: saved });
  });
});

describe("checkOrigin: values that are refused, each with its own plain sentence", () => {
  const invalid: [input: string, mentions: RegExp][] = [
    ["", /Type the address/],
    ["   ", /Type the address/],
    ["*", /star/i],
    ["null", /null/],
    ["https://*.example.com", /star/i],
    ["intranet.example.com", /http:\/\/ or https:\/\//],
    ["ftp://intranet.example.com", /Only https/],
    ["javascript://example.com", /Only https/],
    ["http://intranet.example.com", /localhost/],
    ["http://10.0.0.5", /localhost/],
    ["https://intranet.example.com/reports", /path/],
    ["https://intranet.example.com/a/", /path/],
    ["https://intranet.example.com?x=1", /\? or #/],
    ["https://intranet.example.com#top", /\? or #/],
    ["https://user:pass@intranet.example.com", /user name or password/],
    ["https://intranet.example.com:0", /port/],
    ["https://intranet.example.com:65536", /port/],
    ["https://intranet.example.com:abc", /port/],
    ["https://intranet.example.com:", /port/],
    ["https://", /missing/],
    ["https://:8080", /missing/],
    ["https://bad host.example.com", /spaces/],
    ["https://-bad.example.com", /not valid/],
    ["https://bad_host.example.com", /not valid/],
    ["https://256.1.1.1", /IP address/],
  ];
  it.each(invalid)("%j", (input, mentions) => {
    const result = checkOrigin(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(mentions);
  });
});

describe("the examples shown on the screen", () => {
  it("are all true to the rules", () => {
    expect(ORIGIN_EXAMPLES.length).toBeGreaterThanOrEqual(6);
    for (const example of ORIGIN_EXAMPLES) {
      expect(checkOrigin(example.value).ok, example.value).toBe(example.valid);
      expect(example.note.length).toBeGreaterThan(10);
    }
    expect(ORIGIN_EXAMPLES.some((e) => e.valid)).toBe(true);
    expect(ORIGIN_EXAMPLES.some((e) => !e.valid)).toBe(true);
  });
});
