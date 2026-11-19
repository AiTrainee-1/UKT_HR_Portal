import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as hooks from "./index";

// The reception desk and the gate monitor talk to the server through their own fetch (pages/gate/reception/desk-api.ts,
// pages/gate/monitor/client.ts), with their own token and never the HR one. The old desk hooks in gate.ts went through
// customFetch (which falls back to the HR token) and nothing used them any more: they are gone and must not come back.

const here = import.meta.dirname;

describe("gate.ts hooks", () => {
  it.each([
    "useReceptionLogin",
    "useReceptionLoginInfo",
    "useReceptionSummary",
    "useReceptionVisits",
    "useListReceptionDevices",
    "getListReceptionDevicesQueryKey",
    "useCreateReceptionDevice",
    "useUpdateReceptionDevice",
    "useDeleteReceptionDevice",
    "useVisitorSummary",
    "getVisitorSummaryQueryKey",
    "useVisitorRecords",
    "getVisitorRecordsQueryKey",
  ])("no longer exports %s (unused; the desk and Visitors pages have their own)", (name) => {
    expect(hooks).not.toHaveProperty(name);
  });

  it("no shared hook file reads a desk or gate token (only the desk's and the gate's own fetch do)", () => {
    for (const file of fs.readdirSync(here).filter((f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f))) {
      const source = fs.readFileSync(path.join(here, file), "utf8");
      expect(source, file).not.toMatch(/localStorage\.getItem\(\s*["'](?:reception|gate)_device_token/);
    }
  });

  it("keeps the hooks the pages still use", () => {
    for (const name of [
      "useOutpassQr",
      "useOutpassSummary",
      "useOutpassRecords",
      "useVisitorQr",
      "useListOutpassRequests",
      "getListOutpassRequestsQueryKey",
      "useTeaBreakRule",
      "useUpdateTeaBreakRule",
    ]) {
      expect(hooks, name).toHaveProperty(name);
    }
  });
});
