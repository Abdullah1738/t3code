/**
 * "What an ask can be": every part an ask can show and every part he can give
 * back, drawn by the page's own components from sample asks, beside the words
 * agents are given about asking.
 */
import {
  ASK_REFERENCE_KINDS,
  ASK_REFERENCE_MOST_USED,
  ASK_REFERENCE_TOLD,
  askFieldKind,
  askFormFor,
  type AskForm,
  type AskReferenceMatch,
  type ChangeView,
} from "@t3tools/client-runtime/ardud/kanban";
import { kanbanAskResponse, type KanbanAskFeedItem, type KanbanOwnerAsk } from "@t3tools/contracts";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { ActionDetails } from "./ActionDetails";
import { OptionList, TaskSteps } from "./AnswerParts";
import { AskBlocks, askMediaOf } from "./AskBlocks";
import { FieldRow } from "./AskFields";
import { askKey, useAskStore } from "./askStore";
import { ChangeViewer } from "./ChangeView";
import { DraftPart } from "./DraftPart";
import { MediaViewer } from "./MediaViewer";
import {
  SAMPLE_ACTION,
  SAMPLE_CHANGES,
  SAMPLE_CHOOSE,
  SAMPLE_DRAFT,
  SAMPLE_FILL,
  SAMPLE_TASK,
  makeSampleFiles,
  showSamples,
  type SampleFiles,
  type ShowSample,
} from "./referenceSamples";
import { Bar, Btn, Label, linkClass, type PageLayout } from "./ui";

const KINDS = ASK_REFERENCE_KINDS;
const MOST_USED = ASK_REFERENCE_MOST_USED;
const TOLD = ASK_REFERENCE_TOLD;
type Match = AskReferenceMatch;

const NO_BLOCKS: ReadonlySet<number> = new Set();

function Section(props: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="flex min-w-0 flex-col">
      <h2 className="text-xl font-semibold text-balance">{props.title}</h2>
      {props.sub ? <p className="mt-0.5 mb-1 text-pretty text-(--m-muted)">{props.sub}</p> : null}
      {props.children}
    </section>
  );
}

/** One part: its name and a line about it, beside the part itself. */
function Part(props: { name: string; how?: string; children: ReactNode }) {
  return (
    <div className="grid min-w-0 gap-x-6 gap-y-2.5 border-t border-(--m-rule) py-4 first-of-type:border-t-0 @2xl:grid-cols-[10rem_minmax(0,1fr)]">
      <div className="min-w-0">
        <h3 className="font-medium">{props.name}</h3>
        {props.how ? <p className="text-pretty text-(--m-muted)">{props.how}</p> : null}
      </div>
      <div className="min-w-0 text-base">{props.children}</div>
    </div>
  );
}

/** What he has typed into a sample, kept like any ask's form; nothing sends it. */
const useSampleForm = (entry: KanbanAskFeedItem): AskForm => {
  const stored = useAskStore((state) => state.forms[askKey(entry)]);
  return stored ?? askFormFor(entry.ask);
};

function ChooseSample() {
  const form = useSampleForm(SAMPLE_CHOOSE);
  const choose = kanbanAskResponse(SAMPLE_CHOOSE.ask).choose;
  if (choose === null) return null;
  return (
    <OptionList
      entry={SAMPLE_CHOOSE}
      choose={choose}
      ownWords
      form={form}
      problem={undefined}
      disabled={false}
    />
  );
}

function FillSample() {
  const form = useSampleForm(SAMPLE_FILL);
  // A sample secret lives here only, like a real one lives in its reader only.
  const [secret, setSecret] = useState("");
  return (
    <div className="grid min-w-0 gap-x-5 gap-y-4 @xl:grid-cols-2">
      {kanbanAskResponse(SAMPLE_FILL.ask).fields.map((entry) => {
        const type = askFieldKind(entry);
        return (
          <div
            key={entry.id}
            className={cn("min-w-0", (type === "custom" || type === "file") && "@xl:col-span-2")}
          >
            <FieldRow
              entry={SAMPLE_FILL}
              ask={SAMPLE_FILL.ask}
              field={entry}
              value={form.values[entry.id]}
              required={false}
              problem={undefined}
              // A sample has no card to keep a file on.
              disabled={type === "file"}
              secret={secret}
              onSecret={setSecret}
            />
          </div>
        );
      })}
    </div>
  );
}

