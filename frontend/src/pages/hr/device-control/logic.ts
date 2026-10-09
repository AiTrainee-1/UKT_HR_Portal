// Device Control's pure rules: what a person's row says, how filters become a request, what a device form may contain,
// how big a device's log is. No React here, so every rule has a plain unit test (logic.test.ts).
import type {
  DeleteResult,
  DeviceControlDevice,
  DeviceMode,
  FetchPreset,
  FetchRange,
  FetchRun,
  ConnectorState,
  ConnectorSync,
  PeopleParams,
  PersonLink,
  PersonRow,
  PushResult,
  UserInput,
} from "@/lib/api-client/custom-hooks";
import { relativeTime, type Tone } from "../device-status/logic";

// ── devices ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "HO - 1 PROD" → "HO-1": short enough for a chip in a row of six. The full name stays in the tooltip. */
export function shortDeviceName(name: string): string {
  return name
    .replace(/\bPROD\b/gi, "")
    .replace(/\s*-\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export type CapacityLevel = { percent: number; tone: Tone };

/** How full a device's memory is, and how worried to look: from 80% a warning, from 95% a problem. */
export function capacityLevel(used: number | undefined, cap: number | undefined): CapacityLevel | null {
  if (used == null || !cap) return null;
  const percent = Math.min(100, Math.round((used / cap) * 100));
  return { percent, tone: percent >= 95 ? "bad" : percent >= 80 ? "warn" : "good" };
}

export const formatCount = (n: number | null | undefined): string => (n == null ? "–" : n.toLocaleString("en-IN"));

/** The things on a device worth the user's attention, in order of how much they matter. */
export type DeviceAlert = { key: string; tone: Tone; text: string };

export function deviceAlerts(d: DeviceControlDevice): DeviceAlert[] {
  const out: DeviceAlert[] = [];
  const logs = capacityLevel(d.capacity?.records, d.capacity?.recordsCap);
  if (logs && logs.tone !== "good") {
    out.push({
      key: "log-full",
      tone: logs.tone,
      text:
        logs.tone === "bad"
          ? `Attendance log is ${logs.percent}% full (${formatCount(d.capacity?.records)} of ${formatCount(d.capacity?.recordsCap)}). The device may stop recording or overwrite old punches.`
          : `Attendance log is ${logs.percent}% full.`,
    });
  }
  if (d.clockSkewSeconds != null && Math.abs(d.clockSkewSeconds) > 300) {
    const minutes = Math.round(Math.abs(d.clockSkewSeconds) / 60);
    const text = minutes >= 90 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
    out.push({
      key: "clock",
      tone: "warn",
      text: `The device's clock is ${text} ${d.clockSkewSeconds > 0 ? "ahead of" : "behind"} the server, so its punches will carry the wrong time.`,
    });
  }
  const users = d.capacity?.users;
  const faces = d.capacity?.faces;
  if (users != null && faces != null && users > 0 && faces < users) {
    const missing = users - faces;
    out.push({
      key: "faces",
      tone: "muted",
      text: `${missing} ${missing === 1 ? "user has" : "users have"} no face enrolled (${formatCount(faces)} faces for ${formatCount(users)} users).`,
    });
  }
  if (d.usersRead.error)
    out.push({ key: "read-error", tone: "warn", text: `Users could not be read: ${d.usersRead.error}` });
  return out;
}

/** What to tell the person when a device cannot be reached, and what to do about it. */
export function connectionAdvice(d: DeviceControlDevice): string {
  switch (d.connection.code) {
    case "cloud":
      return "This server cannot reach a factory network. Install a Site Connector on a computer at the factory and choose it for this device (Settings → Devices → Connect via), or have the firewall forward the device's port to this server.";
    case "connector_offline":
      return "Check that the computer running the Site Connector is on and has internet. Its card under Site connectors says when it was last heard from.";
    case "connector_off":
      return "Switch the Site Connector on again under Site connectors.";
    case "pending":
      return "The Site Connector has not checked this device yet. It looks every minute; press Check connections to ask now.";
    case "timeout":
    case "unreachable":
      return d.via
        ? "Check that the device is on, its network cable, and that its address in Settings → Devices is its address on the factory network, as the connector's computer sees it."
        : "Check that the device is on, its network cable, and that its IP address in Settings → Devices is right.";
    case "refused":
      return "The device is there, but not accepting this port. Check the TCP COMM. Port on the device against Settings → Devices.";
    case "auth":
      return "Correct the Comm Key (password) for this device in Settings → Devices.";
    case "config":
      return "The Comm Key in Settings → Devices must be a number (usually 0).";
    default:
      return "";
  }
}

// ── roles and the fields of a user ──────────────────────────────────────────────────────────────────────────────────

export const ROLE_OPTIONS = [
  { value: 0, label: "User", hint: "Punches only. The right choice for nearly everyone." },
  { value: 2, label: "Enroller", hint: "Can enrol users at the device." },
  { value: 6, label: "Administrator", hint: "Can open the device menu." },
  { value: 14, label: "Super admin", hint: "Full control of the device, including its menu and its users." },
] as const;

export const roleLabel = (privilege: number): string =>
  ROLE_OPTIONS.find((r) => r.value === privilege)?.label ?? `Role ${privilege}`;

export const isAdminRole = (privilege: number): boolean => privilege !== 0;

export const NAME_BYTES = 24;
export const PASSWORD_DIGITS = 8;
export const DEFAULT_PIN_WIDTH = 9;
export const MAX_CARD = 4294967295;

const encoder = new TextEncoder();
export const byteLength = (text: string): number => encoder.encode(text).length;

/** The longest start of `text` that fits in `limit` bytes of UTF-8 (a character is never cut in half). */
export function trimToBytes(text: string, limit: number = NAME_BYTES): string {
  let out = "";
  for (const ch of text) {
    if (byteLength(out + ch) > limit) break;
    out += ch;
  }
  return out;
}

/** The name a device would hold for an HRMS employee: "First Last", cut to what fits. */
export const deviceNameFor = (employeeName: string): string => trimToBytes(employeeName.replace(/\s+/g, " ").trim());

export type UserForm = {
  userId: string;
  name: string;
  privilege: number;
  password: string;
  card: string;
  group: string;
};

export const EMPTY_FORM: UserForm = { userId: "", name: "", privilege: 0, password: "", card: "", group: "" };

export type FormErrors = Partial<Record<keyof UserForm, string>>;

export function validateForm(form: UserForm, opts: { pinWidth?: number; mode: "create" | "edit" }): FormErrors {
  const errors: FormErrors = {};
  const pin = opts.pinWidth ?? DEFAULT_PIN_WIDTH;
  if (opts.mode === "create") {
    if (!form.userId.trim()) errors.userId = "Enter the user ID (the Employee Code).";
    else if (!/^[A-Za-z0-9._-]+$/.test(form.userId.trim()))
      errors.userId = "Letters, digits, dots, dashes and underscores only.";
    else if (form.userId.trim().length > pin) errors.userId = `At most ${pin} characters on these devices.`;
    if (!form.name.trim()) errors.name = "Enter a name.";
  }
  if (byteLength(form.name.trim()) > NAME_BYTES) errors.name = `At most ${NAME_BYTES} characters on the device.`;
  if (!/^[0-9]{0,8}$/.test(form.password)) errors.password = `Up to ${PASSWORD_DIGITS} digits.`;
  if (form.card.trim() !== "") {
    if (!/^[0-9]+$/.test(form.card.trim())) errors.card = "The card number is digits only.";
    else if (Number(form.card.trim()) > MAX_CARD) errors.card = "That card number is too large.";
  }
  if (new TextEncoder().encode(form.group.trim()).length > 7) errors.group = "At most 7 characters.";
  return errors;
}

/** What to send for a CREATE: every field, with empty ones left out. */
export function newUserInput(form: UserForm, employeeId?: number | null): UserInput {
  const input: UserInput = {
    userId: form.userId.trim(),
    name: form.name.replace(/\s+/g, " ").trim(),
    privilege: form.privilege,
  };
  if (form.password) input.password = form.password;
  if (form.card.trim()) input.card = Number(form.card.trim());
  if (form.group.trim()) input.group = form.group.trim();
  if (employeeId) input.employeeId = employeeId;
  return input;
}

/** What to send for an EDIT: only what changed. A field left out stays as it is on every device, so editing the name
 *  does not overwrite another device's card number with this one's. */
export function changedFields(initial: UserForm, now: UserForm): UserInput | null {
  const out: UserInput = { userId: initial.userId };
  let changed = false;
  if (now.name.trim() !== initial.name.trim()) {
    out.name = now.name.replace(/\s+/g, " ").trim();
    changed = true;
  }
  if (now.privilege !== initial.privilege) {
    out.privilege = now.privilege;
    changed = true;
  }
  if (now.password !== initial.password) {
    out.password = now.password;
    changed = true;
  }
  if (now.card.trim() !== initial.card.trim()) {
    out.card = now.card.trim() === "" ? "" : Number(now.card.trim());
    changed = true;
  }
  if (now.group.trim() !== initial.group.trim()) {
    out.group = now.group.trim();
    changed = true;
  }
  return changed ? out : null;
}

/** A form from a person's details on one device (the password is never known to the page). */
export function formFromPerson(person: PersonRow, deviceId?: number): UserForm {
  const on = person.presence.find((p) => p.deviceId === deviceId) ?? person.presence[0];
  return {
    userId: person.userId,
    name: trimToBytes(on?.name || person.name || ""),
    privilege: on?.privilege ?? 0,
    password: "",
    card: on && on.card ? String(on.card) : "",
    group: on?.group ?? "",
  };
}

/** What to send to put an existing person on another device: what the devices already hold, or the HRMS name. */
export function copyInput(person: PersonRow): UserInput {
  const on = person.presence[0];
  const input: UserInput = { userId: person.userId };
  const name = on?.name || (person.employee ? deviceNameFor(person.employee.name) : person.name);
  if (name) input.name = trimToBytes(name);
  if (on) {
    input.privilege = on.privilege;
    if (on.card) input.card = on.card;
  }
  if (person.employee) input.employeeId = person.employee.id;
  return input;
}

// ── people: what a row says ─────────────────────────────────────────────────────────────────────────────────────────

export const LINK_LABEL: Record<PersonLink, string> = {
  linked: "In HRMS",
  device_only: "Not in HRMS",
  hrms_only: "Not on any device",
  inactive_on_device: "Inactive in HRMS",
  restricted: "Another branch",
};

export const LINK_TONE: Record<PersonLink, Tone> = {
  linked: "good",
  device_only: "warn",
  hrms_only: "info",
  inactive_on_device: "bad",
  restricted: "muted",
};

export const LINK_HINT: Record<PersonLink, string> = {
  linked: "An active employee in the HRMS whose Employee Code is this device ID.",
  device_only: "On a device, but no employee in the HRMS has this ID as their Employee Code.",
  hrms_only: "An active employee who is not on any device yet.",
  inactive_on_device: "Inactive in the HRMS but still on a device: delete them from it.",
  restricted: "An employee of a branch you do not manage.",
};

const DIFFERS_NOUN: Record<"name" | "role" | "card", string> = { name: "names", role: "roles", card: "cards" };

/** "different names and roles": what is not the same on every device a person is on. */
export function describeDiffers(differs: PersonRow["differs"]): string {
  const nouns = differs.map((d) => DIFFERS_NOUN[d]);
  if (nouns.length === 0) return "";
  if (nouns.length === 1) return `different ${nouns[0]}`;
  return `different ${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

// ── people: filters ─────────────────────────────────────────────────────────────────────────────────────────────────

export type PushFilters = {
  search: string;
  devices: number[];
  deviceMode: DeviceMode;
  link: "all" | PersonLink;
  count: "any" | "single" | "multiple";
  role: "any" | "admin" | "user";
  employmentType: "" | "staff" | "production";
  departmentId: number | null;
  differs: boolean;
};

export const NO_FILTERS: PushFilters = {
  search: "",
  devices: [],
  deviceMode: "any",
  link: "all",
  count: "any",
  role: "any",
  employmentType: "",
  departmentId: null,
  differs: false,
};

export const filtersActive = (f: PushFilters): boolean => activeFilterCount(f) > 0;

/** How many separate things are filtered (the search box counts as one). */
export function activeFilterCount(f: PushFilters): number {
  return [
    f.search !== "",
    f.devices.length > 0,
    f.link !== "all",
    f.count !== "any",
    f.role !== "any",
    f.employmentType !== "",
    f.departmentId != null,
    f.differs,
  ].filter(Boolean).length;
}

export function toParams(
  f: PushFilters,
  page: number,
  sort: PeopleParams["sort"],
  dir: PeopleParams["dir"],
): PeopleParams {
  return {
    search: f.search.trim(),
    devices: f.devices,
    deviceMode: f.deviceMode,
    link: f.link,
    count: f.count,
    role: f.role,
    employmentType: f.employmentType,
    departmentId: f.departmentId,
    differs: f.differs,
    sort,
    dir,
    page,
  };
}

const LINKS: PersonLink[] = ["linked", "device_only", "hrms_only", "inactive_on_device", "restricted"];

/** Filters from a URL's query string (a link from the overview, or one pasted from a colleague). Anything unknown is
 *  ignored rather than trusted. */
export function filtersFromSearch(search: string): PushFilters {
  const q = new URLSearchParams(search);
  const f: PushFilters = { ...NO_FILTERS };
  f.search = (q.get("search") ?? "").slice(0, 80);
  const devices = (q.get("devices") ?? q.get("device") ?? "")
    .split(",")
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0);
  f.devices = [...new Set(devices)];
  const mode = q.get("deviceMode");
  if (mode === "all" || mode === "none") f.deviceMode = mode;
  const link = q.get("link") as PersonLink | null;
  if (link && LINKS.includes(link)) f.link = link;
  const count = q.get("count");
  if (count === "single" || count === "multiple") f.count = count;
  const role = q.get("role");
  if (role === "admin" || role === "user") f.role = role;
  const type = q.get("employmentType");
  if (type === "staff" || type === "production") f.employmentType = type;
  const dept = Number(q.get("departmentId"));
  if (Number.isInteger(dept) && dept > 0) f.departmentId = dept;
  f.differs = q.get("differs") === "1";
  return f;
}

/** The query string for a set of filters, so the address always says what the page shows. */
export function filtersToSearch(f: PushFilters): string {
  const q = new URLSearchParams();
  if (f.search) q.set("search", f.search);
  if (f.devices.length) {
    q.set("devices", f.devices.join(","));
    if (f.deviceMode !== "any") q.set("deviceMode", f.deviceMode);
  }
  if (f.link !== "all") q.set("link", f.link);
  if (f.count !== "any") q.set("count", f.count);
  if (f.role !== "any") q.set("role", f.role);
  if (f.employmentType) q.set("employmentType", f.employmentType);
  if (f.departmentId) q.set("departmentId", String(f.departmentId));
  if (f.differs) q.set("differs", "1");
  const text = q.toString();
  return text ? `?${text}` : "";
}

/** One sentence for what the device filter means, for the chip that shows it. */
export function describeDeviceFilter(f: PushFilters, devices: { id: number; name: string }[]): string {
  if (f.devices.length === 0) return "";
  const names = f.devices.map((id) => devices.find((d) => d.id === id)?.name ?? `#${id}`).join(", ");
  if (f.deviceMode === "none") return `Not on ${names}`;
  if (f.deviceMode === "all" && f.devices.length > 1) return `On all of ${names}`;
  return f.devices.length > 1 ? `On any of ${names}` : `On ${names}`;
}

// ── changes: what to tell the person afterwards ─────────────────────────────────────────────────────────────────────

export function summarizePush(r: PushResult): { title: string; tone: Tone; lines: string[] } {
  const { added, updated, failed } = r.summary;
  const lines: string[] = [];
  const skipped = r.results.reduce((n, e) => n + e.skipped.length, 0);
  if (skipped) lines.push(`${skipped} left alone (already there, or not on that device).`);
  const down = r.results.filter((e) => !e.ok);
  for (const e of down) lines.push(`${e.deviceName}: ${e.error}`);
  for (const e of r.results.filter((x) => x.ok))
    for (const f of e.failed) lines.push(`${e.deviceName}, ${f.userId}: ${f.error}`);
  for (const rej of r.rejected) lines.push(`${rej.userId || "(no ID)"}: ${rej.error}`);
  const done = added + updated;
  const verb = r.mode === "create" ? "Added" : "Changed";
  if (failed === 0 && done === 0) return { title: `Nothing was ${verb.toLowerCase()}`, tone: "muted", lines };
  if (failed === 0)
    return { title: `${verb} ${done} ${done === 1 ? "entry" : "entries"} on the devices`, tone: "good", lines };
  return {
    title: done > 0 ? `${verb} ${done}, but ${failed} did not go through` : `Nothing was ${verb.toLowerCase()}`,
    tone: done > 0 ? "warn" : "bad",
    lines,
  };
}

export function summarizeDelete(r: DeleteResult): { title: string; tone: Tone; lines: string[] } {
  const { deleted, failed, madeInactive } = r.summary;
  const lines: string[] = [];
  for (const e of r.results.filter((x) => !x.ok)) lines.push(`${e.deviceName}: ${e.error}`);
  for (const e of r.results.filter((x) => x.ok))
    for (const f of e.failed) lines.push(`${e.deviceName}, ${f.userId}: ${f.error}`);
  for (const rej of r.rejected) lines.push(`${rej.userId}: ${rej.error}`);
  for (const i of r.inactive.filter((x) => !x.changed && x.reason && x.employeeId))
    lines.push(`${i.name || i.userId}: ${i.reason}`);
  const inactive = madeInactive > 0 ? ` ${madeInactive} made Inactive in the HRMS.` : "";
  if (failed === 0 && deleted > 0)
    return { title: `Deleted ${deleted} from the devices.${inactive}`, tone: "good", lines };
  if (deleted > 0)
    return { title: `Deleted ${deleted}, but ${failed} did not go through.${inactive}`, tone: "warn", lines };
  return {
    title: failed > 0 ? "Nothing was deleted" : "There was nothing to delete",
    tone: failed > 0 ? "bad" : "muted",
    lines,
  };
}

/** What deleting these people would do, for the confirmation: the devices touched, who is an employee, who has a
 *  special role. Computed from the page's own rows, so the dialog can state it before anything is sent. */
export function deleteImpact(people: PersonRow[], deviceIds: number[] | null, reachable?: number[] | null) {
  const onDevice = (p: PersonRow) => p.presence.filter((x) => deviceIds == null || deviceIds.includes(x.deviceId));
  // The server makes an employee Inactive only when a device really removed them, so someone whose only chosen
  // devices cannot be reached right now is not one of the people this delete will change in the HRMS.
  const removable = (p: PersonRow) => onDevice(p).some((x) => reachable == null || reachable.includes(x.deviceId));
  const touched = new Set<number>();
  let removals = 0;
  const admins: { person: PersonRow; role: string }[] = [];
  const stayingElsewhere: PersonRow[] = [];
  for (const p of people) {
    const here = onDevice(p);
    removals += here.length;
    here.forEach((x) => touched.add(x.deviceId));
    const worst = here.find((x) => isAdminRole(x.privilege));
    if (worst) admins.push({ person: p, role: worst.role });
    if (here.length < p.presence.length) stayingElsewhere.push(p);
  }
  const employees = people.filter((p) => p.employee && p.employee.status === "active" && !p.restricted && removable(p));
  return { devices: [...touched], removals, admins, stayingElsewhere, employees };
}

// ── Data Fetch ──────────────────────────────────────────────────────────────────────────────────────────────────────

export const FETCH_PRESETS: { value: FetchPreset; label: string; hint?: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 days" },
  { value: "this_month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "custom", label: "Choose dates" },
  {
    value: "all",
    label: "Everything on the device",
    hint: "Reads the whole log. It can take a minute or two per device.",
  },
];

export function rangeProblem(range: FetchRange): string {
  if (range.preset !== "custom") return "";
  if (!range.from || !range.to) return "Choose a start and an end date.";
  if (range.from > range.to) return "The start date is after the end date.";
  return "";
}

export type FetchProgress = { done: number; total: number; percent: number; label: string };

export function fetchProgress(run: FetchRun): FetchProgress {
  const total = run.results.length;
  const done = run.results.filter((r) => r.status === "done" || r.status === "failed").length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  if (run.status !== "running") {
    return { done, total, percent: 100, label: run.status === "done" ? "Finished" : "Failed" };
  }
  const writing = run.results.some((r) => r.status === "processing");
  return { done, total, percent, label: writing ? "Writing to the HRMS" : "Reading the devices" };
}

export const RESULT_STATUS_LABEL: Record<string, string> = {
  reading: "Reading",
  processing: "Processing",
  done: "Done",
  failed: "Failed",
};

export const RESULT_STATUS_TONE: Record<string, Tone> = {
  reading: "busy",
  processing: "busy",
  done: "good",
  failed: "bad",
};

/** "1m 05s" / "12 s": how long a run or a device took. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The one-line headline of a finished run. */
export function describeRun(run: FetchRun): string {
  const s = run.summary;
  if (run.status === "failed") return run.error || "The run failed.";
  if (!s) return "Running…";
  const range = run.rangeLabel.toLowerCase();
  const failed = s.devicesFailed;
  const tail =
    failed > 0 ? ` ${failed} of ${s.devices} ${s.devices === 1 ? "device" : "devices"} could not be read.` : "";
  if (run.mode === "preview") {
    if (s.new === 0) {
      return failed > 0
        ? `Nothing new for ${range} on the devices that could be read.${tail}`
        : `Nothing new for ${range}: the HRMS already has every punch the devices hold.`;
    }
    return `${s.new.toLocaleString("en-IN")} new ${s.new === 1 ? "punch" : "punches"} for ${range}: an update would add them.${tail}`;
  }
  if (s.created === 0) {
    return failed > 0
      ? `Nothing to add for ${range} from the devices that could be read.${tail}`
      : `Nothing to add for ${range}: the HRMS already had every punch.`;
  }
  return `Added ${s.created.toLocaleString("en-IN")} ${s.created === 1 ? "punch" : "punches"} for ${range}.${tail}`;
}

/** Whether a device is worth selecting by default for a fetch or a push: switched on and reachable. */
export const isUsable = (d: DeviceControlDevice): boolean => d.isActive && d.connection.state === "connected";

/** A device this server will not reach right now: switched off, or the last check failed. One that has not been
 *  checked yet is not counted here: the server simply tries it. */
export const isUnreachable = (d: DeviceControlDevice): boolean =>
  !d.isActive || d.connection.state === "disconnected" || d.connection.state === "disabled";

/** The longest user ID every one of these devices takes (9 unless a device says it is shorter). */
export const pinWidthFor = (devices: DeviceControlDevice[]): number =>
  Math.min(DEFAULT_PIN_WIDTH, ...devices.map((d) => d.capacity?.pinWidth ?? DEFAULT_PIN_WIDTH));

/** A date as YYYY-MM-DD in this computer's own time zone. (toISOString gives the UTC date: a day behind in the
 *  early hours in India, which is when a night shift is being fetched.) */
export function localDate(at: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

// ── where things are ────────────────────────────────────────────────────────────────────────────────────────────────

export const DEVICE_CONTROL_PATH = "/hr/attendance/DeviceControl";

/** The address of Data Push on a view (the overview's cards and device buttons open it this way). */
export const pushLink = (patch: Partial<PushFilters>): string =>
  `${DEVICE_CONTROL_PATH}/push${filtersToSearch({ ...NO_FILTERS, ...patch })}`;

/** The address of Data Fetch, optionally with one device already ticked. */
export const fetchLink = (deviceId?: number): string =>
  `${DEVICE_CONTROL_PATH}/fetch${deviceId ? `?device=${deviceId}` : ""}`;

export type DeviceControlTab = "overview" | "fetch" | "push" | "connectors";

export function tabFromPath(path: string): DeviceControlTab {
  if (path.endsWith("/fetch")) return "fetch";
  if (path.endsWith("/push")) return "push";
  if (path.endsWith("/connectors")) return "connectors";
  return "overview";
}

export const pathForTab = (tab: DeviceControlTab): string =>
  tab === "overview" ? DEVICE_CONTROL_PATH : `${DEVICE_CONTROL_PATH}/${tab}`;

// ── Site Connectors ─────────────────────────────────────────────────────────────────────────────────────────────────────

export const CONNECTOR_STATE_LABEL: Record<ConnectorState, string> = {
  online: "Online",
  offline: "Offline",
  unpaired: "Waiting to be paired",
  off: "Switched off",
};

export const CONNECTOR_STATE_TONE: Record<ConnectorState, Tone> = {
  online: "good",
  offline: "bad",
  unpaired: "warn",
  off: "muted",
};

/** One line on what a connector last did when it read a device's punches on its own. */
export function describeConnectorSync(sync: ConnectorSync | null | undefined): string {
  if (!sync || !sync.at) return "Punches not read by the connector yet.";
  if (sync.ok === false) return `Could not read punches: ${sync.error || "the device did not answer"}`;
  const when = relativeTime(sync.at);
  if (sync.skipped) return `Punches: nothing new on the device (${when}).`;
  const read = sync.read ?? 0;
  const created = sync.created ?? 0;
  return `Punches: ${read.toLocaleString("en-IN")} read, ${created.toLocaleString("en-IN")} new in the HRMS (${when}).`;
}

/** "2 h 5 min", "3 days": how long the connector has been running. */
export function formatUptime(seconds: number): string {
  if (seconds < 90) return `${Math.max(0, Math.round(seconds))} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

/** What is wrong with the connector's settings form, or "" when it can be saved. */
export function validateConnectorSettings(form: { name: string; minutes: string; days: string }): string {
  if (!form.name.trim()) return "Give the connector a name.";
  if (form.name.trim().length > 80) return "The name is at most 80 characters.";
  if (!/^\d{1,4}$/.test(form.minutes.trim()) || Number(form.minutes) > 1440) {
    return "Reading punches every 0 (never) to 1440 minutes.";
  }
  if (!/^\d{1,2}$/.test(form.days.trim()) || Number(form.days) < 1 || Number(form.days) > 31) {
    return "Each reading looks back 1 to 31 days.";
  }
  return "";
}
