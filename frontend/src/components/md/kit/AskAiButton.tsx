import { Sparkles } from "lucide-react";
import { openAssistant } from "@/lib/md/assistant-store";
import { cn } from "@/lib/utils";

/** "Ask AI": opens the assistant with a ready-made question about what the card shows. */
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
      className={cn(
        "group inline-flex items-center gap-1.5 rounded-full border border-[#006496]/15 bg-white font-semibold text-[#006496] transition-all",
        "hover:border-[#006496]/35 hover:bg-[#006496]/[0.05] hover:shadow-sm",
        size === "sm" ? "px-2.5 py-1 text-[11px]" : "px-3.5 py-1.5 text-xs",
        className,
      )}
    >
      <Sparkles size={size === "sm" ? 12 : 14} className="text-[#e0a83a] transition-transform group-hover:rotate-12" />
      {label}
    </button>
  );
}
