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
