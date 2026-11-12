/**
 * A file for an answer is written to the server three times over: its upload
 * is created, its bytes are sent, and a copy nobody holds is deleted. Each of
 * those is the owner's alone, as the answer is. This drives the real field,
 * the real upload helper and the shared upload cycle over a faked server and
 * file system, with a real ask scope whose connection and session change
 * under an upload that is on its way.
 */
import { askFormOf } from "@t3tools/client-runtime/ardud/kanban";
import type { KanbanAskFeedItem, KanbanAskField } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

interface PressProps {
  readonly accessibilityLabel?: string;
  readonly disabled?: boolean;
  readonly onPress?: () => void;
  readonly children?: ReactNode;
}
type Minted = {
  readonly _tag: "Success";
  readonly value: { readonly attachmentId: string; readonly relativeUrl: string };
};

const ui = vi.hoisted(() => ({
  presses: new Map<string, { onPress?: () => void; disabled?: boolean }>(),
  scope: { current: null as unknown },
  /** What the picker gives back. */
  picked: [] as Array<unknown>,
  /** Upload creations asked of the server, and how each one ends. */
  mints: [] as Array<unknown>,
  mint: (): Promise<unknown> => Promise.resolve(undefined),
  /** Addresses bytes were sent to, and how a transfer ends. */
  sent: [] as Array<string>,
  transfer: (): Promise<{ status: number }> => Promise.resolve({ status: 200 }),
  /** Uploads the server was told to delete. */
  deletes: [] as Array<string>,
  /** The connection may operate on the server: the helper's own check. It stays true throughout. */
  operate: true,
  configs: new Map<string, unknown>([
    [
      "A",
      {
        environment: {
          capabilities: {
            attachmentUploads: true,
            fileAttachments: { maxUploadBytes: 10_000_000 },
          },
        },
      },
    ],
  ]),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: PressProps) => {
    if (props.accessibilityLabel !== undefined) {
      ui.presses.set(props.accessibilityLabel, {
        ...(props.onPress === undefined ? {} : { onPress: props.onPress }),
        ...(props.disabled === undefined ? {} : { disabled: props.disabled }),
      });
    }
    return <button type="button">{props.children}</button>;
  },
  Platform: { OS: "ios" },
  AccessibilityInfo: { announceForAccessibility: () => undefined },
}));
vi.mock("@expo/ui/community/datetime-picker", () => ({ DateTimePicker: () => null }));
vi.mock("../../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../../components/ui/ThemedSwitch", () => ({ ThemedSwitch: () => null }));
vi.mock("../../../lib/cn", () => ({ cn: () => "" }));
vi.mock("../../../lib/composerImages", () => ({
  pickComposerFiles: async () => ({ files: ui.picked }),
  pickComposerMedia: async () => ({ attachments: ui.picked }),
  isComposerImageAttachment: (attachment: { type: string }) => attachment.type === "image",
  isFileBackedComposerAttachment: (attachment: { fileUri?: string }) =>
    attachment.fileUri !== undefined,
}));
vi.mock("../../../state/entities", () => ({ useServerConfigs: () => ui.configs }));
vi.mock("../../../state/use-composer-drafts", () => ({
  releaseUnusedComposerAttachmentFiles: async () => undefined,
}));
vi.mock("./AskBlocks", () => ({ AskHtml: () => null }));
vi.mock("./askStore", () => ({
  useAskScope: () => ui.scope.current,
  useAsks: () => (ui.scope.current as { asks: unknown }).asks,
}));
vi.mock("./ui", () => ({
  AskInput: () => null,
  Check: () => null,
  FieldLabel: ({ label }: { label: string }) => <span>{label}</span>,
  GrowingInput: () => null,
  Pill: ({ label }: { label: string }) => <span>{label}</span>,
  Problem: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
  tapSelection: () => undefined,
}));

