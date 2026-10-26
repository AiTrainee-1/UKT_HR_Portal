import type { OrgThemeState } from "@/contexts/ThemeContext";
import type { ThemeId } from "@/lib/themes";

// Which labels a theme card wears. Three different things can be true of a theme, and each has ONE source:
//   everyone  the org-wide theme, and only once the SERVER has said so (a copy cached by this browser may be stale)
//   device    this device's own choice, which lives only in localStorage (uk_textile_theme_device); a missing or invalid
//             key is "no choice", never "the same as everyone"
//   showing   what is really on <html data-theme> right now (a preview, the device's choice or the org-wide theme)

export type ThemeStatusInput = {
  /** The org-wide theme as ThemeContext holds it (the server's, or the cached copy until the server answers). */
  org: ThemeId;
  orgState: OrgThemeState;
  /** This device's own choice, or null. */
  device: ThemeId | null;
  /** What ThemeContext last wrote to <html data-theme>. */
  applied: ThemeId;
  /** A live preview is on (it is what `applied` shows). */
  previewing: boolean;
};

export type ThemeStatus = {
  /** "Active for everyone": the server's answer says so. */
  everyone: boolean;
  /** "Active on this device": this device chose it. */
  device: boolean;
  /** On the screen right now, by whatever route. */
  showing: boolean;
  /** On the screen only because it is being previewed (and it is neither of the two above). */
  previewed: boolean;
};

export function statusOf(id: ThemeId, s: ThemeStatusInput): ThemeStatus {
  const everyone = s.orgState === "confirmed" && s.org === id;
  const device = s.device !== null && s.device === id;
  const showing = s.applied === id;
  return { everyone, device, showing, previewed: s.previewing && showing && !everyone && !device };
}

/** How the summary names the org-wide theme: the server's answer, a wait, or the last copy this browser kept. */
export function everyoneText(name: string, orgState: OrgThemeState): string {
  if (orgState === "confirmed") return name;
  if (orgState === "unreachable") return `${name} (last known: the server did not answer)`;
  return "Checking with the server...";
}
