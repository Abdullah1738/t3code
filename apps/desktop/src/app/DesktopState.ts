import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { QuitTrigger } from "./DesktopQuit.ts";

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    readonly quitTrigger: Ref.Ref<QuitTrigger | undefined>;
    readonly quitRecorded: Ref.Ref<boolean>;
  }
>()("@t3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  quitTrigger: Ref.make<QuitTrigger | undefined>(undefined),
  quitRecorded: Ref.make(false),
});

export const layer = Layer.effect(DesktopState, make);
