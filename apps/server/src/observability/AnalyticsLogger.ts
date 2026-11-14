import { interruptionProps } from "./analyticsInterruption.ts";
import type { AnalyticsEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AnalyticsOriginKind } from "./RpcInstrumentation.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import type * as Analytics from "../ardud/analytics/Analytics.ts";

const label = (value: unknown, fallback: string) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:/#@%+\-]{1,160}$/.test(value) ? value : fallback;
const entityId = (value: unknown) =>
  typeof value === "string" && /^[a-zA-Z0-9_.:/#@%+\-]{1,512}$/.test(value) ? value : undefined;

export const makeAnalyticsLogger = (analytics: Analytics.Analytics["Service"]) =>
  Logger.make(({ logLevel, cause, message, fiber, date }) => {
    if (logLevel !== "Error" && logLevel !== "Fatal") return;
    const parent = Context.getOption(fiber.context, Tracer.ParentSpan);
    const span = parent._tag === "Some" && parent.value._tag === "Span" ? parent.value : undefined;
    const attributes = span?.attributes;
    const annotations = fiber.getRef(References.CurrentLogAnnotations);
    const get = (key: string) => attributes?.get(key) ?? annotations[key];
    const messages = (Array.isArray(message) ? message : [message]).slice(0, 8);
    const nestedCause = messages.flatMap((value: unknown) => {
      if (Cause.isCause(value)) return [value];
      if (typeof value === "object" && value !== null) {
        const descriptor = Object.getOwnPropertyDescriptor(value, "cause");
        if (descriptor && "value" in descriptor && Cause.isCause(descriptor.value))
          return [descriptor.value];
      }
      return [];
    });
    const reasons = [...cause.reasons, ...nestedCause.flatMap((value) => value.reasons)];
    const failure = reasons.find((reason) => reason._tag === "Fail" || reason._tag === "Die");
    const error =
      failure?._tag === "Fail"
        ? failure.error
        : failure?._tag === "Die"
          ? failure.defect
          : messages.find(
              (value: unknown) => typeof value === "object" && value !== null && "_tag" in value,
            );
    const errorTag =
      typeof error === "object" && error !== null && "_tag" in error
        ? label(error._tag, "ServerError")
        : "ServerError";
    const event: AnalyticsEvent = {
      ts: date.toISOString(),
      kind: "server.error",
      surface: "server",
      route: "server",
      ...Object.fromEntries(
        Object.entries({
          boardId: entityId(get("kanban.board_id")),
          cardId: entityId(get("kanban.card_id")),
          threadId: entityId(get("thread.id") ?? get("threadId")),
        }).filter(([, value]) => value !== undefined),
      ),
      props: {
        span: label(span?.name, "server"),
        errorTag,
        ...interruptionProps(Cause.fromReasons(reasons)),
        originKind: fiber.getRef(AnalyticsOriginKind),
        reason: logLevel.toLowerCase(),
      },
    };
    // Logger callbacks are a runtime boundary. The service only offers to its bounded queue.
    Effect.runForkWith(fiber.context)(analytics.record(event));
  });
