import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { SalaryStatement } from "@/lib/api-client/custom-hooks";
import { StatementSheets } from "./StatementSheets";
import { DEFAULT_ROWS_PER_PAGE } from "./statement-model";

// Printing the Salary Statement with the browser's own print dialog. The same A4 landscape sheets as the "Pages" preview
// are drawn into a temporary container on the page, everything else on the page is hidden for printing, the dialog is
// opened, and the container goes away again when it closes.

export const PRINT_ROOT_ID = "statement-print-root";
export const PRINT_STYLE_ID = "statement-print-style";

/**
 * If neither `afterprint` nor the end of `window.print()` tells us the dialog is gone (some mobile browsers fire nothing),
 * the container is removed after this long. It is generous on purpose: where the print preview is live (Firefox) it is
 * built from the page, and removing the sheets early would blank it.
 */
export const PRINT_CLEANUP_MS = 10 * 60 * 1000;

export const PRINT_CSS = `
@page { size: A4 landscape; margin: 8mm }
#${PRINT_ROOT_ID} { position: fixed; left: -10000px; top: 0; width: 0; height: 0; overflow: hidden }
@media print {
  html, body { margin: 0 !important; padding: 0 !important; height: auto !important; overflow: visible !important; background: #fff !important }
  body > *:not(#${PRINT_ROOT_ID}) { display: none !important }
  #${PRINT_ROOT_ID} { position: static !important; width: auto !important; height: auto !important; overflow: visible !important }
  #${PRINT_ROOT_ID} .stmt-sheet { width: 281mm; height: 193mm; padding: 0; box-shadow: none; break-after: page; page-break-after: always }
  #${PRINT_ROOT_ID} .stmt-sheet:last-child { break-after: auto; page-break-after: auto }
  #${PRINT_ROOT_ID} .stmt-foot { left: 0; right: 0; bottom: 0 }
}
`.trim();

let teardown: (() => void) | null = null;

/** Removes the print container and its stylesheet (if a print is still on screen from before). */
export function clearPrint(): void {
  teardown?.();
}

/**
 * Prints the statement. Throws (a readable message) where there is no print dialog; the export menu shows it as a toast.
 * `rowsPerPage` is the number of table lines a sheet holds (the default is the printed statement's ~15 employees a page).
 */
export function printStatement(statement: SalaryStatement, options: { rowsPerPage?: number } = {}): void {
  if (typeof window === "undefined" || typeof window.print !== "function") {
    throw new Error("Printing is not available in this browser. Use the PDF export and print that instead.");
  }
  clearPrint();

  const style = document.createElement("style");
  style.id = PRINT_STYLE_ID;
  style.textContent = PRINT_CSS;
  const host = document.createElement("div");
  host.id = PRINT_ROOT_ID;
  host.setAttribute("aria-hidden", "true");
  document.head.appendChild(style);
  document.body.appendChild(host);

  const root = createRoot(host);
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = () => {
    if (finished) return;
    finished = true;
    window.removeEventListener("afterprint", finish);
    if (timer !== undefined) clearTimeout(timer);
    root.unmount();
    host.remove();
    style.remove();
    if (teardown === finish) teardown = null;
  };
  teardown = finish;

  try {
    // The sheets must be in the page before the dialog opens: render them synchronously.
    flushSync(() =>
      root.render(
        createElement(StatementSheets, { statement, rowsPerPage: options.rowsPerPage ?? DEFAULT_ROWS_PER_PAGE }),
      ),
    );
    window.addEventListener("afterprint", finish);
    timer = setTimeout(finish, PRINT_CLEANUP_MS);
    window.print();
  } catch (err) {
    finish();
    throw err;
  }
}
