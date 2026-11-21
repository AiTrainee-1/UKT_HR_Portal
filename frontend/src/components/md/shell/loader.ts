import { lazy, type ComponentType, type ReactNode } from "react";

// The MD shell (sidebar, top bar, frame, and the MD skin's stylesheet) is its own chunk: components/md/MdShell.tsx.
// MdLayout (what every MD page and the HR layout import) is only a door to it, so the HR portal, which imports MdLayout
// through HrLayout for the MD's copies of its pages, never downloads the MD shell or the MD skin.
//
// The shell is fetched as early as it can be: when MdLayout's module is evaluated on an /md address, when the assistant
// mounts for the MD (AssistantHost), and statically by the Dashboard (the page the MD lands on). Once it is in, MdLayout
// draws it at once (no Suspense round), because the shell registers itself here when its module runs.

export type MdShellComponent = ComponentType<{ children: ReactNode }>;

let loaded: MdShellComponent | null = null;
let pending: Promise<{ default: MdShellComponent }> | null = null;

/** Called by MdShell.tsx when its module runs (however it was imported). */
export function registerMdShell(shell: MdShellComponent): void {
  loaded = shell;
}

/** The shell when its module has already run, else null. */
export function loadedMdShell(): MdShellComponent | null {
  return loaded;
}

/** Fetch the shell's chunk and stylesheet (once; a failed fetch may be tried again). */
export function preloadMdShell(): Promise<{ default: MdShellComponent }> {
  pending ??= import("../MdShell").then(
    (module) => {
      loaded = module.default;
      return module;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

export const LazyMdShell = lazy(preloadMdShell);

/** "/md" and "/md/..." under the app's base path. */
export function isMdPath(pathname: string, base: string = import.meta.env.BASE_URL ?? "/"): boolean {
  const root = base.endsWith("/") ? base : `${base}/`;
  const path = pathname.toLowerCase();
  return path === `${root}md` || path.startsWith(`${root}md/`);
}
