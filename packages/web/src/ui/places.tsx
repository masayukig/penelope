// The places of the left: what changes the middle of the screen. Only the
// conversation has anything in it in the first version.
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

export function PlaceItems({ place, onChange }: { place: Place; onChange: (place: Place) => void }) {
  return (
    <>
      {PLACES.map(([name, icon]) => (
        <SideNavItem key={name} label={words.places[name]} icon={icon} isSelected={place === name} onClick={() => onChange(name)} />
      ))}
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