// What the upload helper stands on: the server's two attachment calls, the
// connection, and the file system that sends the bytes.
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  runAtomCommand: async (
    _registry: unknown,
    command: unknown,
    payload: { readonly input: { readonly attachmentId?: string } },
  ) => {
    if (command === "CREATE") {
      ui.mints.push(payload.input);
      return ui.mint();
    }
    if (command === "REMOVE") {
      ui.deletes.push(String(payload.input.attachmentId));
      return { _tag: "Success", value: undefined };
    }
    throw new Error("an unexpected server call");
  },
  executeAtomQuery: async () => ({ _tag: "Success", value: undefined }),
  createEnvironmentRpcCommand: () => undefined,
  squashAtomCommandFailure: (result: unknown) => result,
}));
vi.mock("@t3tools/client-runtime/state/assets", () => ({
  resolveAssetUrl: (base: string, relative: string) => `${base}${relative}`,
}));
vi.mock("../../../state/atom-registry", async () => {
  const Option = await import("effect/Option");
  return {
    appAtomRegistry: { get: () => Option.some({ httpBaseUrl: "https://a.test" }) },
  };
});
vi.mock("../../../state/assets", () => ({ assetEnvironment: { createUrl: "ASSET" } }));
vi.mock("../../../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: "CREATE", remove: "REMOVE" },
}));
vi.mock("../../../state/session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => "PREPARED" },
  readEnvironmentScope: () => ui.operate,
}));
vi.mock("../../../lib/composerAttachmentFiles", () => ({
  resolveOwnedComposerAttachmentFileUri: () => null,
}));
vi.mock("../../../lib/composerAttachmentPreviewRetention", () => ({
  retainComposerAttachmentFileForPreview: () => () => undefined,
}));
vi.mock("../../../lib/uuid", () => ({ uuidv4: () => "local-1" }));
vi.mock("expo-file-system", () => ({
  File: class {
    readonly exists = false;
    upload(url: string) {
      ui.sent.push(url);
      return ui.transfer();
    }
  },
  Paths: { cache: "", document: { uri: "" } },
  UploadType: { BINARY_CONTENT: 0 },
}));

import { FieldRow } from "./AskFields";
import { createAskScopes, type AskConnection } from "./askScope";
import type { SessionRead } from "./logic";

const FIELD = { id: "proof", label: "Proof", type: "file", maxFiles: 2 } as KanbanAskField;
const LOCAL = {
  id: "local-clip",
  type: "file",
  name: "clip.mp4",
  mimeType: "video/mp4",
  sizeBytes: 2048,
  fileUri: "file:///picked/clip.mp4",
};

const wireFeed = () => ({
  at: "2026-11-11T08:00:00.000Z",
  open: [
    {
      boardId: "b1",
      boardSlug: "robob",
      boardName: "Robob",
      cardId: "c1",
      cardNumber: 1,
      cardRef: "robob:1",
      cardTitle: "Card 1",
      stage: "needs_owner",
      priority: 3,
      discussionId: "d1",
      blocks: 0,
      ask: {
        id: "q1",
        text: "Show it working",
        blocking: true,
        by: { _tag: "thread", threadId: "t1" },
        at: "2026-11-11T08:00:00.000Z",
        seq: 1,
        closedAt: null,
        kind: "approval",
        respond: { verdict: {} },
        blocks: [],
      },
      kind: "approval",
      revision: 0,
      waitsOn: "owner",
      expired: false,
      messages: [],
    },
  ],
  closed: [],
});

const OWNER: SessionRead = { state: "read", authenticated: true, owner: true };
const NOT_HIS: SessionRead = { state: "read", authenticated: true, owner: false };

/** A real ask scope over a server whose connection and session the test moves. */
function harness() {
  let session: SessionRead = OWNER;
  let connection: AskConnection = "live";
  const onSession = new Set<() => void>();
  const onConnection = new Set<() => void>();
  const requests: Array<string> = [];
  const fetchFake = (async (_url: string, init?: { method?: string }) => {
    requests.push(init?.method ?? "GET");
    return { ok: true, status: 200, text: async () => JSON.stringify(wireFeed()) };
  }) as unknown as typeof fetch;
  const scopes = createAskScopes({
    paired: () => "A",
    onPairedChange: () => () => undefined,
    target: () => ({
      base: "https://a.test",
      headers: { authorization: "Bearer token-A" },
      cookies: false,
    }),
    sendSecrets: async () => ({ _tag: "sent" }),
    watch: {
      onBoardsChange: () => () => undefined,
      onForeground: () => () => undefined,
      isForeground: () => true,
    },
    session: () => session,
    onSessionChange: (_id, run) => {
      onSession.add(run);
      return () => void onSession.delete(run);
    },
    rereadSession: () => undefined,
    connection: () => connection,
    onConnectionChange: (_id, run) => {
      onConnection.add(run);
      return () => void onConnection.delete(run);
    },
    reconnect: () => undefined,
    defer: () => undefined,
    now: () => Date.now(),
    fetch: fetchFake,
  });
  return {
    scopes,
    requests,
    setSession: (next: SessionRead) => {
      session = next;
      for (const run of onSession) run();
    },
    setConnection: (next: AskConnection) => {
      connection = next;
      for (const run of onConnection) run();
    },
  };
}

