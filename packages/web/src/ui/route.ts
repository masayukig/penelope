// Where the screen is, kept in the address after its # so that a place and
// each page of the activity record can be opened from a link, and the
// browser's back goes where it was. The backend serves only the page at /
// (docs/ui-api.md, "Web UI の配り方"), so nothing goes in the path.
//
//   #/talk                       the conversation (also the empty address)
//   #/talk?reply=<id>&before=<c> the conversation at one of her replies
//   #/record                     the activity record's list
//   #/record/turns/<id>          one turn
//   #/record/nights/<id>         one nightly switch
//   #/record/sub-agents/<name>   one sub-agent that was closed
//   #/memory  #/events  #/settings
import { useCallback, useSyncExternalStore } from "react";

import type { Place } from "./places.tsx";

export type RecordPage = { kind: "turn" | "night" | "sub_agent"; id: string };

export type Route =
  | { place: "talk"; reply?: { id: string; before: string } }
  | { place: "log"; page?: RecordPage }
  | { place: Exclude<Place, "talk" | "log"> };

const NAMES: Record<Place, string> = { talk: "talk", log: "record", memory: "memory", events: "events", settings: "settings" };
const PAGES: Record<RecordPage["kind"], string> = { turn: "turns", night: "nights", sub_agent: "sub-agents" };

export function parseRoute(hash: string): Route {
  const [path = "", search = ""] = hash.replace(/^#\/?/, "").split("?", 2);
  const [name, kind, id, ...rest] = path.split("/");
  if (name === "record") {
    const page = (Object.keys(PAGES) as Array<RecordPage["kind"]>).find((k) => PAGES[k] === kind);
    if (page !== undefined && id !== undefined && id !== "" && rest.length === 0) return { place: "log", page: { kind: page, id: decodeURIComponent(id) } };
    return { place: "log" };
  }
  const place = (Object.keys(NAMES) as Place[]).find((p) => NAMES[p] === name);
  if (place === undefined || place === "talk") {
    const query = new URLSearchParams(search);
    const reply = query.get("reply");
    const before = query.get("before");
    return reply !== null && before !== null ? { place: "talk", reply: { id: reply, before } } : { place: "talk" };
  }
  return { place } as Route;
}

export function hashOf(route: Route): string {
  if (route.place === "log" && route.page !== undefined) return `#/record/${PAGES[route.page.kind]}/${encodeURIComponent(route.page.id)}`;
  if (route.place === "talk" && route.reply !== undefined) return `#/talk?${new URLSearchParams({ reply: route.reply.id, before: route.reply.before })}`;
  return `#/${NAMES[route.place]}`;
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}

/** The route of the address now, and a way to go to another. */
export function useRoute(): [Route, (route: Route) => void] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const go = useCallback((route: Route) => {
    window.location.hash = hashOf(route);
  }, []);
  return [parseRoute(hash), go];
}
