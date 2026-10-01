import type { CSSProperties, ElementType, ReactNode } from "react";
import { Laptop, Database, Globe, Server } from "lucide-react";
import "./status-screen.css";

// One look for every "something is not right" screen (connection lost, database offline, 404, server error): a midnight
// canvas with a slow aurora, a glass card, and a tone colour that says how serious it is. See status-screen.css.

export type StatusTone = "danger" | "warning" | "info";

export function BrandMark({ size = 34 }: { size?: number }) {
  return (
    <svg viewBox="0 0 1536 1024" width={size * 1.5} height={size} aria-hidden="true">
      <defs>
        <mask id="ss-ring-gap">
          <rect x="0" y="0" width="1536" height="1024" fill="white" />
          <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
        </mask>
      </defs>
      <ellipse cx="793" cy="512" rx="608" ry="391" fill="#4FB8F0" mask="url(#ss-ring-gap)" />
      <ellipse cx="793" cy="512" rx="585" ry="375" fill="#4FB8F0" />
      <path
        fill="#FFFFFF"
        d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z"
      />
    </svg>
  );
}

export type DetailRow = { label: string; value: ReactNode; tone?: "bad" | "ok" };

const GLOW: Record<StatusTone, string> = {
  danger: "251, 113, 133",
  warning: "251, 191, 36",
  info: "56, 189, 248",
};

type StatusScreenProps = {
  tone?: StatusTone;
  /** The icon in the glowing tile (not shown when a big `code` is). */
  icon?: ElementType;
  /** A big HTTP-style number: 404, 500. */
  code?: string;
  /** The pill in the corner: "Connection lost". */
  badge: string;
  title: string;
  description: ReactNode;
  /** Buttons, the live-check bar, the support card... between the text and the details. */
  children?: ReactNode;
  details?: DetailRow[];
  /** A full-screen takeover that sits over whatever page is open (the connectivity overlay). */
  overlay?: boolean;
  footer?: string;
  /** Something drawn between the title block and the children (the connection path). */
  above?: ReactNode;
};

export function StatusScreen({
  tone = "danger",
  icon: Icon,
  code,
  badge,
  title,
  description,
  children,
  details,
  overlay = false,
  footer = "UKTextiles Enterprise Platform · On-Premise Infrastructure",
  above,
}: StatusScreenProps) {
  return (
    <div
      className="ss-root"
      data-tone={tone}
      data-overlay={overlay}
      style={{ "--ss-glow": GLOW[tone] } as CSSProperties}
      role={overlay ? "alertdialog" : undefined}
      aria-live={overlay ? "assertive" : undefined}
      aria-label={overlay ? title : undefined}
    >
      <div className="ss-bg" aria-hidden="true">
        <div className="ss-aurora">
          <span />
          <span />
          <span />
        </div>
        <div className="ss-grid" />
      </div>

      <main className="ss-card">
        <header className="ss-head">
          <div className="ss-brand">
            <BrandMark size={28} />
            <div>
              <b>UKTextiles</b>
              <small>HR &amp; ERP</small>
            </div>
          </div>
          <span className="ss-pill">
            <i /> {badge}
          </span>
        </header>

        {code ? (
          <p className="ss-code" aria-hidden="true">
            {code}
          </p>
        ) : (
          Icon && (
            <div className="ss-icon">
              <Icon size={40} strokeWidth={1.7} />
            </div>
          )
        )}
        <h1 className="ss-title">{title}</h1>
        <p className="ss-text">{description}</p>

        {above}
        {children}

        {details && details.length > 0 && (
          <details className="ss-details">
            <summary>Technical details</summary>
            <dl>
              {details.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd data-tone={row.tone}>{row.value}</dd>
                </div>
              ))}
            </dl>
          </details>
        )}
      </main>

      <p className="ss-footer">{footer}</p>
    </div>
  );
}

type ButtonProps = {
  variant?: "primary" | "ghost";
  icon?: ElementType;
  children: ReactNode;
} & ({ href: string; onClick?: never; disabled?: never } | { href?: never; onClick: () => void; disabled?: boolean });

/** A button (or a link, with `href`) in the status screens' own style. */
export function StatusButton({ variant = "primary", icon: Icon, children, href, onClick, disabled }: ButtonProps) {
  const content = (
    <>
      {Icon && <Icon size={16} />}
      {children}
    </>
  );
  return href ? (
    <a className="ss-btn" data-variant={variant} href={href}>
      {content}
    </a>
  ) : (
    <button type="button" className="ss-btn" data-variant={variant} onClick={onClick} disabled={disabled}>
      {content}
    </button>
  );
}

export function StatusActions({ children }: { children: ReactNode }) {
  return <div className="ss-actions">{children}</div>;
}

type NodeState = "ok" | "bad" | "unknown";

const PATH_NODES = [
  { key: "device", label: "Your device", icon: Laptop },
  { key: "network", label: "Network", icon: Globe },
  { key: "server", label: "Server", icon: Server },
  { key: "database", label: "Database", icon: Database },
] as const;

const STATE_WORD: Record<NodeState, string> = { ok: "Online", bad: "Down", unknown: "Not reached" };

/** Where the connection breaks: device -> network -> server -> database, the failing link drawn broken. */
export function ConnectionPath({ states }: { states: Record<(typeof PATH_NODES)[number]["key"], NodeState> }) {
  return (
    <div className="ss-path" role="img" aria-label="Connection path">
      {PATH_NODES.map((node, i) => {
        const Icon = node.icon;
        const state = states[node.key];
        return (
          <div key={node.key} style={{ display: "contents" }}>
            {i > 0 && <span className="ss-link" data-state={state === "ok" ? "ok" : state} />}
            <div className="ss-node" data-state={state}>
              <span className="ss-node-dot">
                <Icon size={17} />
              </span>
              {node.label}
              <small>{STATE_WORD[state]}</small>
            </div>
          </div>
        );
      })}
    </div>
  );
}
