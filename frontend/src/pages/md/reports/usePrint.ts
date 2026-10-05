// Printing a report from the browser: the MD's "Print" button, and Ctrl+P, both print a clean sheet of the report (all
// rows, the filters it ran with) instead of the screen. The sheet is only built while the browser is printing, so a
// report with thousands of rows does not sit in the page the rest of the time.

import { useCallback, useEffect, useState } from "react";
import { flushSync } from "react-dom";

export function usePrint(): { printing: boolean; print: () => void } {
  const [printing, setPrinting] = useState(false);

  useEffect(() => {
    // Ctrl+P (and window.print) tell the page first: build the sheet right now, before the browser lays the page out.
    const before = () => flushSync(() => setPrinting(true));
    const after = () => setPrinting(false);
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  const print = useCallback(() => {
    // Not every browser fires beforeprint for window.print(), and a sheet that is not there prints a blank page.
    flushSync(() => setPrinting(true));
    window.print();
  }, []);

  return { printing, print };
}
