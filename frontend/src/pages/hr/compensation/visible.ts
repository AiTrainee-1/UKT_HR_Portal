import { canViewRoute, useAuth } from "@/contexts/AuthContext";
import { moduleForPath } from "@/lib/permission-modules";
import {
  COMPENSATION_PAGES,
  defaultNested,
  nestedOf,
  pagePath,
  subPath,
  type CompensationPageKey,
  type Subtab,
} from "./routes";

// The parts of Compensation a role may see (Account Management -> Roles & Permissions: compensation.ot.type2.waiting, ...).
// Every page, subtab and nested subtab has an address of its own, so "may see" is the route guard's own rule for that
// address (App.tsx: canViewRoute of the address's key): a strip never offers an address the guard would send home, and every
// landing (the bare page, a subtab with no section, an old `?tab=` link) goes to the first one the role may open. A key
// with no setting of its own follows its parent, so a role that never set one sees exactly what it saw before.

/** May the signed-in login open this Compensation address? */
export type CanOpen = (path: string) => boolean;

export function useCanOpen(): CanOpen {
  const { user } = useAuth();
  return (path: string) => canViewRoute(user, path.split("?")[0], moduleForPath(path.split("?")[0]));
}

/** The subtabs of a page the login may open, in order. */
export const openSubs = <T extends string>(canOpen: CanOpen, key: CompensationPageKey, subs: readonly T[]): T[] =>
  subs.filter((s) => canOpen(subPath(key, s)));

/** The nested subtabs of a subtab the login may open, in order. */
export const openNested = (canOpen: CanOpen, key: CompensationPageKey, sub: string): Subtab[] =>
  nestedOf(key, sub).filter((n) => canOpen(subPath(key, sub, "", n.value)));

/** Keeps the items of a nested strip the login may open. */
export const keepOpenNested = <T extends { value: string }>(
  canOpen: CanOpen,
  key: CompensationPageKey,
  sub: string,
  items: readonly T[],
): T[] => items.filter((i) => canOpen(subPath(key, sub, "", i.value)));

/** The nested subtab a subtab opens on: its default one (defaultNested) when the login may open it, else the first it may. */
export function openDefaultNested(
  canOpen: CanOpen,
  key: CompensationPageKey,
  sub: string,
  search = "",
): string | undefined {
  const open = openNested(canOpen, key, sub).map((n) => n.value);
  const wanted = defaultNested(key, sub, search);
  return wanted !== undefined && open.includes(wanted) ? wanted : open[0];
}

/**
 * Where an address lands for this login: the address itself when it may open it, else the nearest part above it that it may
 * open (a page then lands on its first open subtab), else the first open page. The query string is kept.
 */
export function openTarget(canOpen: CanOpen, target: string): string {
  const [path, query = ""] = target.split("?");
  const withQuery = (p: string) => (query ? `${p}?${query}` : p);
  const segments = path.split("/");
  // "/hr/compensation/<page>/<sub>/<nested>" -> ["", "hr", "compensation", page, sub, nested]: down to the page
  for (let n = segments.length; n >= 4; n--) {
    const p = segments.slice(0, n).join("/");
    if (canOpen(p)) return withQuery(p);
  }
  const page = COMPENSATION_PAGES.find((pg) => canOpen(pagePath(pg.key)));
  return page ? withQuery(pagePath(page.key)) : target;
}
