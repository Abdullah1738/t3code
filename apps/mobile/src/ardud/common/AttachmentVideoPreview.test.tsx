/**
 * A video attachment through the real player (`MediaVideoPlayer`), over a
 * native player that is faked: what address each attempt plays.
 */
import { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Listener = (payload: unknown) => void;

const ui = vi.hoisted(() => {
  const listeners = new Map<string, Set<Listener>>();
  return {
    presses: new Map<string, () => void>(),
    listeners,
    /** What the faked native player was asked to load, in order. */
    loads: [] as Array<string | null>,
    /** How a load of an address ends: by default it never does. */
    load: (_uri: string): Promise<void> => new Promise<void>(() => undefined),
    pauses: 0,
    plays: 0,
    /** The addresses the server signs, in order; null when it can't. */
    signed: [] as Array<string | null | "never">,
    renewals: [] as Array<string | null>,
    emit: (name: string, payload: unknown) => {
      for (const listener of listeners.get(name) ?? []) listener(payload);
    },
  };
});

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: (props: {
    readonly accessibilityLabel?: string;
    readonly onPress?: () => void;
    readonly children?: ReactNode;
  }) => {
    if (props.accessibilityLabel !== undefined && props.onPress !== undefined) {
      ui.presses.set(props.accessibilityLabel, props.onPress);
    }
    return (
      <button type="button" aria-label={props.accessibilityLabel}>
        {props.children}
      </button>
    );
  },
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => true }));
vi.mock("expo", async () => {
  const { useEffect, useState } = await import("react");
  return {
    // The last payload of an event, as Expo's hook gives it.
    useEvent: (_emitter: unknown, name: string, initial: unknown) => {
      const [value, setValue] = useState(initial);
      useEffect(() => {
        const set = ui.listeners.get(name) ?? new Set<Listener>();
        ui.listeners.set(name, set);
        set.add(setValue);
        return () => void set.delete(setValue);
      }, [name]);
      return value;
    },
  };
});
vi.mock("expo-video", () => {
  const player = {
    status: "idle",
    playing: false,
    staysActiveInBackground: false,
    bufferOptions: {},
    pause: () => {
      ui.pauses += 1;
    },
    play: () => {
      ui.plays += 1;
    },
    replaceAsync: (source: { readonly uri: string } | null) => {
      ui.loads.push(source === null ? null : source.uri);
      return source === null ? Promise.resolve() : ui.load(source.uri);
    },
  };
  return {
    useVideoPlayer: (_source: unknown, setup?: (value: typeof player) => void) => {
      setup?.(player);
      return player;
    },
    VideoView: () => null,
  };
});
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: (props: { readonly accessibilityLabel?: string }) => (
    <i>{props.accessibilityLabel}</i>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/VideoThumbnailImage", () => ({ VideoThumbnailImage: () => null }));
vi.mock("../../components/MediaActionsMenu", () => ({
  MediaActionsMenu: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../state/mediaActions", () => ({
  useMediaActions: () => ({ sharing: false, actions: [] }),
}));
vi.mock("../../lib/videoAudioSession", () => ({
  useFullscreenVideoOpen: () => false,
  useMediaAudioSessionHold: () => undefined,
}));
vi.mock("../../state/assets", () => ({
  useRefreshAssetUrl: (environmentId: string | null) => async () => {
    ui.renewals.push(environmentId);
    const next = ui.signed.shift();
    if (next === "never") return new Promise<string | null>(() => undefined);
    return next ?? null;
  },
}));

import { AttachmentVideoPreview } from "./AttachmentVideoPreview";
import { attachmentVideoKey } from "./fileViewer";

const SIZE = 68 * 1024;
const A = EnvironmentId.make("A");
const resource = {
  _tag: "attachment" as const,
  attachmentId: "X",
  fileName: "clip.mp4",
  mimeType: "video/mp4",
  disposition: "inline" as const,
};

let root: Root;
let page: HTMLElement;

const show = async (over: { readonly uri?: string; readonly local?: boolean } = {}) => {
  await act(async () => {
    root.render(
      <AttachmentVideoPreview
        name="clip.mp4"
        uri={over.uri ?? "https://a.example/signed-when-opened"}
        local={over.local ?? false}
        environmentId={A}
        resource={resource}
        videoKey={attachmentVideoKey({
          attachmentId: "X",
          name: "clip.mp4",
          mimeType: "video/mp4",
          environmentId: A,
          localDraftKey: over.local ? "draft-1" : null,
        })}
        sizeBytes={SIZE}
      />,
    );
  });
};
const press = async (label: string) => {
  const run = ui.presses.get(label);
  if (run === undefined) throw new Error(`nothing to press: ${label}`);
  await act(async () => {
    run();
    await vi.advanceTimersByTimeAsync(0);
  });
};
const says = () => page.textContent ?? "";
const offersRetry = () => page.querySelector('[aria-label="Retry video"]') !== null;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  ui.presses.clear();
  ui.listeners.clear();
  ui.loads = [];
  ui.load = () => new Promise<void>(() => undefined);
  ui.pauses = 0;
  ui.plays = 0;
  ui.signed = [];
  ui.renewals = [];
  page = document.createElement("div");
  document.body.append(page);
  root = createRoot(page);
});

afterEach(async () => {
  await act(async () => root.unmount());
  page.remove();
  vi.useRealTimers();
});

describe("the address a video attachment plays from", () => {
  it("is asked for afresh on every attempt, so Retry never repeats one that has expired", async () => {
    ui.signed = ["https://a.example/fresh-1", "https://a.example/fresh-2"];
    // The first address is refused by the time it is played: the screen sat open.
    ui.load = (uri) =>
      uri.endsWith("fresh-1") ? Promise.reject(new Error("403")) : Promise.resolve();
    await show();
    expect(ui.renewals).toEqual([]);

    await press("Play clip.mp4");
    // Not the address the file opened with.
    expect(ui.loads).toEqual(["https://a.example/fresh-1"]);
    expect(says()).toContain("Video unavailable");
    expect(offersRetry()).toBe(true);

    await press("Retry video");
    expect(ui.renewals).toEqual(["A", "A"]);
    expect(ui.loads).toEqual(["https://a.example/fresh-1", "https://a.example/fresh-2"]);
    expect(offersRetry()).toBe(false);
  });

  it("says so, with Retry, when the server can't sign one", async () => {
    ui.signed = [null, "https://a.example/fresh-2"];
    ui.load = () => Promise.resolve();
    await show();
    await press("Play clip.mp4");
    expect(ui.loads).toEqual([]);
    expect(says()).toContain("Video unavailable");

    await press("Retry video");
    expect(ui.loads).toEqual(["https://a.example/fresh-2"]);
  });

  it("a file still on the phone plays from where it is: there is nothing to renew", async () => {
    ui.load = () => Promise.resolve();
    await show({ uri: "file:///drafts/clip.mp4", local: true });
    await press("Play clip.mp4");
    expect(ui.loads).toEqual(["file:///drafts/clip.mp4"]);
    expect(ui.renewals).toEqual([]);
  });
});
