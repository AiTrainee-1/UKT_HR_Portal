import { Suspense, useState, type ReactNode } from "react";
import ShellFallback from "./shell/ShellFallback";
import { isMdPath, LazyMdShell, loadedMdShell, preloadMdShell } from "./shell/loader";

// Every MD page (and the HR layout, for the MD's copies of the HR pages) wraps itself in MdLayout. The shell itself, with
// the MD skin's stylesheet, is a chunk of its own (MdShell.tsx, see shell/loader.ts): this module stays tiny so that the
// HR portal, which imports it through HrLayout, never downloads the MD shell or the MD skin.

// On an MD address, start fetching the shell the moment this module runs (with the page's chunk), not when the page first
// renders. (The MD page tests' harness, pages/md/testing/renderMdPage.tsx, waits for it before rendering.)
if (typeof window !== "undefined" && isMdPath(window.location.pathname)) {
  preloadMdShell().catch(() => {
    // offline or a stale deploy: MdLayout's own load below tries again and its error reaches the error boundary
  });
}

/** The shell of every MD page: sidebar, mobile bar, scrolling content that makes room for the assistant panel. */
export default function MdLayout({ children }: { children: ReactNode }) {
  // decided once per mount: switching from the lazy door to the loaded shell later would remount the page
  const [Shell] = useState(loadedMdShell);
  if (Shell) return <Shell>{children}</Shell>;
  return (
    <Suspense fallback={<ShellFallback />}>
      <LazyMdShell>{children}</LazyMdShell>
    </Suspense>
  );
}
