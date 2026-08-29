import { cn } from "@/lib/utils";

/**
 * The UK Textiles mark, inline.
 *
 * Inline SVG rather than /UKT_Company_Logo.png on purpose: this renders on
 * the boot screen, before anything else has loaded, and an <img> there costs
 * a network round trip that can leave the loader logo-less for the first
 * moment -exactly when it is the only thing on screen.
 */
export function UktLogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1536 1024" className={cn("h-14 w-auto", className)} aria-hidden="true">
      <defs>
        <mask id="ukt-mark-ring-gap">
          <rect x="0" y="0" width="1536" height="1024" fill="white" />
          <ellipse cx="793" cy="512" rx="595" ry="382" fill="black" />
        </mask>
      </defs>
      <ellipse cx="793" cy="512" rx="608" ry="391" fill="#4FB8F0" mask="url(#ukt-mark-ring-gap)" />
      <ellipse cx="793" cy="512" rx="585" ry="375" fill="#4FB8F0" />
      <path
        fill="#FFFFFF"
        d="M 447,215 L 448,642 L 452,674 L 461,710 L 476,744 L 493,768 L 510,784 L 524,793 L 556,805 L 582,809 L 616,809 L 642,804 L 668,793 L 691,774 L 708,750 L 727,707 L 836,804 L 923,805 L 771,669 L 824,494 L 905,267 L 974,266 L 975,805 L 1027,805 L 1027,267 L 1124,266 L 1124,216 L 875,216 L 777,487 L 733,629 L 732,216 L 681,216 L 681,638 L 677,673 L 667,710 L 658,727 L 641,745 L 618,755 L 586,756 L 559,749 L 539,736 L 519,711 L 507,682 L 499,633 L 499,215 Z"
      />
    </svg>
  );
}

export default UktLogoMark;
