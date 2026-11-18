// The places of the left: what changes the middle of the screen. The
// activity record carries the count of the failures the owner has not seen.
import { Badge } from "@astryxdesign/core/Badge";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { SideNavItem } from "@astryxdesign/core/SideNav";
import type { ComponentType, SVGProps } from "react";

import { EventsIcon, LogIcon, MemoryIcon, SettingsIcon, TalkIcon } from "./icons.tsx";
import { words } from "./words.ts";

export type Place = keyof typeof words.places;

const PLACES: Array<[Place, ComponentType<SVGProps<SVGSVGElement>>]> = [
  ["talk", TalkIcon],
  ["log", LogIcon],
  ["memory", MemoryIcon],
  ["events", EventsIcon],
  ["settings", SettingsIcon],
];

export function PlaceItems({
  place,
  onChange,
  unseen = 0,
  folded = false,
}: {
  place: Place;
  onChange: (place: Place) => void;
  /** The failures of the activity record not seen: its count beside it, or on its icon while the rail is folded. */
  unseen?: number;
  folded?: boolean;
}) {
  return (
    <>
      {PLACES.map(([name, icon]) => {
        const counted = name === "log" && unseen > 0;
        return (
          <SideNavItem
            key={name}
            label={words.places[name]}
            icon={icon}
            isSelected={place === name}
            onClick={() => onChange(name)}
            {...(counted
              ? {
                  "aria-label": words.record.railLabel(unseen),
                  // The folded rail shows no end content: the count goes on the icon (styles.css).
                  ...(folded ? { "data-unseen": unseen > 99 ? "99+" : String(unseen) } : { endContent: <Badge variant="error" label={String(unseen)} /> }),
                }
              : {})}
          />
        );
      })}
    </>
  );
}

/** A place still to be made. */
export function Placeholder({ place }: { place: Place }) {
  return (
    <div className="placeholder">
      <EmptyState title={`${words.places[place]}: ${words.placeholderTitle}`} description={words.placeholderBody} headingLevel={1} />
    </div>
  );
}
