import { Paperclip } from "lucide-react";

/** Splits WhatsApp text into plain, *bold* and _italic_ runs, the way the phone shows it. */
export function whatsAppRuns(text: string): { text: string; style: "plain" | "bold" | "italic" }[] {
  return text
    .split(/(\*[^*\n]+\*|_[^_\n]+_)/g)
    .filter((part) => part !== "")
    .map((part) => {
      if (part.length > 2 && part.startsWith("*") && part.endsWith("*"))
        return { text: part.slice(1, -1), style: "bold" };
      if (part.length > 2 && part.startsWith("_") && part.endsWith("_"))
        return { text: part.slice(1, -1), style: "italic" };
      return { text: part, style: "plain" };
    });
}

/** A small drawing of a received WhatsApp message: the attachment, then the caption as the phone shows it. */
export function WhatsAppBubble({ text, attachment }: { text: string; attachment?: string }) {
  return (
    <div className="rounded-xl bg-[#e5ddd5] p-2.5" data-testid="whatsapp-bubble">
      <div className="max-w-[300px] rounded-lg rounded-tl-none bg-white px-3 py-2 text-[12px] leading-snug text-gray-800 shadow-sm">
        {attachment && (
          <p className="mb-1.5 flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-1.5 text-[11px] font-semibold text-gray-600">
            <Paperclip size={11} /> {attachment}
          </p>
        )}
        <p className="whitespace-pre-wrap">
          {whatsAppRuns(text).map((run, i) =>
            run.style === "bold" ? (
              <b key={i}>{run.text}</b>
            ) : run.style === "italic" ? (
              <i key={i}>{run.text}</i>
            ) : (
              <span key={i}>{run.text}</span>
            ),
          )}
        </p>
      </div>
    </div>
  );
}
