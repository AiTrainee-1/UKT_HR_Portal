import type { ReactNode } from "react";

/**
 * Keeps a tab's SaveBar in view at the bottom of the screen: a tab here is a long page of explained settings, and the
 * Save button should not be a scroll away from the field just changed. A raised glass dock (see settings-skin.css).
 */
export function SaveDock({ children }: { children: ReactNode }) {
  return (
    <div className="settings-dock sticky bottom-3 z-10 rounded-xl p-1.5" data-testid="save-footer">
      {children}
    </div>
  );
}
