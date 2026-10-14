// Temporary: the Playwright-managed Chromium download is missing on this machine, so use the installed Google Chrome.
import base from "./playwright.config";

const first = base.projects![0];
export default { ...base, projects: [{ ...first, use: { ...first.use, channel: "chrome" } }] };