type Scope = ReturnType<ReturnType<typeof harness>["scopes"]["current"]>;

/** The field as the ask's screen draws it: its value comes from the store. */
function Field(props: { readonly entry: KanbanAskFeedItem; readonly disabled: boolean }) {
  const scope = ui.scope.current as Scope;
  const value = useSyncExternalStore(
    (run) => scope.cell.subscribe(run),
    () => askFormOf(scope.cell.getState(), props.entry).values[FIELD.id],
  );
  return (
    <FieldRow
      entry={props.entry}
      ask={props.entry.ask}
      field={FIELD}
      value={value}
      required={false}
      problem={undefined}
      disabled={props.disabled}
    />
  );
}

let root: Root;
let page: HTMLDivElement;

/** Lets everything that is on its way come to rest, with nothing left pending. */
const settle = async () => {
  await act(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise((done) => setTimeout(done, 0));
  });
};
const show = async (entry: KanbanAskFeedItem, disabled = false) => {
  await act(async () => root.render(<Field entry={entry} disabled={disabled} />));
};
const press = async (label: string) => {
  const target = ui.presses.get(label);
  if (target?.onPress === undefined) throw new Error(`nothing to press: ${label}`);
  await act(async () => target.onPress?.());
  await settle();
};
const says = () => page.textContent ?? "";
const minted = (id: string): Minted => ({
  _tag: "Success",
  value: { attachmentId: id, relativeUrl: `/uploads/${id}` },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** The ask is read and its field is on screen, on a phone confirmed as his. */
const opened = async () => {
  const h = harness();
  const scope = h.scopes.current();
  ui.scope.current = scope;
  await scope.asks.refreshAsks();
  const entry = scope.cell.getState().feed!.open[0]!;
  await show(entry);
  const attached = () => askFormOf(scope.cell.getState(), entry).values[FIELD.id];
  return { h, scope, entry, attached };
};

/** The connection drops and comes back, and its session says the phone is not his. */
const reconnectsNotHis = (h: ReturnType<typeof harness>) => {
  h.setConnection("down");
  h.setSession({ state: "reading" });
  h.setConnection("live");
  h.setSession(NOT_HIS);
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  page = document.createElement("div");
  root = createRoot(page);
  ui.presses.clear();
  ui.picked = [LOCAL];
  ui.mints = [];
  ui.mint = () => Promise.resolve(minted(`up-${ui.mints.length}`));
  ui.sent = [];
  ui.transfer = () => Promise.resolve({ status: 200 });
  ui.deletes = [];
  ui.operate = true;
});

afterEach(() => {
  act(() => root.unmount());
});

describe("a file for an answer, on a phone confirmed as his", () => {
  it("is created, sent once and becomes part of the answer", async () => {
    const { attached } = await opened();
    await press("Choose a file");
    expect(ui.mints).toHaveLength(1);
    expect(ui.sent).toEqual(["https://a.test/uploads/up-1"]);
    expect(ui.deletes).toEqual([]);
    expect(attached()).toEqual([
      { type: "file", id: "up-1", name: "clip.mp4", mimeType: "video/mp4", sizeBytes: 2048 },
    ]);
    expect(says()).toContain("Added");
  });

  it("taken out again, its copy on the server is deleted, once", async () => {
    const { attached } = await opened();
    await press("Choose a file");
    await press("Remove clip.mp4");
    expect(ui.deletes).toEqual(["up-1"]);
    expect(attached()).toEqual([]);
  });

  it("removed while its upload is being created, the fresh upload is deleted and no byte goes", async () => {
    await opened();
    const mint = deferred<Minted>();
    ui.mint = () => mint.promise;
    await press("Choose a file");
    await press("Remove clip.mp4");
    mint.resolve(minted("up-1"));
    await settle();
    expect(ui.sent).toEqual([]);
    expect(ui.deletes).toEqual(["up-1"]);
  });
});

describe("ownership changes while a file is uploading", () => {
  it("lost while the upload is being created: no byte is sent, nothing is deleted, the file is not attached", async () => {
    const { h, scope, attached } = await opened();
    const mint = deferred<Minted>();
    ui.mint = () => mint.promise;
    await press("Choose a file");
    expect(ui.mints).toHaveLength(1);
    expect(says()).toContain("Uploading");

    // The connection goes and comes back as someone else's. It may still operate
    // on the server: only the scope's gate knows the phone is no longer his.
    reconnectsNotHis(h);
    expect(ui.operate).toBe(true);
    expect(scope.writeBlocked()).not.toBeNull();

    // The server answers the creation that was already on its way.
    mint.resolve(minted("up-1"));
    await settle();
    expect(ui.sent).toEqual([]);
    expect(ui.deletes).toEqual([]);
    expect(attached()).toBeUndefined();
    expect(says()).toContain("Not attached");
    expect(says()).not.toContain("Added");
    expect(says()).not.toContain("Uploading");

    // The refused cleanup is not tried again: the upload is left for the server to drop.
    await act(async () => void (await new Promise((done) => setTimeout(done, 60))));
    expect(ui.deletes).toEqual([]);
    expect(ui.mints).toHaveLength(1);
  });

  it("the same while the connection's session is still being read", async () => {
    const { h, attached } = await opened();
    const mint = deferred<Minted>();
    ui.mint = () => mint.promise;
    await press("Choose a file");
    h.setConnection("down");
    h.setSession({ state: "reading" });
    h.setConnection("live");
    mint.resolve(minted("up-1"));
    await settle();
    expect(ui.sent).toEqual([]);
    expect(ui.deletes).toEqual([]);
    expect(attached()).toBeUndefined();
    expect(says()).toContain("Not attached");
  });

  it("lost, and then he removes the file: the fresh upload is not deleted either", async () => {
    const { h, attached } = await opened();
    const mint = deferred<Minted>();
    ui.mint = () => mint.promise;
    await press("Choose a file");
    reconnectsNotHis(h);
    await press("Remove clip.mp4");
    mint.resolve(minted("up-1"));
    await settle();
    expect(ui.sent).toEqual([]);
    expect(ui.deletes).toEqual([]);
    expect(attached()).toBeUndefined();
    expect(says()).not.toContain("clip.mp4");
  });

  it("lost while the bytes are on their way: the copy that lands is not deleted and does not join the answer", async () => {
    const { h, entry, attached } = await opened();
    const transfer = deferred<{ status: number }>();
    ui.transfer = () => transfer.promise;
    await press("Choose a file");
    expect(ui.sent).toEqual(["https://a.test/uploads/up-1"]);

    reconnectsNotHis(h);
    // The screen locks the field, as it does for a phone that is not his.
    await show(entry, true);
    transfer.resolve({ status: 200 });
    await settle();
    expect(ui.deletes).toEqual([]);
    expect(attached()).toBeUndefined();
    expect(says()).not.toContain("Added");
    expect(says()).not.toContain("clip.mp4");
  });

  it("a file already in the answer: taking it out deletes nothing on the server and drops it here", async () => {
    const { h, attached } = await opened();
    await press("Choose a file");
    expect(says()).toContain("Added");
    reconnectsNotHis(h);
    await press("Remove clip.mp4");
    expect(ui.deletes).toEqual([]);
    expect(attached()).toEqual([]);
    expect(says()).not.toContain("clip.mp4");
  });

  it("trying again on a phone that is not his sends nothing; confirmed again, it goes", async () => {
    const { h, attached } = await opened();
    reconnectsNotHis(h);
    await press("Choose a file");
    expect(ui.mints).toEqual([]);
    expect(says()).toContain("Not attached");
    await press("Try clip.mp4 again");
    expect(ui.mints).toEqual([]);
    expect(ui.sent).toEqual([]);

    h.setSession(OWNER);
    await press("Try clip.mp4 again");
    expect(ui.mints).toHaveLength(1);
    expect(ui.sent).toEqual(["https://a.test/uploads/up-1"]);
    expect(attached()).toHaveLength(1);
  });
});
