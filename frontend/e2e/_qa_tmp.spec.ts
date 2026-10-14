// TEMPORARY visual QA script (deleted after use). Screenshots + downloads go to the session scratchpad.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { loginAsHr } from "./helpers";

const OUT =
  "C:/Users/DELL/AppData/Local/Temp/claude/d--Projects-UK-textile/e3541785-3370-4426-90e9-1da812fcd305/scratchpad/qa_shots";

for (const [vp, size] of [
  ["desk", { width: 1366, height: 1900 }],
  ["phone", { width: 390, height: 2600 }],
] as const) {
  test(`punches report ${vp}`, async ({ page }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    await loginAsHr(page);
    const t = (await page.evaluate(() => localStorage.getItem("uk_textile_token"))) as string;
    const call = (method: string, url: string, data?: unknown) =>
      page.request.fetch(url, { method, headers: { Authorization: `Bearer ${t}` }, data });
    const people = async () =>
      ((await (await call("GET", "/api/employees?search=PQ-")).json()) as { id: number; employeeCode: string }[]).filter(
        (e) => e.employeeCode.startsWith("PQ-"),
      );
    for (const e of await people()) await call("DELETE", `/api/employees/${e.id}`);
    try {
      const branches = (await (await call("GET", "/api/branches")).json()) as { id: number }[];
      const names: [string, string, string][] = [
        ["PQ-1", "Lakshmi", "Narayanan"],
        ["PQ-2", "Murugan", "Selvam"],
        ["PQ-10", "Kavitha", "Rajendran"],
      ];
      for (const [code, first, last] of names) {
        const res = await call("POST", "/api/employees", {
          employeeCode: code,
          firstName: first,
          lastName: last,
          phone: "9000000099",
          employmentType: "production",
          branchId: branches[0].id,
          salaryType: "monthly",
        });
        expect(res.status(), await res.text()).toBe(201);
      }
      const ids = new Map((await people()).map((e) => [e.employeeCode, e.id]));
      const punch = async (code: string, date: string, time: string) => {
        const res = await call("POST", "/api/attendance/manual", {
          employeeId: ids.get(code),
          date,
          punchTime: time,
          punchType: "IN",
        });
        expect(res.status()).toBe(201);
      };
      for (const d of ["2026-03-02", "2026-03-03", "2026-03-04"])
        for (const tm of ["08:02", "12:01", "13:00", "17:32"]) await punch("PQ-1", d, tm);
      for (const tm of ["08:10", "12:05", "13:04", "17:28", "19:30", "20:15"]) await punch("PQ-2", "2026-03-02", tm);
      for (const tm of ["08:00", "17:30"]) await punch("PQ-2", "2026-03-03", tm);
      await punch("PQ-10", "2026-03-02", "08:15");

      const base = "/hr/reports?report=production-daily-punches&run=1";
      for (const [name, from, to] of [
        ["day", "2026-03-02", "2026-03-02"],
        ["week", "2026-03-02", "2026-03-08"],
      ]) {
        await page.goto(`${base}&dateFrom=${from}&dateTo=${to}`);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(1200);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        console.log(`QA ${vp} ${name}: horizontal overflow ${overflow}px`);
        await page.screenshot({ path: `${OUT}/punches-${vp}-${name}.png`, fullPage: true });
      }
      await page.goto("/hr/reports");
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `${OUT}/punches-${vp}-catalog.png`, fullPage: true });

      if (vp === "desk") {
        await page.goto(`${base}&dateFrom=2026-03-02&dateTo=2026-03-08`);
        await page.waitForLoadState("networkidle");
        const [xlsx] = await Promise.all([
          page.waitForEvent("download"),
          page.getByTestId("report-download-xlsx").click(),
        ]);
        writeFileSync(`${OUT}/punches-week.xlsx`, readFileSync((await xlsx.path()) as string));
        const [pdf] = await Promise.all([page.waitForEvent("download"), page.getByTestId("report-download-pdf").click()]);
        writeFileSync(`${OUT}/punches-week.pdf`, readFileSync((await pdf.path()) as string));
      }
    } finally {
      for (const e of await people()) await call("DELETE", `/api/employees/${e.id}`);
    }
  });
}
