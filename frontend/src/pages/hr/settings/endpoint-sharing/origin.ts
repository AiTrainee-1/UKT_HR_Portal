// An "allowed origin" is where a BROWSER page that may call an endpoint is served from: scheme://host[:port]. The checks
// here mirror the server's (spec section 5): the same words, so a value the screen accepts is a value the server accepts.

export type OriginCheck = { ok: true; origin: string } | { ok: false; error: string };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A hostname: labels of letters, digits and hyphens joined by dots (not starting or ending in a hyphen). */
const HOST_NAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
const IPV6 = /^\[[0-9a-f:.]+\]$/;

/**
 * Checks one allowed origin and returns it in the form that is saved (lower case, no trailing slash), or a plain sentence
 * saying what is wrong. A lone trailing slash is forgiven (everybody pastes it); anything after it is a path and is refused.
 */
export function checkOrigin(input: string): OriginCheck {
  const raw = input.trim();
  if (raw === "")
    return { ok: false, error: "Type the address of the website, for example https://intranet.example.com." };
  if (raw === "*") {
    return {
      ok: false,
      error: "A star (allow every website) is not allowed. Name each website that may call this endpoint.",
    };
  }
  if (raw.toLowerCase() === "null") {
    return {
      ok: false,
      error: "The word null is not an address. Name the website, for example https://intranet.example.com.",
    };
  }
  if (raw.includes("*")) {
    return { ok: false, error: "A star is not allowed in an origin. Write each website out in full." };
  }
  if (/\s/.test(raw)) return { ok: false, error: "An origin cannot contain spaces." };

  const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(raw);
  if (!match) {
    return {
      ok: false,
      error: "Start with http:// or https://, then the website name, for example https://intranet.example.com.",
    };
  }
  const scheme = match[1].toLowerCase();
  if (scheme !== "http" && scheme !== "https") {
    return { ok: false, error: `Only https:// (or http:// for localhost) is allowed, not ${scheme}://.` };
  }

  let rest = match[2];
  if (rest.endsWith("/") && !rest.slice(0, -1).includes("/") && !/[?#]/.test(rest)) rest = rest.slice(0, -1);
  if (/[?#]/.test(rest))
    return { ok: false, error: "Remove everything after the website name: an origin has no ? or # part." };
  if (rest.includes("/"))
    return { ok: false, error: "Remove the path: an origin is only the scheme, the website name and a port." };
  if (rest.includes("@")) return { ok: false, error: "An origin cannot hold a user name or password." };
  if (rest === "") return { ok: false, error: "The website name is missing after ://." };

  let host = rest.toLowerCase();
  let port = "";
  const bracket = /^(\[[^\]]*\])(?::(.*))?$/.exec(host);
  if (bracket) {
    host = bracket[1];
    port = bracket[2] ?? "";
  } else {
    const colon = host.lastIndexOf(":");
    if (colon !== -1) {
      port = host.slice(colon + 1);
      host = host.slice(0, colon);
    }
  }
  if (host === "") return { ok: false, error: "The website name is missing before the port." };
  if (port !== "" || rest.endsWith(":")) {
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
      return { ok: false, error: "The port must be a number from 1 to 65535." };
    }
  }

  const isIpv6 = IPV6.test(host);
  const isIpv4 = IPV4.test(host);
  if (isIpv4 && host.split(".").some((part) => Number(part) > 255)) {
    return { ok: false, error: "That IP address is not valid: each number is 0 to 255." };
  }
  if (!isIpv6 && !isIpv4 && !HOST_NAME.test(host)) {
    return { ok: false, error: "That website name is not valid: use letters, digits, dots and hyphens only." };
  }
  if (scheme === "http" && !LOCAL_HOSTS.has(host)) {
    return { ok: false, error: "Plain http:// is only allowed for localhost. Use https:// for every other website." };
  }
  // browsers never send the scheme's usual port, so the server keeps the origin without it
  const usual = scheme === "https" ? "443" : "80";
  const shownPort = port !== "" && String(Number(port)) !== usual ? String(Number(port)) : "";
  return { ok: true, origin: `${scheme}://${host}${shownPort ? `:${shownPort}` : ""}` };
}

/** What the screen shows as examples, with the sentence a person needs. Used by the Access section and by its test. */
export const ORIGIN_EXAMPLES: { value: string; valid: boolean; note: string }[] = [
  { value: "https://intranet.example.com", valid: true, note: "A website on https." },
  { value: "https://reports.example.com:8443", valid: true, note: "A website with its own port." },
  { value: "http://localhost:5173", valid: true, note: "Plain http is fine for localhost only." },
  { value: "http://intranet.example.com", valid: false, note: "Plain http is not allowed except for localhost." },
  { value: "https://*.example.com", valid: false, note: "No stars. Add each website by name." },
  { value: "https://intranet.example.com/reports", valid: false, note: "No path. Only the website itself." },
  { value: "*", valid: false, note: "Allowing every website is never possible." },
];
