// The look of a printed statement sheet, as plain CSS with its own class names (stmt-*): it does not lean on Tailwind or on
// the page it sits in, so the sheet looks the same in the "Pages" preview and on paper, in any theme. The preview and the
// print root both put this stylesheet beside the sheets.

/** Sizes are in millimetres: an A4 landscape sheet with an 8 mm margin leaves a 281 x 194 mm page. */
export const PAPER_CSS = `
.stmt-sheet{box-sizing:border-box;position:relative;width:297mm;height:210mm;padding:8mm;background:#fff;color:#0f172a;font-family:Helvetica,Arial,"Liberation Sans",sans-serif;line-height:1.2;overflow:hidden;text-align:left;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.stmt-sheet *{box-sizing:border-box}
.stmt-sheet-preview{box-shadow:0 1px 2px rgba(15,23,42,.14),0 16px 36px -12px rgba(15,23,42,.32)}
.stmt-head{height:12mm;margin:0 0 3.2mm;text-align:center}
.stmt-company{font-size:12pt;font-weight:700;line-height:1.25}
.stmt-title{margin-top:1.2mm;font-size:9pt;line-height:1.25}
.stmt-table{margin:0;border-collapse:collapse;table-layout:fixed;border:.3mm solid #475569}
.stmt-table th,.stmt-table td{padding:0 .8mm;overflow:hidden;border:0;vertical-align:middle;white-space:nowrap;font-weight:400;line-height:1.1}
.stmt-bands th{height:4.4mm;font-size:.8em;font-weight:700;letter-spacing:.04em;text-align:center;color:#334155}
.stmt-band-identity{background:#e2e8f0}
.stmt-band-attendance{background:#dbeafe}
.stmt-band-earnings{background:#d1fae5}
.stmt-band-deductions{background:#ffe4e6}
.stmt-band-result{background:#e0e7ff}
.stmt-kind-production .stmt-band-result{background:#fef3c7}
.stmt-labels th{height:8.2mm;border-bottom:.3mm solid #475569;background:#f1f5f9;font-weight:700;line-height:1.15;text-align:center;white-space:normal}
.stmt-table tbody td{height:8.5mm;border-bottom:.1mm solid #cbd5e1}
.stmt-l{text-align:left}
.stmt-r{text-align:right}
.stmt-ctr{text-align:center}
.stmt-zero{color:#94a3b8}
.stmt-clip2{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;white-space:normal;line-height:1.1;text-align:left}
.stmt-bandline td{padding-left:1.4mm;background:#e8eef7;font-size:1.05em;font-weight:700}
.stmt-count{margin-left:2.5mm;color:#475569;font-size:.92em;font-weight:400}
.stmt-sub td{border-top:.15mm solid #475569;background:#eef2f9;font-weight:700}
.stmt-total td{border-bottom:0;background:#3730a3;color:#fff;font-weight:700}
.stmt-kind-production .stmt-total td{background:#92400e}
.stmt-sub .stmt-label,.stmt-total .stmt-label{padding-left:1.4mm;text-align:left}
.stmt-notes{margin:2.5mm 0 0;font-size:6pt;line-height:1.4;color:#475569}
.stmt-notes b{display:block;font-size:6.5pt;color:#0f172a}
.stmt-foot{position:absolute;left:8mm;right:8mm;bottom:8mm;display:flex;justify-content:space-between;font-size:7pt;color:#475569}
`.trim();

/** A sheet as it is on screen in the "Pages" preview: the whole A4 sheet, in pixels at 96 dpi. */
export const SHEET_PX = { width: Math.round((297 / 25.4) * 96), height: Math.round((210 / 25.4) * 96) } as const;
