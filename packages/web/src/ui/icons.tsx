// The line icons of the design (docs/design/), as Astryx takes them: an SVG
// component its parent sizes and colors.
import type { SVGProps } from "react";

type Props = SVGProps<SVGSVGElement>;
const base = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, "aria-hidden": true } as const;

export const TalkIcon = (props: Props) => (
  <svg {...base} strokeLinejoin="round" {...props}>
    <path d="M4 5h16v11H9l-5 4V5z" />
  </svg>
);
export const LogIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);
export const MemoryIcon = (props: Props) => (
  <svg {...base} strokeLinejoin="round" {...props}>
    <path d="M5 4h11l3 3v13H5V4z" />
    <path d="M9 10h6M9 14h6" strokeLinecap="round" />
  </svg>
);
export const EventsIcon = (props: Props) => (
  <svg {...base} strokeLinejoin="round" {...props}>
    <path d="M4 13l3-8h10l3 8v6H4v-6z" />
    <path d="M4 13h5l1 2h4l1-2h5" />
  </svg>
);
export const SettingsIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" {...props}>
    <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="8" cy="17" r="2" />
  </svg>
);
export const MenuIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" {...props}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </svg>
);
export const AttachIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3L14.5 7" />
  </svg>
);
export const ReconnectIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v5h-5" />
  </svg>
);
export const ChevronUpIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M6 15l6-6 6 6" />
  </svg>
);
/** Stopped and waiting: two bars, filled, so that it is told from the running dot by its shape. */
export const PauseIcon = (props: Props) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
    <rect x="6" y="4" width="4" height="16" rx="1.5" />
    <rect x="14" y="4" width="4" height="16" rx="1.5" />
  </svg>
);
export const LogoutIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M10 4H5v16h5" />
    <path d="M14 8l4 4-4 4M18 12H9" />
  </svg>
);
export const BellIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
  </svg>
);
export const BellOffIcon = (props: Props) => (
  <svg {...base} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15L6 16z" />
    <path d="M10 20.5a2 2 0 0 0 4 0" />
    <path d="M4 4l16 16" />
  </svg>
);
export const RepeatIcon = (props: Props) => (
  <svg {...base} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" {...props}>
    <path d="M17 3l4 4-4 4" />
    <path d="M3 11V9a2 2 0 0 1 2-2h16" />
    <path d="M7 21l-4-4 4-4" />
    <path d="M21 13v2a2 2 0 0 1-2 2H3" />
  </svg>
);
