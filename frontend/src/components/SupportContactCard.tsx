import { Clock, LifeBuoy, Mail, MessageCircle, Phone } from "lucide-react";
import { useSupportContact } from "@/lib/api-client/custom-hooks";
import { cn } from "@/lib/utils";
import {
  FALLBACK_TEXT,
  contactFor,
  dialHref,
  mailHref,
  whatsappHref,
  type SupportContact,
  type SupportSituation,
} from "@/lib/support-contact";

type ViewProps = {
  situation: SupportSituation;
  data: SupportContact | null | undefined;
  title?: string;
  /** "dark" is for the full-screen server-down screens. */
  tone?: "light" | "dark";
  /** One tidy row of buttons, without the hours and the note. */
  compact?: boolean;
  /** Settings preview: the buttons look the same but do nothing. */
  preview?: boolean;
  className?: string;
};

const STYLES = {
  light: {
    box: "border bg-white",
    title: "text-gray-900",
    text: "text-gray-600",
    muted: "text-gray-500",
    button: "border-gray-200 bg-slate-50 text-gray-800 hover:bg-slate-100",
    icon: "text-blue-600",
  },
  dark: {
    box: "border border-white/10 bg-white/[0.04]",
    title: "text-white",
    text: "text-white/70",
    muted: "text-white/50",
    button: "border-blue-400/30 bg-blue-500/10 text-blue-200 hover:bg-blue-500/20",
    icon: "text-blue-300",
  },
} as const;

/** Who to contact for a situation: the details HR entered under Settings -> HR Contact. */
export function SupportContactView({
  situation,
  data,
  title,
  tone = "light",
  compact = false,
  preview = false,
  className,
}: ViewProps) {
  const s = STYLES[tone];
  const block = contactFor(data, situation);
  const heading = title ?? block?.label ?? (situation === "server" ? "Software Support" : "HR Department");

  const actions = block
    ? [
        { key: "call", href: dialHref(block), icon: Phone, label: block.phone, prefix: "Call", testId: "support-call" },
        {
          key: "whatsapp",
          href: whatsappHref(block),
          icon: MessageCircle,
          label: block.whatsapp,
          prefix: "WhatsApp",
          testId: "support-whatsapp",
        },
        { key: "email", href: mailHref(block), icon: Mail, label: block.email, prefix: "", testId: "support-email" },
      ].filter((a) => a.href && a.label)
    : [];

  return (
    <div
      className={cn("rounded-xl p-3.5 text-left", s.box, className)}
      data-testid="support-contact-card"
      data-situation={situation}
    >
      <p className={cn("flex items-center gap-2 text-sm font-bold", s.title)}>
        <LifeBuoy size={15} className={s.icon} /> {heading}
        {block?.usesHrFallback && (
          <span className={cn("text-[10px] font-medium", s.muted)}>(no separate support contact is set)</span>
        )}
      </p>

      {!block ? (
        <p className={cn("mt-1.5 text-xs", s.text)} data-testid="support-fallback">
          {FALLBACK_TEXT[situation]}
        </p>
      ) : (
        <>
          <div className="mt-2 flex flex-wrap gap-2">
            {actions.map(({ key, href, icon: Icon, label, prefix, testId }) => {
              const className = cn(
                "inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors",
                s.button,
                "border",
              );
              const content = (
                <>
                  <Icon size={12} /> {prefix ? `${prefix} ` : ""}
                  {label}
                </>
              );
              return preview ? (
                <span key={key} className={className} data-testid={testId}>
                  {content}
                </span>
              ) : (
                <a
                  key={key}
                  href={href}
                  className={className}
                  data-testid={testId}
                  {...(key === "whatsapp" ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                >
                  {content}
                </a>
              );
            })}
          </div>
          {!compact && block.hours && (
            <p className={cn("mt-2 flex items-center gap-1.5 text-xs", s.muted)}>
              <Clock size={12} /> {block.hours}
            </p>
          )}
          {!compact && data?.note && <p className={cn("mt-1.5 text-xs", s.text)}>{data.note}</p>}
        </>
      )}
    </div>
  );
}

/** The same, loading the saved contact (kept on this device for when the server is down). */
export default function SupportContactCard(props: Omit<ViewProps, "data">) {
  const { data } = useSupportContact();
  return <SupportContactView {...props} data={data} />;
}
