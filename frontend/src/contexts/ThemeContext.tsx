import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
import { useAuth } from "@/contexts/AuthContext";
import { customFetch } from "@/lib/api-client/custom-fetch";
import { DEFAULT_THEME, isThemeId, type ThemeId } from "@/lib/themes";

/**
 * Applies the org-wide portal theme.
 *
 * The selection lives on the server (PayrollSettings.theme_name) so every HR
 * user sees the same portal, but it's mirrored into localStorage and applied
 * synchronously on mount -otherwise the app would flash the default palette
 * on every page load while the fetch is in flight.
 *
 * Preview mode lets the Themes page show a theme live without saving it, so
 * you can look at a theme before committing everyone to it. Navigating away
 * without saving simply drops the preview.
 *
 * A device can also keep a theme of its own ("Use only on this device"):
 * a ThemeId in localStorage that is never sent to the server. What is on
 * screen is, in this order, the live preview, then the device's own choice,
 * then the org-wide theme. The server's answer only ever updates the org-wide
 * theme, so it can never overwrite the device's choice; the device's choice
 * is read at start-up (and before sign-in), so the sign-in page wears it too.
 * The org-wide custom colours belong to the org-wide theme: a device on a
 * different theme shows that theme's own palette.
 */

const STORAGE_KEY = "uk_textile_theme";
const STORAGE_CUSTOM_KEY = "uk_textile_theme_custom";
/** The theme this one device uses instead of the org-wide one (a ThemeId); absent when the device follows everyone. */
export const THEME_DEVICE_STORAGE_KEY = "uk_textile_theme_device";

type ThemeCustom = Record<string, string>;
export type OrgThemeState = "cached" | "confirmed" | "unreachable";

type ThemeContextValue = {
  theme: ThemeId;
  custom: ThemeCustom;
  /** The theme only this device uses, or null when it follows the org-wide one. */
  deviceTheme: ThemeId | null;
  /** What's actually on screen right now (preview, else this device's own choice, else the org-wide theme). */
  effectiveTheme: ThemeId;
  /** What was last written to <html data-theme>: the truth about the screen (equal to effectiveTheme once painted). */
  appliedTheme: ThemeId;
  /**
   * Where `theme` (the org-wide theme) comes from: "cached" is the copy this browser kept from its last visit (it may be
   * stale: someone may have changed the theme since), "confirmed" is the server's answer (or the server's reply to a save),
   * "unreachable" means the server did not answer and the cached copy is all there is. A label that says what everyone
   * uses must wait for "confirmed".
   */
  orgThemeState: OrgThemeState;
  isPreviewing: boolean;
  isSaving: boolean;
  preview: (theme: ThemeId | null, custom?: ThemeCustom | null) => void;
  save: (theme: ThemeId, custom: ThemeCustom) => Promise<void>;
  /** Use a theme on this device only (null: follow the org-wide theme again). Nothing is sent to the server. */
  setDeviceTheme: (theme: ThemeId | null) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && isThemeId(v)) return v;
  } catch { /* private mode / storage disabled */ }
  return DEFAULT_THEME;
}

/** This device's own theme: a stored value that is not a ThemeId (a theme removed since, a hand-edited key) is ignored. */
export function readDeviceTheme(): ThemeId | null {
  try {
    const v = localStorage.getItem(THEME_DEVICE_STORAGE_KEY);
    if (v && isThemeId(v)) return v;
  } catch { /* private mode / storage disabled */ }
  return null;
}

/** No custom colours: the same object every time, so an effect that depends on it does not run again each render. */
const NO_CUSTOM: ThemeCustom = {};

function readStoredCustom(): ThemeCustom {
  try {
    const raw = localStorage.getItem(STORAGE_CUSTOM_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") return parsed as ThemeCustom;
    }
  } catch { /* malformed -fall back to none */ }
  return {};
}

/** Writes the theme to <html>. Custom tokens go on as inline styles so they
 *  win over the stylesheet's [data-theme] block without needing !important. */
