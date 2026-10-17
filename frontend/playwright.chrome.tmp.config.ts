import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// TEMPORARY: the base config, run in the installed Chrome (delete this file after use).
export default defineConfig({
  ...base,
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
});
