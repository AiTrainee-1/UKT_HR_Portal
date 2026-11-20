// A fake /api/reports/custom/* server for the Customise render tests, on top of the MD portal's render harness
// (pages/md/testing/renderMdPage: real providers, every request answered from fixtures, nothing on the network). It
// records every call (method, query, body), and a <Where /> probe shows the address the page is at.

import { act } from "react";
import { useLocation, useSearch } from "wouter";
import type { SavedCustomReport } from "@/lib/api-client/custom-hooks/report-customise";
import type { Fixtures, RenderedPage } from "@/pages/md/testing/renderMdPage";
import { DATASETS_BODY, catalogFixture, previewResult, savedItem } from "./test-fixtures";

export type Call = { method: string; path: string; params: URLSearchParams; body: Record<string, unknown> | null };

/** The address the page is at (path and query), for the tests to read. */
export function Where() {
  const [location] = useLocation();
  const search = useSearch();
  return (
    <output data-testid="where" hidden>
      {search ? `${location}?${search}` : location}
    </output>
  );
}

export const whereOf = (page: RenderedPage) => page.container.querySelector('[data-testid="where"]')?.textContent ?? "";

type Reply = { status: number; body: unknown };

export function customServer(
  opts: {
    /** Role permissions of the signed-in HR login (default: edit on Reports). */
    permissions?: Record<string, string>;
    /** The saved reports the server holds. */
    saved?: SavedCustomReport[];
    /** Answer the preview with this instead (an error, say). */
    preview?: Reply;
    /** Answer a save (POST / PUT) with this instead. */
    save?: Reply;
    customise?: boolean;
  } = {},
) {
  const calls: Call[] = [];
  let library = [...(opts.saved ?? [])];
  let nextId = 41;

  const record = (path: string, params: URLSearchParams, init?: RequestInit): Call => {
    const raw = typeof init?.body === "string" ? init.body : null;
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      path,
      params,
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
    };
    calls.push(call);
    return call;
  };

  const item = (id: number) => {
    const base = `/api/reports/custom/saved/${id}`;
    return {
      [base]: (params: URLSearchParams, init?: RequestInit) => {
        const call = record(base, params, init);
        const found = library.find((r) => r.id === id);
        if (!found) return { status: 404, body: { error: "not_found", message: "Report not found" } };
        if (call.method === "DELETE") {
          library = library.filter((r) => r.id !== id);
          return {};
        }
        if (call.method === "PUT") {
          if (opts.save) return opts.save;
          const updated = { ...found, ...(call.body as Partial<SavedCustomReport>), updatedBy: "HR Admin" };
          library = library.map((r) => (r.id === id ? updated : r));
          return updated;
        }
        return found;
      },
      [`${base}/duplicate`]: (params: URLSearchParams, init?: RequestInit) => {
        record(`${base}/duplicate`, params, init);
        const found = library.find((r) => r.id === id)!;
        const copy = { ...found, id: nextId, reportId: `custom-${nextId}`, name: `${found.name} (copy)` };
        nextId += 1;
        library = [...library, copy];
        return copy;
      },
    };
  };

  const fixtures: Fixtures = {
    "/api/auth/me": {
      role: "hr",
      employeeId: null,
      name: "HR Admin",
      isMd: false,
      isSuperAdmin: false,
      permissions: opts.permissions ?? { reports: "edit" },
    },
    "/api/reports/catalog": () => catalogFixture({ customise: opts.customise ?? true, saved: library }),
    "/api/reports/custom/datasets": DATASETS_BODY,
    "/api/reports/custom/preview": (params, init) => {
      record("/api/reports/custom/preview", params, init);
      return opts.preview ?? previewResult(params);
    },
    "/api/reports/custom/saved": (params, init) => {
      const call = record("/api/reports/custom/saved", params, init);
      if (call.method === "POST") {
        if (opts.save) return opts.save;
        const created = savedItem({
          ...(call.body as Partial<SavedCustomReport>),
          id: nextId,
          reportId: `custom-${nextId}`,
          datasetLabel: "Employees with period figures",
          createdBy: "HR Admin",
          updatedBy: null,
          updatedAt: null,
        });
        nextId += 1;
        library = [...library, created];
        return created;
      }
      return { items: library };
    },
    // ids the tests use: the fixtures' saved report (7), what a save creates (41, 42)
    ...item(7),
    ...item(8),
    ...item(41),
    ...item(42),
  };

  return {
    fixtures,
    calls,
    /** The calls to one path (and method). */
    to: (path: string, method?: string) => calls.filter((c) => c.path === path && (!method || c.method === method)),
    library: () => library,
  };
}

/** Fires a native event on an element inside React's act, then lets the page settle. */
export async function fire(page: RenderedPage, selector: string, type: string) {
  const el = page.container.querySelector(selector) ?? document.body.querySelector(selector);
  if (!el) throw new Error(`Nothing matches "${selector}"`);
  await act(async () => {
    el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
  });
  await page.settle();
}
