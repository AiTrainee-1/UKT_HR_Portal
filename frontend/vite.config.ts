import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VENDOR_CHUNKS: [chunk: string, packages: RegExp][] = [
  // Rollup moves a manual chunk's dependencies into that chunk unless they are assigned elsewhere, so what the libraries
  // below share with the rest of the app (React above all) gets a chunk of its own; otherwise every page would import
  // React from, say, the framer-motion chunk and load it with the entry.
  ["vendor", /^(react|react-dom|scheduler|clsx|react-is|prop-types|object-assign|tiny-invariant|tslib|@babel\/runtime)$/],
  ["exceljs", /^exceljs$/],
  ["recharts", /^(recharts|recharts-scale|victory-vendor|d3-.+|internmap|decimal\.js-light)$/],
  ["leaflet", /^(leaflet|react-leaflet|@react-leaflet\/.+)$/],
  ["framer-motion", /^(framer-motion|motion|motion-dom|motion-utils)$/],
  ["gsap", /^(gsap|@gsap\/react)$/],
];

/** Build-only (dev serves modules unbundled). JavaScript only: a library's stylesheet (leaflet.css is imported by
 *  main.tsx) must stay with whoever imports it, or the entry would have to load the whole library chunk for it. */
function vendorChunk(id: string): string | undefined {
  // Rollup's CommonJS interop helpers (commonjsHelpers.js, commonjs-dynamic-modules): every CommonJS package (React,
  // exceljs, jszip, leaflet...) imports them; left alone they land in exceljs and jszip would load all of ExcelJS.
  if (id.startsWith("\0commonjs")) return "vendor";
  const file = id.split("?")[0].replace(/\\/g, "/");
  if (!/\.[cm]?js$/.test(file)) return undefined;
  const at = file.lastIndexOf("/node_modules/");
  if (at < 0) return undefined;
  const pkg = file.slice(at + "/node_modules/".length).match(/^(?:@[^/]+\/)?[^/]+/)?.[0] ?? "";
  return VENDOR_CHUNKS.find(([, packages]) => packages.test(pkg))?.[0];
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const port = Number(env.PORT || "5173");
  const basePath = env.BASE_PATH || "/";
  const apiProxy = env.VITE_API_PROXY_TARGET || "http://localhost:8080";

  return {
    base: basePath,
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "src"),
      },
      dedupe: ["react", "react-dom"],
    },
    build: {
      outDir: "dist",
      emptyOutDir: true,
      rollupOptions: {
        output: {
          // The big libraries get chunks of their own: a page that needs one shares the same cached file, and a
          // release that only changes app code does not make browsers download them again.
          manualChunks: vendorChunk,
        },
      },
    },
    server: {
      port,
      strictPort: true,
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: apiProxy,
          changeOrigin: true,
        },
      },
    },
    preview: {
      port,
      host: "0.0.0.0",
    },
  };
});
