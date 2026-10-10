import { Suspense, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useLocation } from "wouter";
import { Eye } from "lucide-react";
import { useAuth, isRouteViewOnly } from "@/contexts/AuthContext";
import { hrToMd } from "@/lib/md/embed";
import { usePublishAssistantContext } from "@/lib/md/assistant-store";
import { moduleForPath } from "@/lib/permission-modules";
import { lockIconOnlyDeletes, lockMutatingControls } from "@/lib/view-only-lock";
import { LiveChip, ModeTabs, UpdatedRefresh, type FrameTab } from "../kit/MdHeaderParts";
import MdPageHeader from "../kit/MdPageHeader";
import { SkeletonBlock } from "../kit/states";
import { mdPageForPath } from "../md-nav";
import { insightsFor } from "./registry";
import { useTitleMark } from "./titleMark";
import { useHeaderAdoption } from "./useHeaderAdoption";

export type { FrameTab };

/** MD pages that are not copies of an HR page: the dashboard is the MD's own (pages/md/home). */
const OWN_PAGES: ReadonlySet<string> = new Set(["dashboard"]);

const STORAGE_PREFIX = "md.frame.tab:";

function readTab(pageId: string): FrameTab {
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + pageId) === "insights" ? "insights" : "operations";
  } catch {
    return "operations";
  }
}

function rememberTab(pageId: string, tab: FrameTab) {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + pageId, tab);
  } catch {
    /* private mode: the choice just is not remembered */
  }
}

/** The page whose own address this is. A deeper address (an employee's record, a form) is not the page itself and gets no
 *  Insights: the MD copy of it is the HR page alone. */
function pageAt(internalPath: string) {
  const clean = internalPath.split(/[?#]/)[0].replace(/\/+$/, "").toLowerCase();
  const asMd = hrToMd(clean);
  const page = mdPageForPath(asMd);
  if (!page || page.path.toLowerCase() !== asMd) return undefined;
  // pages that are the MD's own design, not a copy of an HR page, have no Operations/Insights frame
  return OWN_PAGES.has(page.id) ? undefined : page;
}

/**
 * Around every MD copy of an HR page (see lib/md/embed.ts): the page's headline figures and exceptions on top, a switch
 * between the page itself ("Operations": the HR page, untouched, with all its features) and "Insights & AI" (the page's
 * analytics, comparisons and explanations), the HR layout's own conveniences (the view-only lock) and the title row that
 * every MD page shares: the Live chip and the switch beside the page's title, Updated / Refresh at the far right.
 *
 * That title row is the HR page's own, with the MD's pieces slotted in (embedded/headerRow.ts); the Insights tab, and a
 * page whose title row cannot be used, get the same row drawn by the frame (kit/MdPageHeader).
 *
 * The HR page stays mounted when the Insights tab is open, so what was typed or filtered on it is still there on return.
 */
export default function MdEmbeddedFrame({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  const { user } = useAuth();
  const page = pageAt(location);

  const [tab, setTab] = useState<FrameTab>(() => (page ? readTab(page.id) : "operations"));
  const pageId = page?.id;
  useEffect(() => {
    if (pageId) setTab(readTab(pageId));
  }, [pageId]);

  const select = (next: FrameTab) => {
    setTab(next);
    if (pageId) rememberTab(pageId, next);
  };

  const [ops, setOps] = useState<HTMLDivElement | null>(null);
  const adopted = useHeaderAdoption(ops);
  // a page with no title row of its own (a form, a record): its first heading is still its title
  const [plain, setPlain] = useState<HTMLDivElement | null>(null);
  useTitleMark(plain);

  // what the assistant is told the MD is looking at: the HR page here; the Insights tab publishes its own, richer, context
  usePublishAssistantContext(page && tab === "operations" ? { page: page.id, title: page.title } : null);

  // the HR layout's view-only lock, for an MD whose copy of a page has been made read-only (permission_registry.MD_HR_GRANTS)
  const moduleKey = moduleForPath(location);
  const isViewOnly = isRouteViewOnly(user, location, moduleKey);
  useEffect(() => {
    if (!isViewOnly) return;
    const relock = () => {
      lockMutatingControls(document.body);
      lockIconOnlyDeletes(document.body);
    };
    relock();
    const observer = new MutationObserver(relock);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [isViewOnly, location]);

  // a sand panel with an eye: the MD can look at everything here but not change it
  const viewOnlyBanner = isViewOnly && (
    <div
      className="md-panel-sand mb-4 flex items-center gap-3 px-4 py-2.5 text-[13px] font-semibold leading-snug text-md-warning-800"
      data-testid="md-view-only"
    >
      <span className="md-shell-banner-tile">
        <Eye size={15} strokeWidth={2.2} />
      </span>
      <span className="min-w-0">
        {page?.id === "leave" || page?.id === "requests"
          ? "View only: look at every request and holiday here; HR and the Department Heads decide requests."
          : "View only: browse and inspect freely, changes can't be saved."}
      </span>
    </div>
  );

  if (!page) {
    return (
      <>
        {viewOnlyBanner}
        <div ref={setPlain}>{children}</div>
      </>
    );
  }

  const { Strip, Body } = insightsFor(page.id);
  const strip = (
    <Suspense fallback={null}>
      <Strip />
    </Suspense>
  );

  // The page's own title row carries the switch while the page is showing; otherwise the frame draws the row itself.
  const inRow = tab === "operations" ? adopted : null;
  const tabs = (className?: string) => (
    <ModeTabs active={tab} onSelect={select} label={`${page.title} views`} className={className} />
  );

  return (
    <div
      data-testid="md-frame"
      data-page={page.id}
      // the HR pages' titles differ in size and colour from page to page, and their subtitles in length: one look for all
      className="[&_[data-md-subtitle]]:max-w-[34rem] [&_[data-md-subtitle]]:text-xs [&_[data-md-subtitle]]:font-medium [&_[data-md-subtitle]]:text-md-ink-soft [&_[data-md-title]]:text-[22px] [&_[data-md-title]]:font-black [&_[data-md-title]]:leading-7 [&_[data-md-title]]:tracking-tight [&_[data-md-title]]:text-md-ink"
    >
      {viewOnlyBanner}

      {!inRow && (
        <div className="mb-4">
          <MdPageHeader title={adopted?.title || page.title} subtitle={adopted?.subtitle} tabs={tabs()} />
        </div>
      )}
      {inRow && (
        <>
          {createPortal(<LiveChip />, inRow.adoption.live)}
          {createPortal(<div className="ml-3 mr-auto self-start">{tabs()}</div>, inRow.adoption.mid)}
          {createPortal(<UpdatedRefresh className="ml-auto" />, inRow.adoption.end)}
          {createPortal(strip, inRow.adoption.below)}
        </>
      )}
      {!inRow && strip}

      <div hidden={tab !== "operations"} data-testid="md-frame-operations" ref={setOps}>
        {children}
      </div>
      {tab === "insights" && (
        <div data-testid="md-frame-insights">
          <Suspense
            fallback={
              <div className="md-card p-6">
                <SkeletonBlock rows={4} className="min-h-[200px]" />
              </div>
            }
          >
            <Body />
          </Suspense>
        </div>
      )}
    </div>
  );
}
