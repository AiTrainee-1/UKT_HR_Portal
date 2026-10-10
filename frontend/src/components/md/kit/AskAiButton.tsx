import { Sparkles } from "lucide-react";
import { openAssistant } from "@/lib/md/assistant-store";
import { cn } from "@/lib/utils";

/** "Ask AI": opens the assistant with a ready-made question about what the card shows. A frosted pill with wine text and a
 *  wine sparkle (md-theme areas/shell.css: .md-shell-ask). */
export default function AskAiButton({
  question,
  label = "Ask AI",
  className,
  size = "sm",
}: {
  question: string;
  label?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <button
      type="button"
      onClick={() => openAssistant(question)}
      title={question}
      data-testid="ask-ai"
      className={cn("md-shell-ask", size === "md" && "md-shell-ask-lg", className)}
    >
      <Sparkles size={size === "sm" ? 12 : 14} strokeWidth={2.2} aria-hidden="true" />
      {label}
    </button>
  );
}
