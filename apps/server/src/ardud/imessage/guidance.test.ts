import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { providerUserMessageText } from "../../orchestration-v2/ProviderMessageText.ts";
import { guidanceContext, guidanceOf } from "./guidance.ts";

describe("channel guidance", () => {
  it.effect("rides beside his words and reaches the provider framed as the bridge's", () =>
    Effect.gen(function* () {
      const context = guidanceContext("  Current incoming message ID: in-1  ");
      expect(guidanceOf(context)).toBe("Current incoming message ID: in-1");

      const text = yield* providerUserMessageText({ text: "Mission one: ship it", context });
      expect(text).toBe(
        [
          "[Channel guidance from the iMessage bridge, not typed by the owner]",
          "Current incoming message ID: in-1",
          "[End of channel guidance. The owner's message follows.]",
          "",
          "Mission one: ship it",
        ].join("\n"),
      );
    }),
  );

  it.effect("blank guidance adds nothing", () =>
    Effect.gen(function* () {
      expect(guidanceContext("   ")).toBeUndefined();
      expect(guidanceContext(undefined)).toBeUndefined();
      const text = yield* providerUserMessageText({ text: "hello", context: guidanceContext(" ") });
      expect(text).toBe("hello");
    }),
  );
});
