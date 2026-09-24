import path from "node:path";
import { defineConfig } from "vitest/config";

// Kept separate from vite.config.ts so the app's dev/build config (server
// host, plugins, chunking) stays untouched by test tooling.
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      // The unit-testable logic layer. Page components are exercised by the
      // Playwright end-to-end suite instead, and the generated API client is
      // not hand-written code.
      include: ["src/lib/**/*.ts"],
      exclude: ["src/lib/api-client/**", "src/**/*.test.ts"],
      reporter: ["text-summary", "text"],
      // A floor, not a target: set just under today's numbers so coverage can
      // only go up. Raise these as tests are added; `npm run test:coverage`
      // (and CI) fail if a change drops below.
      thresholds: { statements: 50, branches: 80, functions: 70, lines: 50 },
    },
  },
});