function DraftSample() {
  const form = useSampleForm(SAMPLE_DRAFT);
  const draft = SAMPLE_DRAFT.ask.draft;
  if (!draft) return null;
  return <DraftPart entry={SAMPLE_DRAFT} draft={draft} form={form} editable problem={undefined} />;
}

function TaskSample() {
  const form = useSampleForm(SAMPLE_TASK);
  const task = kanbanAskResponse(SAMPLE_TASK.ask).task;
  if (task === null) return null;
  return <TaskSteps entry={SAMPLE_TASK} steps={task.steps} form={form} disabled={false} />;
}

/** Buttons to look at, not to press: the real ones sit in the bar under an ask. */
function Buttons(props: { yes: string; no?: string }) {
  return (
    <div inert className="flex flex-wrap gap-2">
      <Btn tone="primary">{props.yes}</Btn>
      {props.no ? <Btn tone="ghost">{props.no}</Btn> : null}
    </div>
  );
}

function ChangeSample(props: { wide: boolean }) {
  const [view, setView] = useState<ChangeView>("diff");
  const [index, setIndex] = useState(0);
  return (
    <ChangeViewer
      changes={SAMPLE_CHANGES}
      view={view}
      onView={setView}
      index={index}
      onIndex={setIndex}
      wide={props.wide}
    />
  );
}

