/**
 * What "Print this page" prints: the page's sections flowing across paper pages, without the app around them. It is
 * rendered inside the page (a <style> that exists only while the page is open), so it can never change how another
 * page prints. The sidebar and the phone's top bar belong to the HR shell, which this page does not own, so they are
 * hidden by what they are; everything on the page itself hides with `print:hidden`.
 */
export const PRINT_CSS = `
@media print {
  @page { size: A4; margin: 10mm; }
  html, body, #root { height: auto !important; overflow: visible !important; background: #ffffff !important; }
  aside, header.lg\\:hidden, [data-radix-toast-viewport] { display: none !important; }
  .pd-root .clay-card { box-shadow: none !important; border: 1px solid #cbd5e1 !important; background: #ffffff !important; }
  .pd-root li, .pd-root tr { break-inside: avoid; page-break-inside: avoid; }
  .pd-root h3, .pd-root h4 { break-after: avoid; page-break-after: avoid; }
  .pd-root a { color: inherit !important; text-decoration: none !important; }
  .pd-root [data-testid="pd-calendar"] > div { overflow: visible !important; }
}
`;
