import { forwardRef, type CSSProperties } from "react";
import { totalRows, unitCounts } from "./logic";
import { GUTTER_PX, sheetWidth, type SheetSpec } from "./sheets";

// The paper-style list (the Daily Leave Report): a salmon title bar, a header row, and one block per
// unit with its label (HO, U-1 ...) in the left gutter. It is drawn with inline styles on purpose: the same element is the
// live preview AND what html2canvas turns into the PDF and the picture, which reads computed styles, so the colours of the
// paper list (green / orange remarks) have to be exactly these and never depend on the app's theme.

const FONT = "Calibri, Arial, Helvetica, sans-serif";
const LINE = "1px solid #000000";

const cell = (extra: CSSProperties = {}): CSSProperties => ({
  border: LINE,
  padding: "3px 8px",
  fontSize: 13,
  lineHeight: "18px",
  color: "#000000",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  ...extra,
});

export type SheetCompany = { name: string; branchLabel: string; logoUrl?: string | null };

const ReportSheet = forwardRef<
  HTMLDivElement,
  {
    spec: SheetSpec;
    /** When given, the company, its logo and the branch are drawn above the title (the PDF and the picture have them). */
    company?: SheetCompany;
    /** Fill the width of the card (the preview) instead of the table's natural width (the export). */
    fluid?: boolean;
    testId?: string;
  }
>(function ReportSheet({ spec, company, fluid = false, testId }, ref) {
  const width = sheetWidth(spec.columns);
  const total = totalRows(spec.blocks);
  // test ids only on the copy that has an id of its own (the preview), never on the off-screen export copy
  const tid = (part: string) => (testId ? `${testId}-${part}` : undefined);
  return (
    <div
      ref={ref}
      data-testid={testId}
      style={{
        width: fluid ? "100%" : width + 40,
        minWidth: fluid ? width : undefined,
        background: "#ffffff",
        padding: fluid ? 0 : 20,
        fontFamily: FONT,
        color: "#000000",
        boxSizing: "border-box",
      }}
    >
      {company && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
          {company.logoUrl && (
            <img src={company.logoUrl} alt="" style={{ height: 48, width: 48, objectFit: "contain" }} />
          )}
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, color: "#1a1a1a" }}>{company.name}</div>
            <div style={{ fontSize: 11, color: "#666666" }}>{company.branchLabel}</div>
          </div>
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontFamily: FONT }}>
        <colgroup>
          <col style={{ width: GUTTER_PX }} />
          {spec.columns.map((c) => (
            <col key={c.key} style={{ width: c.px }} />
          ))}
        </colgroup>
        <thead>
          <tr>
            <td style={{ border: "none", padding: 0 }} />
            <td
              colSpan={spec.columns.length}
              data-testid={tid("title")}
              style={cell({
                background: spec.titleFill,
                textAlign: "center",
                fontWeight: 700,
                fontSize: 17,
                lineHeight: "30px",
                padding: "4px 8px",
              })}
            >
              {spec.title}
            </td>
          </tr>
          <tr>
            <td style={{ border: "none", padding: 0 }} />
            {spec.columns.map((c) => (
              <th
                key={c.key}
                style={cell({
                  background: "#ffffff",
                  fontWeight: 700,
                  textAlign: "center",
                  color: "#000000",
                })}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.blocks.map((block, blockIndex) => [
            blockIndex > 0 && (
              <tr key={`${block.key}-gap`} aria-hidden="true">
                <td colSpan={spec.columns.length + 1} style={{ height: 14, border: "none", padding: 0 }} />
              </tr>
            ),
            ...block.rows.map((row, i) => (
              <tr key={`${block.key}-${row.employeeId}`} data-testid={tid(`row-${row.employeeId}`)}>
                {i === 0 ? (
                  <td
                    title={block.branchName ?? undefined}
                    data-testid={tid(`unit-${block.key}`)}
                    style={cell({ textAlign: "center", fontWeight: 700, fontSize: 14, padding: "3px 2px" })}
                  >
                    {block.label}
                  </td>
                ) : (
                  <td style={{ border: "none", padding: 0 }} />
                )}
                {spec.columns.map((c) => {
                  const out = c.cell(row, i);
                  return (
                    <td
                      key={c.key}
                      style={cell({
                        textAlign: c.align,
                        background: out.fill ?? "#ffffff",
                        fontWeight: out.bold ? 700 : 400,
                      })}
                    >
                      {out.text}
                    </td>
                  );
                })}
              </tr>
            )),
          ])}
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 10, color: "#999999", fontStyle: "italic", textAlign: "right" }}>
        Total {total}
        {spec.blocks.length > 1 ? ` (${unitCounts(spec.blocks)})` : ""}
        {company ? ` · Generated by ${company.name} HRMS` : ""}
      </div>
    </div>
  );
});

export default ReportSheet;