/** One kind of block, drawn by the reader's own block component, with its own full-size viewer. */
function ShowBlocks(props: { sample: ShowSample; onOpenCard: () => void }) {
  const { sample } = props;
  const media = askMediaOf(sample.blocks, sample.urlOf, sample.fileOf);
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <>
      <AskBlocks
        ask={{ blocks: sample.blocks } as KanbanOwnerAsk}
        media={media}
        skip={NO_BLOCKS}
        onOpenMedia={setViewing}
        onOpenCard={props.onOpenCard}
      />
      {viewing !== null && media.items.length > 0 ? (
        <MediaViewer
          items={media.items}
          index={viewing}
          onIndex={setViewing}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </>
  );
}

export function ReferenceView(props: {
  layout: PageLayout;
  onBack: () => void;
  onOpenAsk: (key: string) => void;
  onOpenCard: (entry: KanbanAskFeedItem) => void;
}) {
  const open = useAskStore((state) => state.feed?.open);
  const example = (match: Match) =>
    (open ?? []).find((entry) => entry.waitsOn === "owner" && match(entry));
  // A real card for the linked-card sample to open, when the queue has one.
  const anyAsk = open?.[0];

  const [files, setFiles] = useState<SampleFiles | null>(null);
  useEffect(() => {
    const made = makeSampleFiles();
    // oxlint-disable-next-line react/set-state-in-effect -- The files' URLs exist only while this effect holds them.
    setFiles(made);
    return made.revoke;
  }, []);

  return (
    <div
      data-ny-enter
      className={cn(
        "@container min-h-0 flex-1 overflow-y-auto overscroll-contain",
        props.layout === "phone" ? "px-4 py-5" : "px-7 py-6",
      )}
    >
      <div className="flex max-w-[1080px] min-w-0 flex-col gap-9 text-sm">
        <p className="max-w-[640px] text-base text-pretty">
          An ask is what it shows you and what you give back. Agents combine the parts they need,
          and the page lays them out the same way every time.
        </p>

        <div className="grid min-w-0 items-start gap-x-8 gap-y-9 @5xl:grid-cols-[minmax(0,1fr)_20rem]">
          <Section
            title="What you can give back"
            sub="Always in this order: steps, options, fields, then the buttons."
          >
            <Part name="Approve or reject" how="The labels can say what happens.">
              <Buttons yes="Deploy" no="Don't deploy" />
            </Part>
            <Part name="Choose" how="One or many. An option can carry a picture.">
              <ChooseSample />
            </Part>
            <Part name="Fill in" how="A small form, checked before it sends.">
              <FillSample />
            </Part>
            <Part name="Edit" how="The draft is edited in place, then approved.">
              <DraftSample />
            </Part>
            <Part name="Do it yourself" how="Steps only you can do.">
              <TaskSample />
            </Part>
            <Part name="Just seen" how="A notice. It never blocks.">
              <Buttons yes="Seen" />
            </Part>
          </Section>

          <aside
            aria-label="What agents are told"
            // Beside the parts it stays in view and scrolls by itself when it is taller than the window;
            // in one wide column it comes first, as in the demo. On a phone the parts lead.
            className="min-w-0 @2xl:order-first rounded-2xl bg-(--m-surface) p-4 @5xl:sticky @5xl:top-0 @5xl:order-none @5xl:max-h-[calc(100dvh-7.5rem)] @5xl:overflow-y-auto @5xl:overscroll-contain"
          >
            <Label className="mb-2.5">
              What agents are told, in the <span translate="no">card_ask</span> tool description
            </Label>
            <ol className="flex list-decimal flex-col gap-2 ps-5 marker:text-(--m-muted) marker:tabular-nums">
              {TOLD.map((sentence) => (
                <li key={sentence} className="ps-1 text-pretty [overflow-wrap:anywhere]">
                  {sentence}
                </li>
              ))}
            </ol>
          </aside>
        </div>

        <Section
          title="Shortcuts"
          sub="Named combinations agents reach for. A new kind needs no new screen."
        >
          <table className="mt-2 w-full border-collapse text-start">
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
                          onClick={() => props.onOpenAsk(askKey(live))}
                          className={linkClass}
                        >
                          See one<span className="sr-only">: an open {name} ask</span>
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Section>

        <Section title="The five most used, and what an agent fills in">
          {MOST_USED.map((template) => {
            const live = example(template.match);
            return (
              <Part key={template.name} name={template.name} how={template.use}>
                <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
                  {template.fills.map(([what, how]) => (
                    <div key={what} className="contents">
                      <dt>{what}</dt>
                      <dd className="text-(--m-muted)">{how}</dd>
                    </div>
                  ))}
                </dl>
                <p className="mt-2.5 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
                  {template.answer}
                  {live ? (
                    <button
                      type="button"
                      onClick={() => props.onOpenAsk(askKey(live))}
                      className={linkClass}
                    >
                      See a real one
                    </button>
                  ) : null}
                </p>
              </Part>
            );
          })}
        </Section>

        <Section
          title="What an ask can show"
          sub="Any of these, in any order. Pictures, recordings and documents open full size."
        >
          <Part name="A command" how="Exactly what runs, where, the proof and the way back.">
            <ActionDetails action={SAMPLE_ACTION} />
          </Part>
          <Part name="Changes" how="After, Before, Changes or Side by side.">
            <ChangeSample wide={props.layout !== "phone"} />
          </Part>
          {files === null ? (
            <Part name="Text">
              <Bar className="h-4 w-2/3" />
            </Part>
          ) : (
            showSamples(files, anyAsk?.cardId ?? null).map((sample) => (
              <Part key={sample.label} name={sample.label}>
                <ShowBlocks
                  sample={sample}
                  onOpenCard={() => (anyAsk ? props.onOpenCard(anyAsk) : undefined)}
                />
              </Part>
            ))
          )}
        </Section>

        <Btn size="sm" onClick={props.onBack} className="self-start">
          Back to Needs you
        </Btn>
      </div>
    </div>
  );
}
