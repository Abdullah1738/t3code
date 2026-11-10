import { askFieldKind } from "@t3tools/client-runtime/ardud/kanban";
import { kanbanAskChanges, kanbanAskResponse, type KanbanAskFeedItem } from "@t3tools/contracts";

import { cn } from "../../../lib/utils";
import { askKey, useAskStore } from "./askStore";
import { Btn, linkClass, type PageLayout } from "./ui";

const GIVE: ReadonlyArray<readonly [part: string, how: string]> = [
  ["Approve or reject", "The labels can say what happens: Deploy, Passes, Done."],
  ["Choose", "One or many. An option can carry a picture or a chart."],
  ["Fill in", "A small form, checked as you type. A secret is masked and never stored."],
  ["Edit", "The draft is edited in place, then approved."],
  ["Do it yourself", "Steps only you can do: Done or Couldn't."],
  ["Just seen", "A notice. It never blocks and is never counted."],
];

const SHOW: ReadonlyArray<readonly [part: string, how: string]> = [
  ["Text", "Plain or folded away under a title."],
  ["Pictures and video", "Open full size: zoom, pan, step through."],
  ["Audio, PDFs and files", "Play or open in place. Any type can be saved."],
  ["Charts and pages", "Drawn live, with Expand. A chart can hand back a value."],
  ["A command", "Exactly what runs, where, the evidence and the way back."],
  ["Changes", "After, Before, Changes or Side by side."],
  ["A linked card", "Opens beside the ask."],
];

type Match = (entry: KanbanAskFeedItem) => boolean;
const kind =
  (name: string): Match =>
  (entry) =>
    entry.kind === name;
const field =
  (name: string): Match =>
  (entry) =>
    kanbanAskResponse(entry.ask).fields.some((candidate) => askFieldKind(candidate) === name);

const KINDS: ReadonlyArray<readonly [name: string, shows: string, gives: string, match: Match]> = [
  ["Action", "The command, where, evidence, undo", "Approve or reject", kind("action")],
  ["Draft", "The text where it will land", "Edit, then approve", kind("draft")],
  ["Decision", "The question", "Choose", kind("decision")],
  ["Change", "Before, after and the difference", "Approve or reject", kind("change")],
  ["Question", "The question", "One answer", kind("question")],
  ["Secret", "What the key or code is for", "Fill in, masked", field("secret")],
  ["File", "Which file", "A file", field("file")],
  ["Input", "The question", "A few fields", kind("input")],
  ["Task", "The steps and a link", "Done or Couldn't", kind("task")],
  ["Sign-off", "Screenshots or a recording", "Passes or Fails", kind("signoff")],
  ["Rank", "The things to order", "An order", field("rank")],
  [
    "Design pick",
    "The options as pictures",
    "Choose",
    (entry) =>
      (kanbanAskResponse(entry.ask).choose?.options ?? []).some(
        (option) => option.block !== undefined,
      ),
  ],
  ["Notice", "What happened", "Seen", (entry) => kanbanAskResponse(entry.ask).ack],
  [
    "Several changes",
    "Two or three changes, one at a time",
    "Approve or reject",
    (entry) => kanbanAskChanges(entry.ask).length > 1,
  ],
  [
    "Action with a choice",
    "The command",
    "Choose when, then approve",
    (entry) => entry.kind === "action" && kanbanAskResponse(entry.ask).choose !== null,
  ],
  ["Value from a chart", "A chart you can move", "The value you picked", field("custom")],
];

function Parts(props: { title: string; rows: ReadonlyArray<readonly [string, string]> }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{props.title}</h2>
      <dl className="grid grid-cols-[minmax(0,11rem)_minmax(0,1fr)] gap-x-5 gap-y-2 max-sm:grid-cols-1 max-sm:gap-y-0.5">
        {props.rows.map(([part, how]) => (
          <div key={part} className="contents">
            <dt className="font-medium max-sm:mt-2">{part}</dt>
            <dd className="text-(--m-muted)">{how}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** What an ask can show and what he can give back, with a live one of each kind when the queue has it. */
export function ReferenceView(props: {
  layout: PageLayout;
  onBack: () => void;
  onOpenAsk: (key: string) => void;
}) {
  const open = useAskStore((state) => state.feed?.open);
  const example = (match: Match) =>
    (open ?? []).find((entry) => entry.waitsOn === "owner" && match(entry));
  return (
    <div
      data-ny-enter
      className={cn(
        "min-h-0 flex-1 overflow-y-auto overscroll-contain",
        props.layout === "phone" ? "px-4 py-5" : "px-7 py-6",
      )}
    >
      <div className="flex max-w-[760px] flex-col gap-8 text-sm">
        <p className="text-base text-pretty">
          An ask is what it shows you and what you give back. Agents combine the parts they need,
          and the page lays them out the same way every time.
        </p>
        <Parts title="What you can give back" rows={GIVE} />
        <Parts title="What an ask can show" rows={SHOW} />
        <section className="flex flex-col gap-3">
          <h2 className="text-base font-semibold">Named kinds</h2>
          <table className="w-full border-collapse text-start">
            <thead className="max-sm:sr-only">
              <tr className="text-xs text-(--m-muted)">
                <th scope="col" className="pb-1.5 text-start font-normal">
                  Kind
                </th>
                <th scope="col" className="pb-1.5 text-start font-normal">
                  Shows
                </th>
                <th scope="col" className="pb-1.5 text-start font-normal">
                  You give back
                </th>
                <th scope="col" className="sr-only">
                  Example
                </th>
              </tr>
            </thead>
            <tbody>
              {KINDS.map(([name, shows, gives, match]) => {
                const live = example(match);
                return (
                  <tr
                    key={name}
                    className="border-t border-(--m-rule) align-baseline max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:py-2"
                  >
                    <th scope="row" className="py-2 pe-4 text-start font-medium max-sm:py-0">
                      {name}
                    </th>
                    <td className="py-2 pe-4 text-(--m-muted) max-sm:col-start-1 max-sm:py-0">
                      {shows}
                    </td>
                    <td className="py-2 pe-4 max-sm:col-start-1 max-sm:py-0">{gives}</td>
                    <td className="py-2 text-end whitespace-nowrap max-sm:col-start-2 max-sm:row-span-3 max-sm:row-start-1 max-sm:py-0">
                      {live ? (
                        <button
                          type="button"
                          aria-label={`See an open ${name} ask`}
                          onClick={() => props.onOpenAsk(askKey(live))}
                          className={linkClass}
                        >
                          See one
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-(--m-muted)">A kind with no name here is drawn from the same parts.</p>
        </section>
        <Btn size="sm" onClick={props.onBack} className="self-start">
          Back to Needs you
        </Btn>
      </div>
    </div>
  );
}