function applyToDocument(theme: ThemeId, custom: ThemeCustom, previousCustom: ThemeCustom) {
  const root = document.documentElement;
  root.dataset.theme = theme;
  // .dark is what the pre-existing stylesheet keys off; keep it in sync so
  // any component still checking for the class behaves correctly.
  root.classList.toggle("dark", theme === "dark");

  for (const token of Object.keys(previousCustom)) {
    if (!(token in custom)) root.style.removeProperty(token);
  }
  for (const [token, value] of Object.entries(custom)) {
    root.style.setProperty(token, value);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme);
  const [custom, setCustom] = useState<ThemeCustom>(readStoredCustom);
  const [previewTheme, setPreviewTheme] = useState<ThemeId | null>(null);
  const [previewCustom, setPreviewCustom] = useState<ThemeCustom | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deviceTheme, setDeviceThemeState] = useState<ThemeId | null>(readDeviceTheme);
  const [orgThemeState, setOrgThemeState] = useState<OrgThemeState>("cached");
  const [appliedTheme, setAppliedTheme] = useState<ThemeId | null>(null);

  const effectiveTheme = previewTheme ?? deviceTheme ?? theme;
  // The saved custom colours are the org-wide theme's: a device that uses another theme (and is not previewing one)
  // shows that theme as it comes.
  const deviceOnOtherTheme = previewTheme === null && deviceTheme !== null && deviceTheme !== theme;
  const effectiveCustom = previewCustom ?? (deviceOnOtherTheme ? NO_CUSTOM : custom);

  // Paint whatever's effective, and remember what we painted so the next
  // apply can clean up tokens that are no longer set.
  const [appliedCustom, setAppliedCustom] = useState<ThemeCustom>({});
  useEffect(() => {
    applyToDocument(effectiveTheme, effectiveCustom, appliedCustom);
    setAppliedCustom(effectiveCustom);
    setAppliedTheme(effectiveTheme);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTheme, effectiveCustom]);

  // Pull the server's copy as soon as someone is signed in (and again after the next sign-in). The endpoint needs a token,
  // so asking before login only produced a 401 in the server log, and asking once at start-up meant a browser that was not
  // signed in yet kept the default palette until the page was reloaded. A failure is non-fatal: the locally cached theme
  // stays in effect rather than snapping to default.
  const { token } = useAuth();
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    customFetch<{ themeName: string; themeCustom: ThemeCustom }>("/api/theme-settings")
      .then((r) => {
        if (cancelled) return;
        const next = isThemeId(r.themeName) ? r.themeName : DEFAULT_THEME;
        setTheme(next);
        setCustom(r.themeCustom ?? {});
        setOrgThemeState("confirmed");
        try {
          localStorage.setItem(STORAGE_KEY, next);
          localStorage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(r.themeCustom ?? {}));
        } catch { /* ignore */ }
      })
      .catch(() => {
        // offline or a bad token -keep the cached theme, and say it is only the cached one
        if (!cancelled) setOrgThemeState((state) => (state === "confirmed" ? state : "unreachable"));
      });
    return () => { cancelled = true; };
  }, [token]);

  const setDeviceTheme = useCallback((t: ThemeId | null) => {
    try {
      if (t === null) localStorage.removeItem(THEME_DEVICE_STORAGE_KEY);
      else localStorage.setItem(THEME_DEVICE_STORAGE_KEY, t);
    } catch { /* storage disabled: the choice lasts until the page is closed */ }
    setDeviceThemeState(t);
  }, []);

  // Another tab of this browser changed the device's choice (or cleared it): follow it.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === THEME_DEVICE_STORAGE_KEY || e.key === null) setDeviceThemeState(readDeviceTheme());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const preview = useCallback((t: ThemeId | null, c?: ThemeCustom | null) => {
    setPreviewTheme(t);
    setPreviewCustom(c ?? null);
  }, []);

  const save = useCallback(async (t: ThemeId, c: ThemeCustom) => {
    setIsSaving(true);
    try {
      const r = await customFetch<{ themeName: string; themeCustom: ThemeCustom }>(
        "/api/theme-settings/update",
        { method: "PUT", body: JSON.stringify({ themeName: t, themeCustom: c }) },
      );
      const next = isThemeId(r.themeName) ? r.themeName : DEFAULT_THEME;
      setTheme(next);
      setCustom(r.themeCustom ?? {});
      setOrgThemeState("confirmed");
      setPreviewTheme(null);
      setPreviewCustom(null);
      try {
        localStorage.setItem(STORAGE_KEY, next);
        localStorage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(r.themeCustom ?? {}));
      } catch { /* ignore */ }
    } finally {
      setIsSaving(false);
    }
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({
    theme,
    custom,
    deviceTheme,
    effectiveTheme,
    appliedTheme: appliedTheme ?? effectiveTheme,
    orgThemeState,
    isPreviewing: previewTheme !== null || previewCustom !== null,
    isSaving,
    preview,
    save,
    setDeviceTheme,
  }), [theme, custom, deviceTheme, effectiveTheme, appliedTheme, orgThemeState, previewTheme, previewCustom, isSaving, preview, save, setDeviceTheme]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
