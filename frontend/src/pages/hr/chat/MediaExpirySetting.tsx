import { useId, useState } from "react";
import { Clock3, Pencil, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  CHAT_MEDIA_EXPIRY_LIMITS,
  parseMediaExpiryDays,
  useChatSettings,
  useSaveChatSettings,
} from "@/lib/api-client/custom-hooks";

const dayWord = (n: number) => `${n} ${n === 1 ? "day" : "days"}`;

/**
 * "Chat media expiry (days)" (owner 2026-11-25): GIFs and voice messages sent in the Employee App are deleted from the
 * server this many days after they are sent -7 unless HR changes it here (1-90). The change also applies to the GIFs
 * and voice messages still in the chat. Saving needs edit on Chat; a view-only role sees the value (the Save / Edit
 * buttons are locked by the portal's view-only rule, and the server refuses the change anyway).
 */
export default function MediaExpirySetting() {
  const { toast } = useToast();
  const { data, isLoading, isError } = useChatSettings();
  const save = useSaveChatSettings();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [touched, setTouched] = useState(false);
  const inputId = useId();
  const helpId = useId();

  const min = data?.minDays ?? CHAT_MEDIA_EXPIRY_LIMITS.min;
  const max = data?.maxDays ?? CHAT_MEDIA_EXPIRY_LIMITS.max;
  const parsed = parseMediaExpiryDays(draft, min, max);
  const showError = touched && parsed.error;

  const start = () => {
    setDraft(String(data?.mediaExpiryDays ?? CHAT_MEDIA_EXPIRY_LIMITS.default));
    setTouched(false);
    setEditing(true);
  };

  const submit = async () => {
    setTouched(true);
    if (parsed.days == null) return;
    try {
      const saved = await save.mutateAsync(parsed.days);
      setEditing(false);
      toast({
        title: "Chat media expiry saved",
        description: `GIFs and voice messages now stay for ${dayWord(saved.mediaExpiryDays)}.`,
      });
    } catch (e) {
      const why = (e as { data?: { error?: unknown } } | null)?.data?.error;
      toast({
        title: "Could not save the chat media expiry",
        description: typeof why === "string" && why ? why : "Please try again.",
        variant: "destructive",
      });
    }
  };

  return (
    <div
      className="w-full max-w-md rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 shadow-sm dark:border-slate-700 dark:bg-slate-900"
      data-testid="chat-media-expiry"
    >
      <div className="flex items-start gap-2.5">
        <Clock3 size={16} className="mt-0.5 shrink-0 text-blue-500" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-bold text-foreground">Chat media expiry (days)</p>
          {!editing && (
            <p className="text-[11px] text-muted-foreground" data-testid="chat-media-expiry-value">
              {isLoading
                ? "Loading…"
                : isError || !data
                  ? "Could not load this setting."
                  : `GIFs and voice messages stay for ${dayWord(data.mediaExpiryDays)}, then they are deleted from the server.`}
            </p>
          )}
        </div>
        {!editing && data && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-7 shrink-0 gap-1 px-2 text-xs"
            onClick={start}
            aria-label="Edit chat media expiry"
            data-testid="chat-media-expiry-edit"
          >
            <Pencil size={12} aria-hidden /> Change
          </Button>
        )}
      </div>

      {editing && (
        <form
          className="mt-2 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          noValidate
        >
          <div className="flex items-center gap-2">
            <label htmlFor={inputId} className="sr-only">
              Chat media expiry (days)
            </label>
            <Input
              id={inputId}
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              step={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={showError ? true : undefined}
              aria-describedby={helpId}
              className="h-8 w-24 text-sm"
              disabled={save.isPending}
              data-testid="chat-media-expiry-input"
            />
            <span className="text-xs text-muted-foreground">days</span>
            <Button
              type="submit"
              size="sm"
              className="ml-auto h-8 px-3 text-xs"
              disabled={save.isPending}
              data-testid="chat-media-expiry-save"
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-8 px-2"
              onClick={() => setEditing(false)}
              disabled={save.isPending}
              aria-label="Cancel"
            >
              <X size={14} aria-hidden />
            </Button>
          </div>
          {showError && (
            <p className="text-[11px] font-semibold text-red-600 dark:text-red-400" role="alert" data-testid="chat-media-expiry-error">
              {parsed.error}
            </p>
          )}
          <p id={helpId} className="text-[11px] leading-snug text-muted-foreground">
            GIFs and voice messages sent in the Employee App are deleted from the server this many days after they are
            sent ({min}–{max}, {CHAT_MEDIA_EXPIRY_LIMITS.default} by default). The change also applies to those already in
            the chat. Employees who want to keep one can save it on their phone before then.
          </p>
        </form>
      )}
    </div>
  );
}
