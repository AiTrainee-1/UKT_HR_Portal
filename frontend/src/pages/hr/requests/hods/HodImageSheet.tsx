import { forwardRef, type CSSProperties } from "react";
import { BOARD_TITLE, type HodReportInput } from "./export";
import { DASH, boardTotals, dayText, sortHods, stampText, waitingText } from "./logic";

// The HoD board as a picture (the PNG download and the image the Share button sends): company block, title and date, one
// row per head with the count of every category and the total, the totals row, and a key. It is the OFF-SCREEN element the
// picture is taken from (html2canvas), so, like the Daily Late Report's sheet, it is drawn with inline styles that never
// depend on the app's theme, and it is as tall as the board is long.

const FONT = "Inter, 'Segoe UI', Arial, Helvetica, sans-serif";
const INK = "#0f172a";
const MUTED = "#64748b";
const FAINT = "#cbd5e1";
const RULE = "#e2e8f0";
const HEAD = "#1e293b";
const ACCENT = "#92400e";
const PAD = 28;

/** Wide enough for nine categories with their labels on two lines. */
export const sheetWidth = (categories: number) => Math.max(900, 420 + categories * 92 + 2 * PAD);

const cell = (extra: CSSProperties = {}): CSSProperties => ({
  padding: "9px 8px",
  fontSize: 14,
  lineHeight: "20px",
  color: INK,
  borderBottom: `1px solid ${RULE}`,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  ...extra,
});

const pill = (n: number): CSSProperties => ({
  display: "inline-block",
  minWidth: 30,
  padding: "2px 9px",
  borderRadius: 999,
  background: n > 0 ? "#fef3c7" : "transparent",
  color: n > 0 ? "#92400e" : FAINT,
  fontWeight: n > 0 ? 800 : 500,
});

const HodImageSheet = forwardRef<HTMLDivElement, { input: HodReportInput; testId?: string }>(function HodImageSheet(
  { input, testId },
  ref,
) {
  const rows = sortHods(input.rows);
  const totals = boardTotals(rows, input.categories);
  const width = sheetWidth(input.categories.length);
  return (
    <div
      ref={ref}
      data-testid={testId}
      style={{ width, boxSizing: "border-box", padding: PAD, background: "#ffffff", fontFamily: FONT, color: INK }}
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
          <div style={{ fontSize: 26, fontWeight: 800, color: ACCENT, lineHeight: "30px" }}>{BOARD_TITLE}</div>
          <div style={{ fontSize: 15, marginTop: 2 }}>{dayText(input.now)}</div>
        </div>
      </div>

      <div style={{ height: 1, background: RULE, margin: "16px 0 12px" }} />

      <div
        style={{ display: "flex", gap: 22, fontSize: 14, color: MUTED }}
        data-testid={testId ? `${testId}-figures` : undefined}
      >
        <span>
          <b style={{ color: INK, fontSize: 18 }}>{rows.length}</b> HoDs
        </span>
        <span>
          <b style={{ color: INK, fontSize: 18 }}>{rows.filter((r) => r.pending > 0).length}</b> with pending
        </span>
        <span>
          <b style={{ color: ACCENT, fontSize: 18 }}>{totals.pending}</b> requests waiting
        </span>
        {input.scope && <span style={{ marginLeft: "auto", fontSize: 12 }}>{input.scope}</span>}
      </div>

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
          <col style={{ width: 210 }} />
          <col style={{ width: 150 }} />
          {input.categories.map((c) => (
            <col key={c.key} />
          ))}
          <col style={{ width: 70 }} />
          <col style={{ width: 84 }} />
        </colgroup>
        <thead>
          <tr>
            {["HoD", "Departments", ...input.categories.map((c) => c.label), "Total", "Oldest"].map((h, i) => (
              <th
                key={`${h}-${i}`}
                style={cell({
                  background: HEAD,
                  color: "#ffffff",
                  fontWeight: 700,
                  fontSize: 12,
                  lineHeight: "15px",
                  whiteSpace: "normal",
                  textAlign: i < 2 ? "left" : "center",
                  borderBottom: `1px solid ${HEAD}`,
                })}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.managerId} style={{ background: i % 2 === 1 ? "#f8fafc" : "#ffffff" }}>
              <td style={cell({ fontWeight: 700 })}>{r.name}</td>
              <td style={cell({ color: MUTED, fontSize: 13 })}>{r.departments.join(", ") || r.designation || ""}</td>
              {input.categories.map((c) => {
                const v = r.byCategory[c.key];
                return (
                  <td key={c.key} style={cell({ textAlign: "center" })}>
                    {typeof v === "number" ? (
                      <span style={pill(v)}>{v}</span>
                    ) : (
                      <span style={{ color: FAINT }}>{DASH}</span>
                    )}
                  </td>
                );
              })}
              <td style={cell({ textAlign: "center", fontWeight: 800, color: r.pending > 0 ? INK : FAINT })}>
                {r.pending}
              </td>
              <td
                style={cell({ textAlign: "center", fontSize: 13, color: (r.oldestDays ?? 0) >= 7 ? "#b91c1c" : MUTED })}
              >
                {r.pending > 0 ? waitingText(r.oldestDays) : ""}
              </td>
            </tr>
          ))}
          <tr style={{ background: "#e8eef6" }}>
            <td style={cell({ fontWeight: 800 })}>Total</td>
            <td style={cell({ color: MUTED, fontSize: 13 })}>
              {rows.length} HoD{rows.length === 1 ? "" : "s"}
            </td>
            {input.categories.map((c) => {
              const v = totals.byCategory[c.key];
              return (
                <td key={c.key} style={cell({ textAlign: "center", fontWeight: 800 })}>
                  {typeof v === "number" ? v : DASH}
                </td>
              );
            })}
            <td style={cell({ textAlign: "center", fontWeight: 800, color: ACCENT })}>{totals.pending}</td>
            <td style={cell()} />
          </tr>
        </tbody>
      </table>

      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 12, fontSize: 12, color: MUTED }}>
        <span>{DASH} = this HoD does not approve that kind of request</span>
        <span>
          Generated {stampText(input.now)} &middot; {input.company} HRMS
        </span>
      </div>
    </div>
  );
});

export default HodImageSheet;
