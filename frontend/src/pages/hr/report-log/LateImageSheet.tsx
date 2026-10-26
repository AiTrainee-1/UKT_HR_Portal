import { forwardRef, type CSSProperties } from "react";
import { longDate } from "../leave/logic";
import type { LateReportInput } from "./late-excel";
import {
  LATE_COLUMNS,
  LATE_REPORT_TITLE,
  SEVERITY_BANDS,
  SEVERITY_COLORS,
  cellText,
  generatedStamp,
  severityOf,
} from "./late";

// The Daily Late Report as a picture (the PNG download): the same report as the table on the page, laid out as a clean modern
// sheet: company block, title and date, the seven columns, a colour step per severity with its small key, and a footer. No
// summary line, no explanation and no totals row (the page has those). It is the OFF-SCREEN element exportElementToFile (lib/exportUtils) turns into the image, so, like the leave list's
// sheet, it is drawn with inline styles that html2canvas reads straight, never depending on the app's theme. The picture is as
// tall as the list is long, every row fully legible.

const FONT = "Inter, 'Segoe UI', Arial, Helvetica, sans-serif";
const INK = "#0f172a";
const MUTED = "#64748b";
const RULE = "#e2e8f0";
const HEAD = "#1e293b";
const ACCENT = "#312e81";

/** The width of the picture: the seven columns (4 px to the millimetre of the PDF) plus the page padding. */
export const IMAGE_PADDING = 28;
export const IMAGE_WIDTH = LATE_COLUMNS.reduce((sum, c) => sum + c.mm * 4, 0) + 2 * IMAGE_PADDING;

const cell = (extra: CSSProperties = {}): CSSProperties => ({
  padding: "9px 10px",
  fontSize: 14,
  lineHeight: "20px",
  color: INK,
  borderBottom: `1px solid ${RULE}`,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  ...extra,
});

const LateImageSheet = forwardRef<HTMLDivElement, { input: LateReportInput; testId?: string }>(function LateImageSheet(
  { input, testId },
  ref,
) {
  const now = input.now ?? new Date();
  return (
    <div
      ref={ref}
      data-testid={testId}
      style={{
        width: IMAGE_WIDTH,
        boxSizing: "border-box",
        padding: IMAGE_PADDING,
        background: "#ffffff",
        fontFamily: FONT,
        color: INK,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          {input.logoDataUrl && (
            <img src={input.logoDataUrl} alt="" style={{ height: 52, width: 52, objectFit: "contain" }} />
          )}
          <div>
            <div style={{ fontSize: 20, fontWeight: 700 }}>{input.company}</div>
            <div style={{ fontSize: 13, color: MUTED }}>{input.branchLabel}</div>
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 28, fontWeight: 800, color: ACCENT, lineHeight: "32px" }}>{LATE_REPORT_TITLE}</div>
          <div style={{ fontSize: 15, color: INK, marginTop: 2 }}>{longDate(input.date)}</div>
        </div>
      </div>

      <div style={{ height: 1, background: RULE, margin: "16px 0 14px" }} />

      {input.filter && (
        <div style={{ fontSize: 12, color: MUTED }} data-testid={testId ? `${testId}-filter` : undefined}>
          {input.filter}
        </div>
      )}

      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          tableLayout: "fixed",
          marginTop: 14,
          border: `1px solid ${RULE}`,
          fontFamily: FONT,
        }}
      >
        <colgroup>
          {LATE_COLUMNS.map((c) => (
            <col key={c.key} style={{ width: c.mm * 4 }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            {LATE_COLUMNS.map((c) => (
              <th
                key={c.key}
                style={cell({
                  background: HEAD,
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: 13,
                  textAlign: c.align,
                  whiteSpace: "normal",
                  lineHeight: "17px",
                  borderBottom: `1px solid ${HEAD}`,
                })}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {input.entries.map((entry, i) => (
            <tr key={entry.employeeId} style={{ background: i % 2 === 1 ? "#f8fafc" : "#ffffff" }}>
              {LATE_COLUMNS.map((c) => {
                const level = c.key === "minutesLate" ? severityOf(entry.minutesLate) : null;
                return (
                  <td key={c.key} style={cell({ textAlign: c.align, fontWeight: c.key === "name" ? 700 : 400 })}>
                    {level ? (
                      <span
                        style={{
                          display: "inline-block",
                          minWidth: 78,
                          padding: "3px 12px",
                          borderRadius: 999,
                          background: SEVERITY_COLORS[level].bg,
                          color: SEVERITY_COLORS[level].text,
                          fontWeight: 700,
                          fontSize: 13,
                          textAlign: "center",
                        }}
                      >
                        {cellText(entry, c.key)}
                      </span>
                    ) : (
                      cellText(entry, c.key)
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 14, fontSize: 12, color: MUTED }}>
        <span>Late by</span>
        {SEVERITY_BANDS.map((band) => (
          <span key={band.key} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span
              style={{
                display: "inline-block",
                width: 14,
                height: 14,
                borderRadius: 4,
                background: SEVERITY_COLORS[band.key].bg,
                border: `1px solid ${SEVERITY_COLORS[band.key].text}33`,
              }}
            />
            {band.label}
          </span>
        ))}
      </div>

      <div style={{ marginTop: 12, fontSize: 11, color: MUTED, textAlign: "right" }}>
        Generated {generatedStamp(now)} &middot; {input.company} HRMS
      </div>
    </div>
  );
});

export default LateImageSheet;
