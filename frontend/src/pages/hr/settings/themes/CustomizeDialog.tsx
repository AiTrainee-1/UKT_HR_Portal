import { useEffect, useState } from "react";
import { Info, RotateCcw, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useTheme } from "@/contexts/ThemeContext";
import { hexToHslTriple, hslTripleToHex, THEMES, type ThemeId } from "@/lib/themes";
import { cn } from "@/lib/utils";
import { contrastText, READABLE_RATIO } from "../identity/colours";
import { errorText } from "../identity/errors";
import {
  colourSet,
  EDITABLE,
  editableOf,
  LIGHT_TEXT,
  PALETTES,
  ratioOf,
  TEXT_ON,
  textCheck,
  type PaletteToken,
} from "./palettes";
import { TOKEN_TEXT } from "./text";

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * The six editable colours of the active theme. Each pick is previewed on this screen through ThemeContext; only
 * "Save colours" writes them to the server, for everyone. What is saved is worked out against the theme's own palette
 * (palettes.ts colourSet): the colours that differ from it, plus a readable text colour wherever the theme's own text
 * would be unreadable on the new colour.
 */
export function CustomizeDialog({
  open,
  onClose,
  themeId,
  readOnly,
}: {
  open: boolean;
  onClose: () => void;
  themeId: ThemeId;
  readOnly: boolean;
}) {
  const { toast } = useToast();
  const { custom, save, preview, isSaving } = useTheme();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);

  // Start from the saved custom colours, else the theme's own, each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    const saved = editableOf(custom);
    setDraft(Object.fromEntries(EDITABLE.map((t) => [t, saved[t] ?? PALETTES[themeId][t as PaletteToken]])));
    setConfirmReset(false);
  }, [open, custom, themeId]);

  // Closing (Cancel, Escape, a save) drops the preview: the screen goes back to what is saved.
  useEffect(() => {
    if (!open) preview(null, null);
  }, [open, preview]);

  const label = THEMES.find((t) => t.id === themeId)?.label ?? themeId;
  const own = PALETTES[themeId];
  const valueOf = (token: string) => draft[token] ?? own[token as PaletteToken];
  const toSave = colourSet(themeId, draft);
  const edited = Object.keys(editableOf(toSave)).length;
  const textColours = Object.keys(toSave).length - edited;
  const savedCount = Object.keys(editableOf(custom)).length;
  const pageRatio = ratioOf(valueOf("--background"), valueOf("--foreground"));

  const update = (token: string, hexValue: string) => {
    const next = { ...draft, [token]: hexToHslTriple(hexValue) };
    setDraft(next);
    preview(themeId, colourSet(themeId, next));
  };

  const handleSave = async () => {
    try {
      await save(themeId, toSave);
      toast({
        title: edited > 0 ? "Custom colours saved" : "No custom colours",
        description:
          edited > 0
            ? `${plural(edited, "colour")}${
                textColours > 0 ? ` (and ${plural(textColours, "text colour")} to keep them readable)` : ""
              } now apply for everyone on ${label}.`
            : `Every colour is ${label}'s own again, for everyone.`,
      });
      onClose();
    } catch (e) {
      toast({ title: "Failed to save colours", description: errorText(e), variant: "destructive" });
    }
  };

  const handleReset = async () => {
    try {
      await save(themeId, {});
      toast({ title: "Colours reset", description: `Back to ${label}'s own palette, for everyone.` });
      onClose();
    } catch (e) {
      toast({ title: "Failed to reset", description: errorText(e), variant: "destructive" });
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <SlidersHorizontal size={16} /> Customize {label}
          </DialogTitle>
        </DialogHeader>

        <DialogDescription className="flex items-start gap-2 rounded-xl bg-blue-50/70 px-2.5 py-2 text-[11px] leading-relaxed text-blue-900 ring-1 ring-blue-100">
          <Info size={13} className="mt-0.5 shrink-0" />
          <span>
            Every page of the portal changes as you pick, on your screen only. The colours apply to everyone once you
            save; Cancel puts the saved ones back. A colour that would leave its text unreadable is saved together with
            a readable text colour (white or near-black), because the matching text colours cannot be edited here.
          </span>
        </DialogDescription>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {EDITABLE.map((token) => {
            const value = valueOf(token);
            const words = TOKEN_TEXT[token];
            const check = textCheck(themeId, token, value);
            const on = TEXT_ON[token];
            const isCustom = value !== own[token as PaletteToken];
            const showPage = token === "--background" || token === "--foreground";
            return (
              <div key={token} className="flex items-start gap-3" data-testid={`token-${token.slice(2)}`}>
                <input
                  type="color"
                  value={hslTripleToHex(value)}
                  onChange={(e) => update(token, e.target.value)}
                  disabled={readOnly}
                  className="mt-0.5 h-9 w-12 shrink-0 cursor-pointer rounded border disabled:cursor-not-allowed"
                  aria-label={words.label}
                />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold leading-tight text-gray-900">
                    {words.label}
                    <code className="ml-1.5 text-[10px] font-normal text-gray-500">{hslTripleToHex(value)}</code>
                    {isCustom && (
                      <span className="ml-1.5 rounded-full bg-amber-100 px-1.5 text-[10px] font-bold text-amber-800">
                        custom
                      </span>
                    )}
                  </p>
                  <p className="text-[11px] leading-snug text-gray-600">{words.colours}</p>
                  {check && on && (
                    <p
                      className={cn(
                        "mt-0.5 text-[11px] font-medium leading-snug",
                        check.replacement ? "text-amber-800" : "text-emerald-700",
                      )}
                      data-testid={`text-on-${token.slice(2)}`}
                    >
                      {check.replacement
                        ? `${on.what}: the theme's own would be ${contrastText(check.themeRatio)}, so ${
                            check.replacement === LIGHT_TEXT ? "white" : "near-black"
                          } text is saved with it (${contrastText(check.ratio)}).`
                        : `${on.what}: ${contrastText(check.ratio)}, readable.`}
                    </p>
                  )}
                  {showPage && (
                    <p
                      className={cn(
                        "mt-0.5 text-[11px] font-medium leading-snug",
                        pageRatio >= READABLE_RATIO ? "text-emerald-700" : "text-amber-800",
                      )}
                      data-testid={`page-text-${token.slice(2)}`}
                    >
                      Page text on the background: {contrastText(pageRatio)}
                      {pageRatio >= READABLE_RATIO ? ", readable." : " - hard to read: change one of the two."}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
          {confirmReset ? (
            <div
              className="flex flex-wrap items-center gap-2 rounded-xl bg-amber-50/80 px-2.5 py-1.5 text-[11px] font-medium text-amber-900 ring-1 ring-amber-200"
              role="alert"
            >
              Removes the {plural(savedCount, "saved colour")} for everyone; there is no undo.
              <Button
                variant="destructive"
                size="sm"
                className="h-7 text-[11px]"
                onClick={handleReset}
                disabled={isSaving}
              >
                Yes, reset
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={() => setConfirmReset(false)}>
                Keep them
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={() => setConfirmReset(true)}
              disabled={readOnly || isSaving || savedCount === 0}
            >
              <RotateCcw size={13} /> Reset to theme default
            </Button>
          )}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="text-xs" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" className="text-xs" onClick={handleSave} disabled={readOnly || isSaving}>
              {isSaving ? "Saving…" : "Save colours"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
