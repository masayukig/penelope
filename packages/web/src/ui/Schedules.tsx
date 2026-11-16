// Her schedules (docs/ui-api.md, "予約"), in the place of the events: each
// with how it comes and when it comes next, and a button that removes it once
// the owner confirms. She is not told; nothing here adds one.
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Code } from "@astryxdesign/core/Code";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Heading } from "@astryxdesign/core/Heading";
import { Item } from "@astryxdesign/core/Item";
import { useCallback, useEffect, useState } from "react";

import type { ScheduleEntry } from "@penelope/contract";

import { type Api, Refused, Unauthorized } from "../model/api.ts";
import { dueOf, words } from "./words.ts";

export type SchedulesProps = {
  api: Api;
  onUnauthorized: () => void;
  /** Room at the top for what floats over it (the phone's avatar). */
  topInset?: boolean;
};

export function Schedules({ api, onUnauthorized, topInset = false }: SchedulesProps) {
  const [schedules, setSchedules] = useState<ScheduleEntry[] | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [asked, setAsked] = useState<ScheduleEntry | undefined>(undefined);
  const [removing, setRemoving] = useState(false);

  const fail = useCallback(
    (error: unknown, word: string) => {
      if (error instanceof Unauthorized) onUnauthorized();
      else setFailed(word);
    },
    [onUnauthorized],
  );
  const read = useCallback(async () => {
    try {
      setSchedules((await api.schedules()).schedules);
    } catch (error) {
      fail(error, words.schedulesFailed);
    }
  }, [api, fail]);
  useEffect(() => {
    void read();
  }, [read]);

  const remove = async (schedule: ScheduleEntry) => {
    setRemoving(true);
    setFailed(undefined);
    try {
      await api.removeSchedule(schedule.id);
      setSchedules((now) => now?.filter((s) => s.id !== schedule.id));
    } catch (error) {
      // Gone already: she removed it, or it came due. What is left is read again.
      if (error instanceof Refused && error.status === 404) await read();
      else fail(error, words.scheduleRemoveFailed);
    } finally {
      setRemoving(false);
      setAsked(undefined);
    }
  };

  return (
    <div className={topInset ? "page page-inset" : "page"}>
      <section className="page-body" aria-labelledby="schedules-heading">
        <Heading level={1}>
          <span id="schedules-heading">{words.schedules}</span>
        </Heading>
        {failed === undefined ? null : <Banner status="error" title={failed} />}
        {schedules === undefined ? null : schedules.length === 0 ? (
          <EmptyState title={words.schedulesNone} description={words.schedulesNoneBody} headingLevel={2} />
        ) : (
          <ul className="schedules" aria-label={words.schedules}>
            {schedules.map((schedule) => (
              <Item
                key={schedule.id}
                as="li"
                label={schedule.reason}
                labelLines={2}
                description={<When schedule={schedule} />}
                endContent={<Button label={words.scheduleRemove} variant="secondary" size="sm" onClick={() => setAsked(schedule)} />}
              />
            ))}
          </ul>
        )}
      </section>
      <AlertDialog
        isOpen={asked !== undefined}
        onOpenChange={(open) => {
          if (!open && !removing) setAsked(undefined);
        }}
        title={words.scheduleConfirm}
        description={asked === undefined ? "" : words.scheduleConfirmBody(asked.reason)}
        actionLabel={words.scheduleRemove}
        cancelLabel={words.scheduleKeep}
        isActionLoading={removing}
        onAction={() => {
          if (asked !== undefined) void remove(asked);
        }}
      />
    </div>
  );
}

/** A cron one: its expression and when next. A one-time one: when. */
function When({ schedule }: { schedule: ScheduleEntry }) {
  if (schedule.cron !== undefined) {
    return (
      <span className="schedule-when">
        <Code color="inherit">{schedule.cron}</Code>
        <span>
          {words.scheduleNext} {dueOf(schedule.next_at)}
        </span>
      </span>
    );
  }
  return (
    <span className="schedule-when">
      <span>
        {words.scheduleOnce} {dueOf(schedule.next_at)}
      </span>
    </span>
  );
}
