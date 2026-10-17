import { hrToMd } from "@/lib/md/embed";
import { mdPageForPath } from "../md-nav";

/** MD pages that are not copies of an HR page: the dashboard is the MD's own (pages/md/home). */
const OWN_PAGES: ReadonlySet<string> = new Set(["dashboard"]);

/** Pages whose tabs are path segments below the page (/md/outpass-visitors/outpass/overview/passes): such an address is still
 *  the page itself, the page just redirects its bare address to its first tab. */
const TAB_PATH_PAGES: ReadonlySet<string> = new Set(["outpass", "tea-break"]);

/** The page whose own address this is. A deeper address (an employee's record, a form) is not the page itself and gets no
 *  Insights: the MD copy of it is the HR page alone. A tab of a page that keeps its tabs in the path is the page itself. */
export function pageAt(internalPath: string) {
  const clean = internalPath.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  const asMd = hrToMd(clean);
  const page = mdPageForPath(asMd);
  if (!page) return undefined;
  const own = page.path.toLowerCase();
  if (own !== asMd && !(TAB_PATH_PAGES.has(page.id) && asMd.startsWith(`${own}/`))) return undefined;
  // pages that are the MD's own design, not a copy of an HR page, have no Operations/Insights frame
  return OWN_PAGES.has(page.id) ? undefined : page;
}
