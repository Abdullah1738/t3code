import { MissionError, type MissionId, type Note } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { MissionEditor } from "./core/ports.ts";
import * as MissionService from "./MissionService.ts";
import * as ScribeService from "./scribe/ScribeService.ts";
import * as MissionStore from "./store/MissionStore.ts";

const toMissionError = (error: ScribeService.ScribeError): MissionError =>
  error._tag === "MissionError"
    ? error
    : new MissionError({
        code: "invalid",
        detail: `The editor could not be read: ${error.message}`,
      });

/** Best-first lists from several missions, taken in turns so no mission crowds out the rest. */
const interleave = (lists: ReadonlyArray<ReadonlyArray<Note>>, limit: number): Note[] => {
  const out: Note[] = [];
  for (let index = 0; out.length < limit; index += 1) {
    const round = lists.flatMap((list) => (index < list.length ? [list[index]!] : []));
    if (round.length === 0) break;
    out.push(...round.slice(0, limit - out.length));
  }
  return out;
};

/**
 * The scribe as the missions editor: its bottom line and feed for the
 * overview, its ranked FYI notes for the inbox. Scribe ranking already drops
 * notes whose citations failed and notes the owner acked.
 */
export const makeScribeEditor = (
  scribe: ScribeService.ScribeService["Service"],
  store: MissionStore.MissionStore["Service"],
): MissionEditor => {
  const fyiOf = (missionId: MissionId, limit: number) =>
    scribe.fyi(missionId, limit).pipe(Effect.mapError(toMissionError));
  return {
    view: (missionId) =>
      scribe.editorView(missionId).pipe(
        Effect.mapError(toMissionError),
        Effect.map((view) =>
          view === null
            ? null
            : {
                bottomLine: view.bottomLine ?? "",
                bottomLineAt: view.bottomLine === null ? null : view.bottomLineAt,
                feed: view.feed.length === 0 ? null : view.feed,
              },
        ),
      ),
    fyi: (missionId, limit) =>
      missionId !== null
        ? fyiOf(missionId, limit)
        : Effect.gen(function* () {
            const missions = yield* store.list("mission", {});
            const live = missions.filter((mission) => mission.status !== "archived");
            const lists = yield* Effect.forEach(live, (mission) => fyiOf(mission.id, limit));
            return interleave(lists, limit);
          }),
  };
};

/** Registers the scribe with core when the missions layer starts. */
export const editorWiringLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const missions = yield* MissionService.MissionService;
    const scribe = yield* ScribeService.ScribeService;
    const store = yield* MissionStore.MissionStore;
    yield* missions.registerEditor(makeScribeEditor(scribe, store));
  }),
);
