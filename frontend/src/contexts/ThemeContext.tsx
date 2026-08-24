import {
  createContext, useCallback, useContext, useEffect, useMemo, useState,
  type ReactNode,
} from "react";
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
 */

const STORAGE_KEY = "uk_textile_theme";
const STORAGE_CUSTOM_KEY = "uk_textile_theme_custom";

type ThemeCustom = Record<string, string>;

type ThemeContextValue = {
  theme: ThemeId;
  custom: ThemeCustom;
  /** What's actually on screen right now (preview overrides saved value). */
  effectiveTheme: ThemeId;
  isPreviewing: boolean;
  isSaving: boolean;
  preview: (theme: ThemeId | null, custom?: ThemeCustom | null) => void;
  save: (theme: ThemeId, custom: ThemeCustom) => Promise<void>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v && isThemeId(v)) return v;
  } catch { /* private mode / storage disabled */ }
  return DEFAULT_THEME;
}

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

  const effectiveTheme = previewTheme ?? theme;
  const effectiveCustom = previewCustom ?? custom;

  // Paint whatever's effective, and remember what we painted so the next
  // apply can clean up tokens that are no longer set.
  const [appliedCustom, setAppliedCustom] = useState<ThemeCustom>({});
  useEffect(() => {
    applyToDocument(effectiveTheme, effectiveCustom, appliedCustom);
    setAppliedCustom(effectiveCustom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTheme, effectiveCustom]);

  // Pull the server's copy once on mount. A failure here is non-fatal: the
  // locally cached theme stays in effect rather than snapping to default.
  useEffect(() => {
    let cancelled = false;
    customFetch<{ themeName: string; themeCustom: ThemeCustom }>("/api/theme-settings")
      .then((r) => {
        if (cancelled) return;
        const next = isThemeId(r.themeName) ? r.themeName : DEFAULT_THEME;
        setTheme(next);
        setCustom(r.themeCustom ?? {});
        try {
          localStorage.setItem(STORAGE_KEY, next);
          localStorage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(r.themeCustom ?? {}));
        } catch { /* ignore */ }
      })
      .catch(() => { /* not signed in yet, or offline -keep cached theme */ });
    return () => { cancelled = true; };
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
    effectiveTheme,
    isPreviewing: previewTheme !== null || previewCustom !== null,
    isSaving,
    preview,
    save,
  }), [theme, custom, effectiveTheme, previewTheme, previewCustom, isSaving, preview, save]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
