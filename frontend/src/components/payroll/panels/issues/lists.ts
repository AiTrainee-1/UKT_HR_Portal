// Small list helpers the Issues, Skipped Employees and Rules panels share.

/** Natural, case-insensitive text order ("Unit 2" before "Unit 10"). */
export const byText = (a: string, b: string): number =>
  a.localeCompare(b, "en", { sensitivity: "base", numeric: true });

/** One page of a plain list (the Skipped Employees and Rules tables). */
export type RowPage<T> = {
  /** The page shown: the one asked for, kept inside 1..totalPages. */
  page: number;
  totalPages: number;
  total: number;
  /** The first and last row on the page, 1-based (0 and 0 for an empty list). */
  from: number;
  to: number;
  rows: T[];
};

export function paginateRows<T>(rows: T[], page: number, size: number): RowPage<T> {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), totalPages);
  const start = (current - 1) * size;
  const end = Math.min(start + size, total);
  return { page: current, totalPages, total, from: total === 0 ? 0 : start + 1, to: end, rows: rows.slice(start, end) };
}

/** The departments that occur (sorted), and whether some items belong to people with none. */
export function departmentsOf(items: { department: string | null }[]): { names: string[]; hasNone: boolean } {
  const names = new Set<string>();
  let hasNone = false;
  for (const item of items) {
    if (item.department) names.add(item.department);
    else hasNone = true;
  }
  return { names: [...names].sort(byText), hasNone };
}

/** The `dept` filter value that picks the items of people with no department. */
export const NO_DEPARTMENT = "__none__";

/**
 * An address of this app (a Settings deep link the server sent) that is safe to hand to the router: it starts with one
 * slash. Anything else ("javascript:...", "https://elsewhere", "//elsewhere") is not followed.
 */
export function appPath(path: string | null | undefined): string | null {
  if (!path || !/^\/(?!\/)/.test(path)) return null;
  for (let i = 0; i < path.length; i++) if (path.charCodeAt(i) < 32) return null; // a line break or other control character
  return path;
}

/**
 * What a failed request says, for the line under "Could not load ...". An API error is "HTTP 403 Forbidden: <message>":
 * the server's own words when it gave any, a plain sentence for a permission error, else the status. Anything that is not
 * an API error (the network is down, the page was left) has nothing to add, and the usual "check your connection" stands.
 */
export function errorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return undefined;
  const withMessage = /^HTTP (\d{3})(?: [^:]*)?: (.+)$/s.exec(error.message);
  if (withMessage) return withMessage[2].trim() || undefined;
  const bare = /^HTTP (\d{3})\b/.exec(error.message);
  if (!bare) return undefined;
  return bare[1] === "403" ? "You do not have permission to view this." : `The server answered: ${error.message}.`;
}
