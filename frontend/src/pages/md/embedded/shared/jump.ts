import { useCallback } from "react";
import { useLocation } from "wouter";
import { pageAt } from "@/components/md/embedded/pageAt";

// Drill-down from an Insights tab to the HR page itself (2026-11-21): "show me these people / requests on the page".
//
// The frame (components/md/embedded/MdEmbeddedFrame) remembers each page's tab in sessionStorage ("md.frame.tab:<page>")
// and reads it again when the page changes; so a jump to ANOTHER page sets that page's tab to Operations before going. A
// jump within the SAME page cannot reach the frame's state, so it presses the frame's own Operations tab once the address
// has changed. An employee's record (/md/employees/<id>) has no frame at all: the record is shown as it is.

const TAB_KEY = "md.frame.tab:";

function showOperations(pageId: string) {
  try {
    sessionStorage.setItem(TAB_KEY + pageId, "operations");
  } catch {
    /* private mode: the page opens on whatever tab it opens on */
  }
}

/** The page id the frame shows now (from its data-page), or null when there is no frame on screen. */
function framePage(): string | null {
  return document.querySelector<HTMLElement>('[data-testid="md-frame"]')?.dataset.page ?? null;
}

/** A function that opens an MD address (/md/requests?kind=leave, /md/employees/5) on its Operations view. */
export function useOpenInPage() {
  const [, navigate] = useLocation();
  return useCallback(
    (mdAddress: string) => {
      const target = pageAt(mdAddress);
      const here = framePage();
      if (target) showOperations(target.id);
      navigate(mdAddress);
      if (target && here === target.id) {
        // same page: the frame keeps its state, so switch its tab the way the MD would
        window.setTimeout(() => {
          document
            .querySelector<HTMLButtonElement>('[data-testid="md-frame"] [data-testid="md-tab-operations"]')
            ?.click();
        }, 0);
      }
    },
    [navigate],
  );
}

/** The MD address of an employee's record. */
export const employeeAddress = (employeeId: number | string) => `/md/employees/${employeeId}`;
