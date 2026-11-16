import { KanbanService } from "../ardud/kanban/engine/KanbanService.ts";
import * as ThreadReadMetrics from "../ardud/analytics/ThreadReadMetrics.ts";
import * as OwnerAnalytics from "../ardud/analytics/Analytics.ts";
import * as McpCallLedger from "../ardud/analytics/McpCallLedger.ts";
import * as McpResponseDelivery from "../ardud/http/McpResponseDelivery.ts";
import * as ThreadReadDeadline from "./ThreadReadDeadline.ts";
import * as StartupPhaseLog from "../ardud/observability/StartupPhaseLog.ts";
import { bootId } from "../ardud/fast-install/report.ts";
import * as McpCallAnalytics from "../ardud/analytics/McpCall.ts";
import { delegationIdShape } from "./delegationTaskIdentity.ts";
import * as CardNextMetrics from "../ardud/analytics/CardNextMetrics.ts";
import * as SavedWrite from "../ardud/kanban/engine/savedWrite.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { analyticsErrorTag, recordServerAnalytics } from "../observability/RpcInstrumentation.ts";
import * as DateTime from "effect/DateTime";
import { AnalyticsToolkit } from "./toolkits/analytics/tools.ts";
import * as AnalyticsHandlers from "./toolkits/analytics/handlers.ts";
import * as RedactionTools from "../ardud/redaction/tools.ts";
import * as SavedBoardReply from "../ardud/kanban/tools/savedReply.ts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as Types from "effect/Types";
import { AiError, McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import {
  OrchestratorMcpFailure,
  PreviewAutomationError,
  type RunId,
  ThreadId,
} from "@t3tools/contracts";

import packageJson from "../../package.json" with { type: "json" };
import * as ServerConfig from "../config.ts";
import * as DeviceService from "../device/DeviceService.ts";
import * as HtmlRender from "../htmlRender/HtmlRender.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as LargeReplyLog from "../observability/LargeReplyLog.ts";
import * as McpReplySize from "../observability/McpReplySize.ts";
import {
  jsonBytesUpToLimit,
  MAX_REPLY_BYTES,
  REPLY_TOO_LARGE,
  ReplyTooLarge,
} from "../ardud/http/replyBudget.ts";
import * as ReplyBuilders from "../ardud/http/ReplyBuilders.ts";
import * as ReplyReadiness from "../ardud/http/replyReadiness.ts";
import { ReplyRejection } from "../ardud/http/ReplyRejection.ts";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import {
  type AgentThread,
  agentToolProperties,
  handoffSettings,
  MAX_REPORTED_DEPTH,
  toolOutcome,
} from "../telemetry/ProviderDimensions.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpDeadline from "./McpDeadline.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { PreviewControlsToolkit } from "./toolkits/previewControls/tools.ts";
import * as PreviewControlsHandlers from "./toolkits/previewControls/handlers.ts";
import { EnvironmentToolkit } from "./toolkits/environment/tools.ts";
import * as EnvironmentHandlers from "./toolkits/environment/handlers.ts";
import { ProjectToolkit } from "./toolkits/project/tools.ts";
import * as ProjectHandlers from "./toolkits/project/handlers.ts";
import { AttachmentToolkit } from "./toolkits/attachment/tools.ts";
import * as AttachmentHandlers from "./toolkits/attachment/handlers.ts";
import { ThreadToolkit } from "./toolkits/thread/tools.ts";
import * as ThreadHandlers from "./toolkits/thread/handlers.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import * as OrchestratorHandlers from "./toolkits/orchestrator/handlers.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import * as PreviewHandlers from "./toolkits/preview/handlers.ts";
import {
  PreviewSnapshotTool,
  PreviewSnapshotToolkit,
  PreviewStandardToolkit,
} from "./toolkits/preview/tools.ts";
import * as WorktreeHandlers from "./toolkits/worktree/handlers.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";
import * as WorktreeMcpService from "./WorktreeMcpService.ts";
// ardud fork: same-thread context reset tool.
import * as ContextResetHandlers from "../ardud/context-reset/handlers.ts";
import * as ContextResetService from "../ardud/context-reset/ContextResetService.ts";
import { ContextResetToolkit } from "../ardud/context-reset/tools.ts";
import * as ImessageSendHandlers from "../ardud/imessage/handlers.ts";
import * as ImessageBridgeCli from "../ardud/imessage/ImessageBridgeCli.ts";
import * as ImessageSendService from "../ardud/imessage/ImessageSendService.ts";
import { ImessageSendToolkit } from "../ardud/imessage/tools.ts";
import * as ControlStore from "../ardud/control/ControlStore.ts";
// ardud schedules: retry a scheduled task's blocked runs.
import * as ScheduledTaskBlockRetry from "../ardud/schedules/blockRetryTools.ts";
import * as KanbanHandlers from "../ardud/kanban/tools/handlers.ts";
import { KanbanToolkit } from "../ardud/kanban/tools/tools.ts";
import * as PullRequestsHandlers from "./toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "./toolkits/pullRequests/tools.ts";
import * as DeviceHandlers from "./toolkits/device/handlers.ts";
import {
  DeviceScreenshotTool,
  DeviceScreenshotToolkit,
  DeviceStandardToolkit,
} from "./toolkits/device/tools.ts";
import * as HtmlHandlers from "./toolkits/html/handlers.ts";
import { HtmlPreviewTool, HtmlPreviewToolkit, HtmlRenderToolkit } from "./toolkits/html/tools.ts";

const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/**
 * Agents T3 Code launched carry a registry token and must never be sent into an
 * OAuth flow when it dies: they cannot open a browser, and a sign-in would mint
 * a credential that outlives their session.
 */
const unauthorized = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presentedToken: boolean;
  readonly offerOAuth: boolean;
  readonly providerToken: boolean;
}) => {
  const metadataUrl = input.offerOAuth
    ? Option.getOrUndefined(mcpResourceMetadataUrl(input.request))
    : undefined;
  const challenge = [
    "Bearer",
    [
      ...(metadataUrl === undefined ? [] : [`resource_metadata="${metadataUrl}"`]),
      ...(input.presentedToken ? ['error="invalid_token"'] : []),
    ].join(", "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      // ardud: A dead run credential cannot be refreshed until the next turn.
      message: input.providerToken
        ? "This T3 Code MCP credential is no longer valid (revoked, expired, or issued before a Robob restart). Don't retry T3 tools in this run: finish or end your turn; the next turn gets a fresh credential."
        : "A valid T3 Code MCP credential is required.",
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge,
      },
    },
  );
};

export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("t3/mcp/McpHttpServer/McpClientAuthenticator") {}

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

class McpReplyCapture extends Context.Service<
  McpReplyCapture,
  McpReplySize.McpReplyCapture & {
    readonly arrivedAt: bigint;
    readonly authenticatedAt: bigint;
    readonly sessionId: string | undefined;
  }
>()("t3/mcp/McpHttpServer/McpReplyCapture") {}

export const normalizeMcpHttpResponse = (
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse => {
  const bodyIsEmpty =
    response.body._tag === "Empty" ||
    (response.body._tag === "Uint8Array" && response.body.contentLength === 0) ||
    (response.body._tag === "Raw" && response.body.contentLength === 0);
  return response.status === 200 && bodyIsEmpty
    ? HttpServerResponse.setStatus(response, 202)
    : response;
};

// Session tokens are `<payload>.<signature>`; registry tokens are a bare base64url secret.
const looksLikeProviderToken = (token: string) => token.length > 0 && !token.includes(".");
const LARGE_READ_TOOLS = new Set([
  "board_get",
  "board_activity",
  "card_get",
  "wiki_read",
  "discussion_read",
  "card_search",
  "t3_thread_read",
  "t3_thread_list",
  "list_scheduled_tasks",
]);
const BOARD_READ_TOOLS = new Set([
  "board_get",
  "board_activity",
  "card_get",
  "wiki_read",
  "discussion_read",
  "card_search",
]);

export const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const clients = yield* Effect.serviceOption(McpClientAuthenticator);
  const largeReplies = yield* Effect.serviceOption(LargeReplyLog.LargeReplyLog);
  return Effect.fn("McpHttpServer.authenticateRequest")(function* (httpEffect) {
    const arrivedAt = yield* Clock.monotonicTimeNanos;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    const invocation =
      (yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    const authenticatedAt = yield* Clock.monotonicTimeNanos;
    if (!invocation) {
      yield* Effect.logWarning("rejected MCP request with an unusable credential", {
        reason: token.length === 0 ? "missing_bearer_token" : "unknown_or_expired_token",
      });
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
        providerToken: looksLikeProviderToken(token),
      });
    }
    const capture: McpReplyCapture["Service"] = {
      arrivedAt,
      authenticatedAt,
      sessionId: request.headers["mcp-session-id"],
      name: undefined,
      threadId: invocation.thread?.threadId,
    };
    const delivery = McpResponseDelivery.forRequest(request.source);
    return yield* httpEffect.pipe(
      delivery === undefined
        ? (effect) => effect
        : Effect.provideService(McpResponseDelivery.McpResponseDelivery, delivery),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpReplyCapture, capture),
      Effect.map(normalizeMcpHttpResponse),
      Effect.map((response) =>
        Option.isSome(largeReplies)
          ? McpReplySize.recordResponse(response, capture, largeReplies.value)
          : response,
      ),
    );
  }) satisfies McpAuthMiddleware;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

const layerMcpAuthMiddleware = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;

/**
 * Claude Code moves an MCP result above its output limit to a file and hands
 * the agent a notice instead, so a snapshot that carries the full accessibility
 * tree and page text loses its locators too. Claude Code also shows the model
 * `structuredContent` in place of the text blocks when a result has both, so
 * both carry the same bounded snapshot.
 */
export const MAX_SNAPSHOT_TEXT_BYTES = 20_000;
const MAX_SNAPSHOT_VISIBLE_TEXT_CHARS = 8_000;
const MAX_SNAPSHOT_ELEMENT_NAME_CHARS = 200;
const MAX_SNAPSHOT_LOG_ENTRIES = 40;
const MAX_SNAPSHOT_LOG_TEXT_CHARS = 500;
const MAX_SNAPSHOT_IDENTIFIER_CHARS = 2_048;

const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");
const cutText = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}…` : text;

const cutEntryStrings = <A>(entry: A): A =>
  typeof entry === "object" && entry !== null
    ? (Object.fromEntries(
        Object.entries(entry).map(([key, value]) => [
          key,
          typeof value === "string" ? cutText(value, MAX_SNAPSHOT_LOG_TEXT_CHARS) : value,
        ]),
      ) as A)
    : entry;

const hasLongString = (entry: unknown, max: number) =>
  typeof entry === "object" &&
  entry !== null &&
  Object.values(entry).some((value) => typeof value === "string" && value.length > max);

type SnapshotMetadata = {
  readonly url: string;
  readonly title: string;
  readonly visibleText: string;
  readonly interactiveElements: ReadonlyArray<{
    readonly name: string;
    readonly [key: string]: unknown;
  }>;
  readonly consoleEntries: ReadonlyArray<unknown>;
  readonly networkEntries: ReadonlyArray<unknown>;
  readonly actionTimeline: ReadonlyArray<unknown>;
  readonly [key: string]: unknown;
};

const boundSnapshotMetadata = (metadata: SnapshotMetadata) => {
  const omitted: Array<string> = [];
  const { accessibilityTree, ...withoutTree } = metadata;
  const ariaTree = typeof accessibilityTree === "string" ? accessibilityTree : undefined;
  if (accessibilityTree !== undefined && ariaTree === undefined) {
    omitted.push("accessibilityTree (use interactiveElements locators or preview_evaluate)");
  }
  const tail = <A>(entries: ReadonlyArray<A>, label: string) => {
    if (entries.length > MAX_SNAPSHOT_LOG_ENTRIES) {
      omitted.push(`${entries.length - MAX_SNAPSHOT_LOG_ENTRIES} older ${label}`);
    }
    const kept = entries.slice(-MAX_SNAPSHOT_LOG_ENTRIES);
    if (kept.some((entry) => hasLongString(entry, MAX_SNAPSHOT_LOG_TEXT_CHARS))) {
      omitted.push(`${label} text after ${MAX_SNAPSHOT_LOG_TEXT_CHARS} characters`);
    }
    return kept.map(cutEntryStrings);
  };
  if (
    metadata.url.length > MAX_SNAPSHOT_IDENTIFIER_CHARS ||
    metadata.title.length > MAX_SNAPSHOT_IDENTIFIER_CHARS
  ) {
    omitted.push(`url or title after ${MAX_SNAPSHOT_IDENTIFIER_CHARS} characters`);
  }
  if (
    metadata.interactiveElements.some(
      (element) => element.name.length > MAX_SNAPSHOT_ELEMENT_NAME_CHARS,
    )
  ) {
    omitted.push(`element names longer than ${MAX_SNAPSHOT_ELEMENT_NAME_CHARS} characters`);
  }
  const bounded = {
    ...withoutTree,
    url: cutText(metadata.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    title: cutText(metadata.title, MAX_SNAPSHOT_IDENTIFIER_CHARS),
    interactiveElements: metadata.interactiveElements.map((element) => ({
      ...element,
      name: cutText(element.name, MAX_SNAPSHOT_ELEMENT_NAME_CHARS),
    })),
    consoleEntries: tail(metadata.consoleEntries, "console entries"),
    networkEntries: tail(metadata.networkEntries, "network entries"),
    actionTimeline: tail(metadata.actionTimeline, "action timeline entries"),
  };

  // Per-field caps do not sum below the ceiling: three log arrays of 40 capped
  // entries alone can pass 60 KB, and the caps count characters, not bytes.
  const shedOrder = [
    "actionTimeline",
    "networkEntries",
    "consoleEntries",
    "interactiveElements",
  ] as const;
  const lists: Record<(typeof shedOrder)[number], ReadonlyArray<unknown>> = {
    interactiveElements: bounded.interactiveElements,
    consoleEntries: bounded.consoleEntries,
    networkEntries: bounded.networkEntries,
    actionTimeline: bounded.actionTimeline,
  };
  const dropped: Record<(typeof shedOrder)[number], number> = {
    interactiveElements: 0,
    consoleEntries: 0,
    networkEntries: 0,
    actionTimeline: 0,
  };
  let visibleTextChars = Math.min(metadata.visibleText.length, MAX_SNAPSHOT_VISIBLE_TEXT_CHARS);
  let ariaTreeChars = Math.min(ariaTree?.length ?? 0, 20_000);
  const value = () => ({
    ...bounded,
    ...(ariaTree === undefined ? {} : { accessibilityTree: cutText(ariaTree, ariaTreeChars) }),
    visibleText: cutText(metadata.visibleText, visibleTextChars),
    ...lists,
  });
  let text = encodeJsonText(value());
  while (utf8Length(text) > MAX_SNAPSHOT_TEXT_BYTES) {
    // Elements carry the locators, so they go last; logs shed newest-last.
    const key =
      shedOrder.find(
        (candidate) => candidate !== "interactiveElements" && lists[candidate].length > 0,
      ) ??
      (visibleTextChars > 0
        ? "visibleText"
        : lists.interactiveElements.length > 0
          ? "interactiveElements"
          : ariaTreeChars > 0
            ? "accessibilityTree"
            : undefined);
    if (key === undefined) break;
    if (key === "visibleText") {
      visibleTextChars = Math.floor(visibleTextChars / 2);
    } else if (key === "accessibilityTree") {
      ariaTreeChars = Math.floor(ariaTreeChars / 2);
    } else {
      const keep = Math.floor(lists[key].length / 2);
      dropped[key] += lists[key].length - keep;
      // slice(-0) keeps everything, so spell out the empty case.
      lists[key] =
        keep === 0
          ? []
          : key === "interactiveElements"
            ? lists[key].slice(0, keep)
            : lists[key].slice(-keep);
    }
    text = encodeJsonText(value());
  }
  if (visibleTextChars < metadata.visibleText.length) {
    omitted.push(
      `visibleText after ${visibleTextChars} characters (use preview_evaluate for more)`,
    );
  }
  if (ariaTree !== undefined && ariaTreeChars < ariaTree.length) {
    omitted.push(`accessibilityTree after ${ariaTreeChars} characters`);
  }
  for (const key of shedOrder) {
    if (dropped[key] > 0) {
      omitted.push(`${dropped[key]} of ${bounded[key].length} ${key}`);
    }
  }
  return { value: value(), text, omitted };
};

export class PreviewScreenshotSaveError extends Schema.TaggedError<PreviewScreenshotSaveError>()(
  "PreviewScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save preview screenshot to ${this.screenshotPath}.`;
  }
}

const MAX_SCREENSHOT_SITE_SLUG_LENGTH = 40;

const screenshotSiteSlug = (rawUrl: string): string => {
  try {
    const slug = new URL(rawUrl).hostname
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, MAX_SCREENSHOT_SITE_SLUG_LENGTH)
      .replace(/-+$/g, "");
    return slug || "site";
  } catch {
    return "site";
  }
};

const saveScreenshot = Effect.fn("McpHttpServer.saveScreenshot")(function* (
  pageUrl: string,
  data: Uint8Array,
) {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  const crypto = yield* Crypto.Crypto;
  const unique = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8);
  const fileName = `browser-screenshot-${screenshotSiteSlug(pageUrl)}-${millis.toString(36)}-${unique}.png`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  yield* fileSystem.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fileSystem.writeFile(screenshotPath, data)),
    Effect.mapError((cause) => new PreviewScreenshotSaveError({ screenshotPath, cause })),
  );
  return screenshotPath;
});

/**
 * Tool input schemas are advertised through each schema's JSON codec, which
 * offers `null` for every `Schema.optional` field, but Toolkit decodes with the
 * schema itself and rejects that `null`. Decoding through the same codec makes
 * a tool accept what it advertises.
 */
const decodeAsAdvertised = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
): Toolkit.Toolkit<Tools> =>
  // The clones keep each tool's id, name and decoded parameter type, so handlers still match.
  Toolkit.make(
    ...Object.values(toolkit.tools).map((tool) =>
      tool.setParameters(Schema.toCodecJson(tool.parametersSchema)),
    ),
  ) as unknown as Toolkit.Toolkit<Tools>;

const isPreviewAutomationError = Schema.is(PreviewAutomationError);

const previewSnapshotFailure = <E>(cause: Cause.Cause<E>) => {
  if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
    return Effect.failCause(cause).pipe(Effect.orDie);
  }
  const failures = cause.reasons.filter(Cause.isFailReason);
  const firstFailure = failures[0]?.error;
  const errorTag =
    typeof firstFailure === "object" &&
    firstFailure !== null &&
    "_tag" in firstFailure &&
    typeof firstFailure._tag === "string"
      ? firstFailure._tag
      : "PreviewSnapshotError";
  // Preview errors build their message on the server, never from page output,
  // and it tells the agent what to do next, such as falling back to a shell browser.
  const message = isPreviewAutomationError(firstFailure) ? firstFailure.message : undefined;
  const result = new McpSchema.CallToolResult({
    isError: true,
    structuredContent: {
      error: {
        _tag: errorTag,
        operation: "snapshot",
        failureCount: failures.length,
        ...(message === undefined ? {} : { message }),
      },
    },
    // Some clients show only the text content and others only structuredContent, so both carry it.
    content: [{ type: "text", text: `Preview snapshot failed: ${message ?? `${errorTag}.`}` }],
  });
  return Effect.logWarning("preview snapshot failed", {
    operation: "snapshot",
    errorTag,
    failureCount: failures.length,
  }).pipe(Effect.as(result));
};

const registerPreviewSnapshot = Effect.fn("McpHttpServer.registerPreviewSnapshot")(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const saveServices = yield* Effect.context<
    ServerConfig.ServerConfig | FileSystem.FileSystem | Path.Path | Crypto.Crypto
  >();
  const built = yield* decodeAsAdvertised(PreviewSnapshotToolkit);
  const tool = PreviewSnapshotTool;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return built.handle("preview_snapshot", payload).pipe(
          Stream.unwrap,
          Stream.run(Sink.last()),
          Effect.flatMap(Effect.fromOption),
          Effect.provideService(PreviewAutomationBroker.PreviewAutomationBroker, broker),
          Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.flatMap(({ encodedResult }) =>
            Effect.gen(function* () {
              const snapshot = encodedResult as SnapshotMetadata & {
                readonly url: string;
                readonly screenshot?: {
                  readonly mimeType: "image/png";
                  readonly data: string;
                  readonly width: number;
                  readonly height: number;
                };
              };
              const { screenshot, ...page } = snapshot;
              const png = new Uint8Array(Buffer.from(screenshot?.data ?? "", "base64"));
              const screenshotPath =
                payload?.save === true ? yield* saveScreenshot(snapshot.url, png) : undefined;
              // Images stay out of tool history unless asked for: providers replay them on every
              // later request, and some reject inline images outright.
              const includeImage = payload?.includeImage === true;
              if (screenshotPath !== undefined && !includeImage) {
                const saved = {
                  url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                  screenshotPath,
                };
                return new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: saved,
                  content: [{ type: "text", text: encodeJsonText(saved) }],
                });
              }
              const metadata = {
                ...page,
                ...(screenshot === undefined
                  ? {}
                  : {
                      screenshot: {
                        mimeType: screenshot.mimeType,
                        width: screenshot.width,
                        height: screenshot.height,
                      },
                    }),
                ...(screenshotPath === undefined ? {} : { screenshotPath }),
              };
              const bounded = boundSnapshotMetadata(metadata);
              return new McpSchema.CallToolResult({
                isError: false,
                structuredContent:
                  bounded.omitted.length === 0
                    ? bounded.value
                    : { ...bounded.value, omitted: bounded.omitted },
                content: [
                  {
                    type: "text",
                    text: encodeJsonText({
                      url: cutText(snapshot.url, MAX_SNAPSHOT_IDENTIFIER_CHARS),
                    }),
                  },
                  { type: "text", text: bounded.text },
                  ...(bounded.omitted.length === 0
                    ? []
                    : [
                        {
                          type: "text" as const,
                          text: `Snapshot text was bounded. Omitted: ${bounded.omitted.join("; ")}.`,
                        },
                      ]),
                  ...(includeImage && screenshot !== undefined
                    ? [{ type: "image" as const, data: png, mimeType: screenshot.mimeType }]
                    : []),
                ],
              });
            }),
          ),
          Effect.provide(saveServices),
          Effect.matchCauseEffect({
            onFailure: previewSnapshotFailure,
            onSuccess: Effect.succeed,
          }),
        );
      }),
  });
});

interface ImageToolResult {
  readonly screenshot: {
    readonly mimeType: "image/png";
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

/**
 * Failures surface only their tag unless the tool describes them: the remote
 * message may carry renderer or device output the agent should not see, and the
 * tag is what it can act on.
 */
const imageToolFailure =
  <E>(toolName: string, operation: string, failureText: string | ((error: E) => string)) =>
  (cause: Cause.Cause<E>) => {
    if (Cause.hasInterrupts(cause) || cause.reasons.some(Cause.isDieReason)) {
      return Effect.failCause(cause).pipe(Effect.orDie);
    }
    const failures = cause.reasons.filter(Cause.isFailReason);
    const firstFailure = failures[0]?.error;
    const errorTag =
      typeof firstFailure === "object" &&
      firstFailure !== null &&
      "_tag" in firstFailure &&
      typeof firstFailure._tag === "string"
        ? firstFailure._tag
        : `${toolName}Error`;
    const message =
      typeof failureText === "string" || failures[0] === undefined
        ? undefined
        : failureText(failures[0].error);
    const result = new McpSchema.CallToolResult({
      isError: true,
      structuredContent: {
        error: {
          _tag: errorTag,
          operation,
          failureCount: failures.length,
          ...(message === undefined ? {} : { message }),
        },
      },
      // Some clients show only the text content and others only structuredContent, so both carry it.
      content: [
        {
          type: "text",
          text: typeof failureText === "string" ? failureText : (message ?? `${toolName} failed.`),
        },
      ],
    });
    return Effect.logWarning(`${toolName} failed`, {
      operation,
      errorTag,
      failureCount: failures.length,
    }).pipe(Effect.as(result));
  };

/**
 * `McpServer.toolkit` serializes every result as JSON text, which is the wrong
 * shape for a screenshot: the model needs image content.
 */
const registerImageTool = Effect.fn("McpHttpServer.registerImageTool")(function* <
  T extends Tool.Any,
  E,
  R,
>(
  tool: T,
  handle: (payload: Tool.Parameters<T>) => Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  provide: (
    effect: Effect.Effect<{ readonly encodedResult: unknown }, E, R>,
  ) => Effect.Effect<
    { readonly encodedResult: unknown },
    E,
    McpInvocationContext.McpInvocationContext
  >,
  operation: string,
  failureText: string | ((error: E) => string),
) {
  const server = yield* McpServer.McpServer;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: tool.name,
      description: Tool.getDescription(tool),
      inputSchema: Tool.getJsonSchema(tool),
      annotations: {
        ...Context.getOption(tool.annotations, Tool.Title).pipe(
          Option.map((title) => ({ title })),
          Option.getOrUndefined,
        ),
        readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
        destructiveHint: Context.get(tool.annotations, Tool.Destructive),
        idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
        openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
      },
    }),
    annotations: tool.annotations,
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(
          fiber.context,
          McpInvocationContext.McpInvocationContext,
        );
        return provide(handle(payload as Tool.Parameters<T>)).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
          Effect.matchCauseEffect({
            onFailure: imageToolFailure(tool.name, operation, failureText),
            onSuccess: ({ encodedResult }) => {
              const { screenshot, ...rest } = encodedResult as ImageToolResult;
              const includeImage =
                (payload as { readonly includeImage?: boolean } | undefined)?.includeImage !==
                false;
              const metadata = {
                ...rest,
                screenshot: {
                  mimeType: screenshot.mimeType,
                  width: screenshot.width,
                  height: screenshot.height,
                },
              };
              return Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: false,
                  structuredContent: metadata,
                  content: [
                    { type: "text", text: JSON.stringify(metadata) },
                    ...(includeImage
                      ? [
                          {
                            type: "image" as const,
                            data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                            mimeType: screenshot.mimeType,
                          },
                        ]
                      : []),
                  ],
                }),
              );
            },
          }),
        );
      }),
  });
});

const registerDeviceScreenshot = Effect.fn("McpHttpServer.registerDeviceScreenshot")(function* () {
  const devices = yield* DeviceService.DeviceService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* decodeAsAdvertised(DeviceScreenshotToolkit);
  yield* registerImageTool(
    DeviceScreenshotTool,
    (payload) =>
      built
        .handle("device_screenshot", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(DeviceService.DeviceService, devices),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "screenshot",
    "Device screenshot failed.",
  );
});

const isOrchestratorMcpFailure = Schema.is(OrchestratorMcpFailure);

const registerHtmlPreview = Effect.fn("McpHttpServer.registerHtmlPreview")(function* () {
  const htmlRender = yield* HtmlRender.HtmlRender;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const built = yield* decodeAsAdvertised(HtmlPreviewToolkit);
  yield* registerImageTool(
    HtmlPreviewTool,
    (payload) =>
      built
        .handle("html_preview", payload)
        .pipe(Stream.unwrap, Stream.run(Sink.last()), Effect.flatMap(Effect.fromOption)),
    (effect) =>
      effect.pipe(
        Effect.provideService(HtmlRender.HtmlRender, htmlRender),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      ),
    "preview",

    (error) =>
      isOrchestratorMcpFailure(error) || AiError.isAiError(error)
        ? error.message
        : "HTML preview failed.",
  );
});

/**
 * Tools that hand work to another thread's agent: they create it, message it,
 * steer it, or move context into it. Their events name the receiving agent too.
 */
const HANDOFF_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "create_threads",
  "t3_thread_launch",
  "t3_thread_send",
  "t3_thread_send_attachments",
  "t3_thread_fork",
  "t3_thread_merge_back",
  "t3_queue_edit",
  "t3_queue_promote_to_steer",
  "t3_pending_request_respond",
  "schedule_task",
  "run_scheduled_task_now",
]);

/** Handoff tools whose result is only `{ sequence }`; their input names the receiving thread. */
const INPUT_TARGET_TOOLS: ReadonlySet<string> = new Set([
  "t3_queue_edit",
  "t3_queue_promote_to_steer",
  "t3_pending_request_respond",
]);

const resultThreadKeys = ["childThreadId", "targetThreadId", "boundThreadId", "threadId"] as const;

/** Thread ids a handoff tool result names: the thread that received the work. */
const resultThreadIds = (content: unknown): ReadonlyArray<string> => {
  if (typeof content !== "object" || content === null) return [];
  const record = content as Readonly<Record<string, unknown>>;
  if (Array.isArray(record.threads)) return record.threads.flatMap(resultThreadIds);
  const key = resultThreadKeys.find((candidate) => typeof record[candidate] === "string");
  return key === undefined ? [] : [record[key] as string];
};

/**
 * Thread ids that received a handoff. The input's `threadId` is used only after
 * the call succeeded, so it is one the handler already resolved and authorized.
 */
const handoffTargetIds = (
  tool: string,
  args: unknown,
  result: McpSchema.CallToolResult | undefined,
): ReadonlyArray<string> => {
  if (!INPUT_TARGET_TOOLS.has(tool)) return resultThreadIds(result?.structuredContent);
  if (result === undefined || toolOutcome(result).outcome !== "ok") return [];
  const threadId = (args as { readonly threadId?: unknown } | null | undefined)?.threadId;
  return typeof threadId === "string" ? [threadId] : [];
};

export const withFailureStructuredContent = (
  result: McpSchema.CallToolResult | McpSchema.InputRequired,
) => {
  if (
    result instanceof McpSchema.InputRequired ||
    result.isError !== true ||
    result.structuredContent !== undefined
  )
    return result;
  const part = result.content.find((part) => part.type === "text");
  if (part?.type !== "text" || part.text.length > 8192) return result;
  try {
    const failure = JSON.parse(part.text) as Schema.Json;
    if (failure !== null && typeof failure === "object" && !Array.isArray(failure)) {
      // Effect drops structuredContent on failures, but scripted callers read it.
      return new McpSchema.CallToolResult({ ...result, structuredContent: failure });
    }
  } catch {
    /* Plain-text failures stay unchanged. */
  }
  return result;
};

/**
 * Runs a tool registration against a server that records one anonymous
 * `mcp.tool.invoked` event per call: the tool, the calling agent's provider,
 * the outcome with its failure code, and the duration. A handoff tool also
 * reports the caller's model, origin, and delegation depth, the settings the
 * agent chose, and the provider, model, and modes of each thread that received
 * the work. Ids, prompts, and free text are never recorded.
 */
const withToolAnalytics =
  /* Request instrumentation already owns the span; keep this helper in that context. */
  Effect.fnUntraced(function* <A, E, R>(registration: Effect.Effect<A, E, R>) {
    const server = yield* McpServer.McpServer;
    const ledger = yield* McpCallLedger.McpCallLedger;
    const kanbanContext = yield* Effect.serviceOption(KanbanService);
    const startup = yield* Effect.serviceOption(StartupPhaseLog.StartupPhaseLog);
    const callBootId = Option.isSome(startup) ? startup.value.snapshot().bootId : bootId;
    const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
    const ownerAnalytics = yield* Effect.serviceOption(OwnerAnalytics.Analytics);
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    const build = Option.isSome(config) ? (config.value.robobBuildCommit ?? "unknown") : "unknown";
    const largeRepliesForTools = yield* Effect.serviceOption(LargeReplyLog.LargeReplyLog);
    const boardReplyReady = yield* ReplyReadiness.boardReadiness;
    const controlReplyReady = yield* ReplyReadiness.controlReadiness;
    const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    const threads = yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService);
    const shellOf = (threadId: string) =>
      Option.isNone(threads)
        ? Effect.succeed(null)
        : threads.value
            .getThreadShell(ThreadId.make(threadId))
            .pipe(Effect.orElseSucceed(() => null));
    // Delegation depth: parents walked from the caller, capped.
    const depthOf =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(function* (thread: AgentThread) {
        let depth = 0;
        let parentId =
          thread.lineage.relationshipToParent === "subagent" ? thread.lineage.parentThreadId : null;
        while (parentId !== null && depth < MAX_REPORTED_DEPTH) {
          depth += 1;
          const parent = yield* shellOf(parentId);
          parentId =
            parent?.lineage.relationshipToParent === "subagent"
              ? parent.lineage.parentThreadId
              : null;
        }
        return depth;
      });
    // Whether the caller's active run was started by a scheduled task.
    const scheduledRunOf = (threadId: string, runId: RunId | null) =>
      Option.isNone(threads) || runId === null
        ? Effect.succeed(false)
        : threads.value
            .getThreadRecords(ThreadId.make(threadId), ["runs", "messages"], {
              runIds: [runId],
              messageRoles: ["user"],
            })
            .pipe(
              Effect.map((records) => {
                const run = records.runs.find((candidate) => candidate.id === runId);
                return records.messages.some(
                  (message) =>
                    message.id === run?.userMessageId && message.scheduledTaskId !== undefined,
                );
              }),
              Effect.orElseSucceed(() => false),
            );
    const record =
      /* Request instrumentation already owns the span; keep this helper in that context. */
      Effect.fnUntraced(
        function* (
          tool: string,
          args: unknown,
          result: McpSchema.CallToolResult | undefined,
          durationMs: number,
        ) {
          if (Option.isNone(analytics)) return;
          // Client credentials (no calling thread) report an unknown caller.
          const invocation = Option.getOrUndefined(
            yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
          )?.thread;
          const providers = Option.isSome(registry) ? yield* registry.value.getProviders : [];
          // Only handoff tools pay for thread lookups; the rest report the
          // caller's provider from the credential.
          const handoff = HANDOFF_TOOLS.has(tool);
          const caller =
            handoff && invocation !== undefined
              ? ((yield* shellOf(invocation.threadId)) ?? undefined)
              : undefined;
          const targetIds = handoff
            ? [...new Set(handoffTargetIds(tool, args, result))].filter(
                (threadId) => threadId !== invocation?.threadId,
              )
            : [];
          const targets = yield* Effect.forEach(targetIds, shellOf);
          for (const properties of agentToolProperties({
            tool,
            providers,
            caller,
            ...(invocation === undefined
              ? {}
              : { callerProviderInstanceId: invocation.providerInstanceId }),
            ...(caller === undefined || invocation === undefined
              ? {}
              : {
                  callerDepth: yield* depthOf(caller),
                  callerScheduledRun: yield* scheduledRunOf(
                    invocation.threadId,
                    caller.activeRunId,
                  ),
                }),
            targets: targets.filter((thread) => thread !== null),
            outcome: toolOutcome(result),
            ...(handoff
              ? { settings: handoffSettings(tool, args, result?.structuredContent) }
              : {}),
            durationMs,
          })) {
            yield* analytics.value.record("mcp.tool.invoked", properties);
          }
        },
        (effect, _tool, _args, _result, _durationMs) => effect.pipe(Effect.ignoreCause),
      );
    const recordingServer = McpServer.McpServer.of({
      ...server,
      addTool: (options) =>
        server.addTool({
          ...options,
          handle:
            /* Request instrumentation already owns the span; keep this helper in that context. */
            Effect.fnUntraced(function* (payload) {
              const capture = yield* Effect.serviceOption(McpReplyCapture);
              if (Option.isSome(capture)) capture.value.name = options.tool.name;
              const invocation = Option.getOrUndefined(
                yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext),
              );
              return yield* Effect.acquireUseRelease(
                ledger.enter(
                  encodeJsonText([
                    invocation?.requestNamespace,
                    Option.isSome(capture) ? capture.value.sessionId : undefined,
                  ]),
                ),
                (activity) =>
                  Effect.gen(function* () {
                    // The shared tools/call span otherwise cannot be matched to a
                    // reporter after concurrent requests enter different service fibers.
                    yield* Effect.annotateCurrentSpan({
                      "mcp.tool.name": options.tool.name,
                      "mcp.caller.thread_id": invocation?.thread?.threadId ?? null,
                      "mcp.request.namespace": invocation?.requestNamespace ?? null,
                    });
                    const startedAt = yield* Clock.currentTimeMillis;
                    const started = yield* Clock.monotonicTimeNanos;
                    const delivery = yield* Effect.serviceOption(
                      McpResponseDelivery.McpResponseDelivery,
                    );
                    if (Option.isSome(delivery)) {
                      delivery.value.tool = options.tool.name;
                      if (invocation?.thread)
                        delivery.value.callerThreadId = invocation.thread.threadId;
                    }
                    const initialReaderLane = yield* NodeSqliteClient.ReaderLane;
                    const callState: McpCallAnalytics.McpCall["Service"] = {
                      ...(options.tool.name === "task_status" || options.tool.name === "task_cancel"
                        ? {
                            taskLookup: {
                              idShape: delegationIdShape(
                                typeof payload === "object" &&
                                  payload !== null &&
                                  "taskId" in payload
                                  ? payload.taskId
                                  : undefined,
                              ),
                            },
                          }
                        : {}),
                      ...(options.tool.name === "t3_thread_read"
                        ? {
                            threadRead: {
                              readerWaitMs: 0,
                              queryMs: 0,
                              renderMs: 0,
                              threadReadStages: [],
                            },
                          }
                        : {}),
                      ...(Option.isSome(capture)
                        ? {
                            requestTiming: {
                              authMs:
                                Number(capture.value.authenticatedAt - capture.value.arrivedAt) /
                                1e6,
                              dispatchMs: Number(started - capture.value.authenticatedAt) / 1e6,
                              preHandlerMs: Number(started - capture.value.arrivedAt) / 1e6,
                            },
                          }
                        : {}),
                      callerResolved: false,
                      callerResolveMs: 0,
                      callerReaderLane: initialReaderLane,
                      readerLane: initialReaderLane,
                      phase: "handler",
                      saved: "unknown",
                    };
                    if (callState.requestTiming !== undefined)
                      yield* Effect.annotateCurrentSpan({
                        "mcp.auth_ms": callState.requestTiming.authMs,
                        "mcp.dispatch_ms": callState.requestTiming.dispatchMs,
                        "mcp.pre_handler_ms": callState.requestTiming.preHandlerMs,
                      });
                    let handlerEnded: bigint | undefined;
                    let threadReadAtExit: ReturnType<typeof ThreadReadMetrics.snapshot> | undefined;
                    let cardNextAtExit:
                      | (ReturnType<typeof CardNextMetrics.snapshot> &
                          Pick<
                            McpCallAnalytics.McpCall["Service"],
                            "readerLane" | "callerResolved" | "callerResolveMs"
                          >)
                      | undefined;
                    const parentSaved = yield* SavedWrite.observer;
                    const parentCommitting = yield* SavedWrite.commitObserver;
                    const identifiers = McpCallAnalytics.callIdentifiers(
                      payload,
                      invocation?.thread?.threadId ?? invocation?.requestNamespace,
                    );
                    const isKanbanTool = Object.hasOwn(KanbanToolkit.tools, options.tool.name);
                    callState.callerRole = "none";
                    callState.callerKind =
                      invocation === undefined || invocation.thread ? "unknown" : "cli";
                    callState.resolveCallerContext = (parentThreadId) => {
                      if (callState.callerCardNumber !== undefined) return;
                      const id = parentThreadId ?? invocation?.thread?.threadId;
                      const context =
                        id && Option.isSome(kanbanContext)
                          ? kanbanContext.value.callerAnalytics?.(id)
                          : undefined;
                      const delegated =
                        parentThreadId !== undefined || context?.callerKind === "delegated_child";
                      callState.callerRole = context?.callerRole ?? "none";
                      callState.callerKind = delegated
                        ? "delegated_child"
                        : (context?.callerKind ?? (context?.boardId ? "board_thread" : "unknown"));
                      if (context) {
                        if (
                          (!isKanbanTool || identifiers.boardId === undefined) &&
                          context.boardId !== undefined
                        )
                          callState.boardId = context.boardId;
                        if (!isKanbanTool) {
                          if (context.cardId !== undefined) callState.cardId = context.cardId;
                          if (context.cardNumber !== undefined)
                            callState.cardNumber = context.cardNumber;
                          if (context.cardStage !== undefined)
                            callState.cardStage = context.cardStage;
                        }
                        if (context.cardNumber !== undefined)
                          callState.callerCardNumber = context.cardNumber;
                        if (context.cardStage !== undefined)
                          callState.callerCardStage = context.cardStage;
                      }
                    };
                    if (invocation?.thread) callState.resolveCallerContext();
                    // The request span already covers ledger capture on this hot path.
                    const row = Effect.fnUntraced(function* (
                      outcome: ReturnType<typeof McpCallAnalytics.callOutcome>,
                    ) {
                      const ended = handlerEnded ?? (yield* Clock.monotonicTimeNanos);
                      const interrupted =
                        outcome.outcome === "interrupted" ||
                        outcome.outcome === "interrupted_by_shutdown";
                      // Reserve most of the shutdown budget for recording and flushing all rows.
                      const observedCommit =
                        interrupted && options.tool.name === "delegate_task"
                          ? callState.delegation === undefined
                            ? false
                            : yield* callState.delegation.readCommitted.pipe(
                                Effect.interruptible,
                                Effect.timeout("250 millis"),
                                Effect.orElseSucceed(() => "unknown" as const),
                              )
                          : undefined;
                      // HTTP teardown follows this snapshot, so admitted handlers can still commit.
                      const committed =
                        outcome.outcome === "interrupted_by_shutdown" && observedCommit === false
                          ? "unknown"
                          : observedCommit;
                      const durationMs = Math.max(0, Number(ended - started) / 1e6);
                      const totalMs =
                        callState.requestTiming === undefined
                          ? undefined
                          : callState.requestTiming.preHandlerMs + durationMs;
                      if (totalMs !== undefined)
                        yield* Effect.annotateCurrentSpan({ "mcp.total_ms": totalMs });
                      const callerReaderLane = callState.callerReaderLane ?? initialReaderLane;
                      return {
                        ts: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
                        kind: "mcp.call" as const,
                        startedAt: DateTime.formatIso(DateTime.makeUnsafe(startedAt)),
                        bootId: callBootId,
                        surface: "server" as const,
                        route: "mcp",
                        tool: options.tool.name,
                        build,
                        ...identifiers,
                        ...(callState.boardId ? { boardId: callState.boardId } : {}),
                        ...(callState.cardId ? { cardId: callState.cardId } : {}),
                        ...(invocation?.thread
                          ? { callerThreadId: invocation.thread.threadId }
                          : {}),
                        callerRole: callState.callerRole ?? "none",
                        callerKind: callState.callerKind ?? "unknown",
                        ...(callState.cardNumber === undefined
                          ? {}
                          : { cardNumber: callState.cardNumber }),
                        ...(callState.callerCardNumber === undefined
                          ? {}
                          : { callerCardNumber: callState.callerCardNumber }),
                        ...(callState.callerCardStage === undefined
                          ? {}
                          : { callerCardStage: callState.callerCardStage }),
                        ...(callState.writePhases === undefined
                          ? {}
                          : { writePhases: callState.writePhases }),
                        ...(callState.cardStage === undefined
                          ? {}
                          : { cardStage: callState.cardStage }),
                        ...(callState.denyReason === undefined
                          ? {}
                          : { denyReason: callState.denyReason }),
                        ...(callState.replyStage === undefined
                          ? {}
                          : { replyStage: callState.replyStage }),
                        ...(callState.replyPhases === undefined
                          ? {}
                          : { replyPhases: callState.replyPhases }),
                        ...(callState.requestTiming === undefined
                          ? {}
                          : { requestTiming: callState.requestTiming }),
                        callerResolved: callState.callerResolved,
                        callerResolveMs:
                          callState.callerResolveMs +
                          (callState.callerStarted === undefined
                            ? 0
                            : Math.max(0, Number(ended - callState.callerStarted) / 1e6)),
                        callerReaderLane,
                        readerLane: callerReaderLane,
                        ...(callState.cardNext === undefined
                          ? {}
                          : (cardNextAtExit ??
                            CardNextMetrics.snapshot(callState.cardNext, ended))),
                        ...(callState.waitStage === undefined
                          ? {}
                          : { waitStage: callState.waitStage }),
                        ...(callState.waitLookupMs === undefined
                          ? {}
                          : { waitLookupMs: callState.waitLookupMs }),
                        durationMs,
                        ...(callState.threadRead === undefined
                          ? {}
                          : {
                              ...(threadReadAtExit ??
                                ThreadReadMetrics.snapshot(callState.threadRead, ended)),
                              inFlightAtStart: activity.inFlightAtStart,
                            }),
                        ...callState.requestTiming,
                        ...(totalMs === undefined ? {} : { totalMs }),
                        ...outcome,
                        ...(Option.isSome(delivery) ? delivery.value.snapshot() : {}),
                        props: {
                          ...outcome.props,
                          ...(callState.boardId ? { boardId: callState.boardId } : {}),
                          ...(callState.cardNumber === undefined
                            ? {}
                            : { cardNumber: callState.cardNumber }),
                          saved: outcome.saved ?? "unknown",
                        },
                        ...(committed === undefined
                          ? {}
                          : {
                              committed,
                              ...(committed === true && callState.delegation !== undefined
                                ? { taskId: callState.delegation.taskId }
                                : {}),
                            }),
                      };
                    });
                    const complete = yield* ledger.begin(() =>
                      row({
                        outcome: "interrupted_by_shutdown",
                        props: {
                          code: "unknown",
                          cause: "shutdown",
                          ...(callState.taskLookup?.foundBy === undefined
                            ? {}
                            : { foundBy: callState.taskLookup.foundBy }),
                          ...(callState.taskLookup?.idCanonical === undefined
                            ? {}
                            : { idCanonical: callState.taskLookup.idCanonical }),
                          ...(callState.taskLookup?.idShape === undefined
                            ? {}
                            : { idShape: callState.taskLookup.idShape }),
                        },
                        saved: callState.saved,
                        errorPhase: callState.phase,
                      }),
                    );
                    if (Option.isNone(complete))
                      return new McpSchema.CallToolResult({
                        isError: true,
                        content: [
                          { type: "text", text: "Robob is restarting; retry after reconnecting." },
                        ],
                        structuredContent: { reason: "server_shutting_down", bootId: callBootId },
                      });
                    if (options.tool.name === "card_next")
                      yield* Effect.logInfo("MCP card_next started", {
                        threadId: invocation?.thread?.threadId ?? "unknown",
                        startedAt,
                      });
                    const rejection = { exceeded: false };
                    const readiness = BOARD_READ_TOOLS.has(options.tool.name)
                      ? boardReplyReady
                      : options.tool.name === "list_scheduled_tasks"
                        ? controlReplyReady
                        : Effect.void;
                    const largeRead = LARGE_READ_TOOLS.has(options.tool.name);
                    let phase: "lane" | "readiness" | "handler" = "lane";
                    let phaseStarted = yield* Clock.monotonicTimeNanos;
                    const readStarted = phaseStarted;
                    const timings = { readinessWaitMs: 0, laneWaitMs: 0, handlerMs: 0 };
                    const phaseKey = {
                      lane: "laneWaitMs",
                      readiness: "readinessWaitMs",
                      handler: "handlerMs",
                    } as const;
                    // The tools/call span owns these timings, including an interrupted wait.
                    const advance = Effect.fnUntraced(function* (next: typeof phase) {
                      const now = yield* Clock.monotonicTimeNanos;
                      timings[phaseKey[phase]] += Number(now - phaseStarted) / 1e6;
                      phase = next;
                      phaseStarted = now;
                    });
                    const result = readiness
                      .pipe(Effect.andThen(largeRead ? advance("handler") : Effect.void))
                      .pipe(Effect.andThen(options.handle(payload)))
                      .pipe(Effect.map(withFailureStructuredContent))
                      .pipe(Effect.provideService(ReplyRejection, rejection));
                    // Large reads run on their own "mcp" lane (whole call, so at most
                    // PERMITS.mcp large results are built at once). They queue only behind
                    // each other, never behind control polls, lists or snapshots (10 Nov
                    // 2026: t3_thread_read held the shared agent lane up to 153 s).
                    let measuredResult: unknown;
                    let replyBytes = 0;
                    const check = <A>(built: A): A | McpSchema.CallToolResult => {
                      // MCP repeats the result as text and structuredContent; leave envelope headroom.
                      if (!rejection.exceeded) {
                        replyBytes = jsonBytesUpToLimit(built, MAX_REPLY_BYTES - 4096);
                        measuredResult = built;
                        if (replyBytes <= MAX_REPLY_BYTES - 4096) return built;
                      }
                      if (Option.isSome(largeRepliesForTools))
                        largeRepliesForTools.value.record({
                          kind: "mcp",
                          name: options.tool.name,
                          bytes: MAX_REPLY_BYTES + 1,
                          rejected: true,
                        });
                      return new McpSchema.CallToolResult({
                        isError: true,
                        content: [{ type: "text", text: REPLY_TOO_LARGE }],
                      });
                    };
                    const completed = result.pipe(
                      (call) =>
                        largeRead
                          ? ReplyBuilders.bounded(
                              advance("readiness").pipe(Effect.andThen(Effect.map(call, check))),
                              "mcp",
                            )
                          : Effect.map(call, check),
                      Effect.catchCauseIf(
                        (cause) =>
                          cause.reasons.some(
                            (reason) =>
                              Cause.isDieReason(reason) && reason.defect instanceof ReplyTooLarge,
                          ),
                        () => {
                          if (Option.isSome(largeRepliesForTools))
                            largeRepliesForTools.value.record({
                              kind: "mcp",
                              name: options.tool.name,
                              bytes: MAX_REPLY_BYTES + 1,
                              rejected: true,
                            });
                          return Effect.succeed(
                            new McpSchema.CallToolResult({
                              isError: true,
                              content: [{ type: "text", text: REPLY_TOO_LARGE }],
                            }),
                          );
                        },
                      ),
                    );
                    // Reuse the bounded-read waiter so masked SQLite cleanup cannot hold the reply.
                    const boundedRead =
                      options.tool.name === "list_scheduled_tasks"
                        ? McpDeadline.awaitInterruptibly(completed).pipe(
                            Effect.timeoutOrElse({
                              duration: "20 seconds",
                              orElse: Effect.fn("McpHttpServer.scheduledReadBusy")(function* () {
                                const now = yield* Clock.monotonicTimeNanos;
                                return new McpSchema.CallToolResult({
                                  isError: true,
                                  content: [
                                    {
                                      type: "text",
                                      text: "Robob is busy; nothing was read. Retry the same call.",
                                    },
                                  ],
                                  structuredContent: {
                                    reason: "server_busy",
                                    phase,
                                    waitedMs: Number(now - readStarted) / 1e6,
                                  },
                                });
                              }),
                            }),
                          )
                        : options.tool.name === "t3_thread_read"
                          ? ThreadReadDeadline.bound(completed)
                          : completed;
                    const protectedRead = SavedBoardReply.TIMED_TOOLS.has(options.tool.name)
                      ? SavedBoardReply.protect(boundedRead, options.tool.name)
                      : boundedRead;
                    // Keep read timings on tools/call, outside the saved-reply child span.
                    const measuredRead = largeRead
                      ? protectedRead.pipe(
                          Effect.onExit((exit) =>
                            Effect.gen(function* () {
                              const now = yield* Clock.monotonicTimeNanos;
                              const elapsed = { ...timings };
                              elapsed[phaseKey[phase]] += Number(now - phaseStarted) / 1e6;
                              const result = exit._tag === "Success" ? exit.value : undefined;
                              const content =
                                result !== undefined && "structuredContent" in result
                                  ? result.structuredContent
                                  : undefined;
                              yield* Effect.annotateCurrentSpan({
                                ...elapsed,
                                replyBytes:
                                  result === undefined
                                    ? 0
                                    : result === measuredResult
                                      ? replyBytes
                                      : jsonBytesUpToLimit(result),
                                ...(options.tool.name === "list_scheduled_tasks"
                                  ? {
                                      taskCount:
                                        content !== null &&
                                        typeof content === "object" &&
                                        "tasks" in content &&
                                        Array.isArray(content.tasks)
                                          ? content.tasks.length
                                          : 0,
                                    }
                                  : {}),
                              });
                            }),
                          ),
                        )
                      : protectedRead;
                    return yield* measuredRead.pipe(
                      Effect.provideService(McpCallAnalytics.McpCall, callState),
                      Effect.provideService(SavedWrite.observer, (receipt) => {
                        callState.saved = true;
                        if (receipt.kind === "card" && callState.cardId === undefined) {
                          callState.boardId = receipt.card.boardId;
                          callState.cardId = receipt.card.id;
                          callState.cardNumber = receipt.card.number;
                          callState.cardStage = receipt.card.stage;
                        }
                        parentSaved(receipt);
                      }),
                      Effect.provideService(SavedWrite.commitObserver, () => {
                        if (callState.saved !== true) callState.saved = "unknown";
                        parentCommitting();
                      }),
                      Effect.onExit((exit) => {
                        const result = exit._tag === "Success" ? exit.value : undefined;
                        // Handoff tools look up threads to record; the response must not wait on them.
                        return Effect.gen(function* () {
                          const endedAt = yield* Clock.currentTimeMillis;
                          handlerEnded = yield* Clock.monotonicTimeNanos;
                          // Detached cancellation cleanup can finish before response delivery.
                          if (callState.threadRead !== undefined)
                            threadReadAtExit = ThreadReadMetrics.snapshot(
                              callState.threadRead,
                              handlerEnded,
                            );
                          if (callState.cardNext !== undefined) {
                            const timings = CardNextMetrics.snapshot(
                              callState.cardNext,
                              handlerEnded,
                            );
                            cardNextAtExit = {
                              ...timings,
                              readerLane: callState.readerLane,
                              callerResolved: callState.callerResolved,
                              callerResolveMs:
                                timings.cardNextStages.find((part) => part.stage === "caller")
                                  ?.durationMs ?? 0,
                            };
                          }
                          const resolved = {
                            ...(identifiers.boardId ? { boardId: identifiers.boardId } : {}),
                            ...(callState.boardId ? { boardId: callState.boardId } : {}),
                            ...(callState.cardId ? { cardId: callState.cardId } : {}),
                          };
                          const outcome = McpCallAnalytics.callOutcome(exit, callState);
                          if (options.tool.name === "card_next")
                            yield* Effect.logInfo("MCP card_next finished", {
                              threadId: invocation?.thread?.threadId ?? "unknown",
                              durationMs: Math.max(0, endedAt - startedAt),
                              outcome: outcome.outcome,
                            });
                          // Waiting here would prevent the response from being written. Keep the
                          // ledger entry pending until Node finishes or loses the response instead.
                          const writeRow = complete
                            .value(row(outcome))
                            .pipe(
                              Effect.interruptible,
                              Effect.timeout("1 second"),
                              Effect.ignoreCause,
                            );
                          if (Option.isSome(delivery))
                            yield* delivery.value.settled.pipe(
                              Effect.andThen(writeRow),
                              Effect.forkDetach,
                            );
                          else yield* writeRow;
                          yield* Effect.gen(function* () {
                            // The anonymous analytics event counts the completed input retry only.
                            if (result instanceof McpSchema.InputRequired) return;
                            if (
                              Option.isSome(ownerAnalytics) &&
                              options.tool.name !== "analytics_read"
                            ) {
                              const failed =
                                exit._tag === "Failure" ||
                                (result !== undefined &&
                                  "isError" in result &&
                                  result.isError === true);
                              yield* recordServerAnalytics(ownerAnalytics.value, {
                                ts: DateTime.formatIso(DateTime.makeUnsafe(endedAt)),
                                kind: failed ? "server.mcp.error" : "server.mcp",
                                surface: "server",
                                route: "mcp",
                                ...resolved,
                                ...(invocation?.thread === undefined
                                  ? {}
                                  : { threadId: invocation.thread.threadId }),
                                durationMs: Math.max(0, endedAt - startedAt),
                                props: {
                                  ...outcome.props,
                                  saved: outcome.saved ?? "unknown",
                                  ...(callState.boardId
                                    ? { boardId: callState.boardId }
                                    : identifiers.boardId
                                      ? { boardId: identifiers.boardId }
                                      : {}),
                                  ...(callState.cardNumber === undefined
                                    ? {}
                                    : { cardNumber: callState.cardNumber }),
                                  method: options.tool.name,
                                  span: "mcp.tools.call",
                                  originKind:
                                    invocation?.thread === undefined ? "mcp-client" : "agent",
                                  ...(failed
                                    ? {
                                        errorTag:
                                          exit._tag === "Failure"
                                            ? analyticsErrorTag(exit.cause)
                                            : "McpToolError",
                                      }
                                    : {}),
                                },
                              });
                            }
                            yield* record(options.tool.name, payload, result, endedAt - startedAt);
                          }).pipe(Effect.ignoreCause, Effect.forkDetach);
                        }).pipe(Effect.asVoid);
                      }),
                    );
                  }),
                (activity) => activity.release,
              );
            }),
        }),
    });
    return yield* registration.pipe(Effect.provideService(McpServer.McpServer, recordingServer));
  });

/**
 * `McpServer.toolkit` asks for every service its tools declare when it
 * registers them, but the auth middleware provides `McpInvocationContext` to
 * each request instead. Registration must not get one: the services it
 * captures would replace the request's.
 */
export const toolkitRegistration = <Tools extends Record<string, Tool.Any>, EX, RX>(
  toolkit: Toolkit.Toolkit<Tools>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) => {
  const registration = Layer.effectDiscard(
    withToolAnalytics(McpServer.registerToolkit(decodeAsAdvertised(toolkit))),
  ).pipe(Layer.provide(McpServer.McpServer.layer), Layer.provide(McpCallLedger.layer));
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off - the auth middleware provides it per request.
  const registered = registration as Layer.Layer<
    never,
    never,
    Exclude<Layer.Services<typeof registration>, McpInvocationContext.McpInvocationContext>
  >;
  return registered.pipe(Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)));
};

const imageToolRegistration = <Tools extends Record<string, Tool.Any>, A, E, R, EX, RX>(
  register: Effect.Effect<A, E, R>,
  handlers: McpToolAccess.HandlersLayer<Tools, EX, RX>,
) =>
  Layer.effectDiscard(withToolAnalytics(register)).pipe(
    Layer.provide(McpToolAccess.HandlersLayer.layer(handlers)),
    Layer.provide(McpCallLedger.layer),
  );

export const layerHtmlToolkit = Layer.mergeAll(
  toolkitRegistration(HtmlRenderToolkit, HtmlHandlers.layerRender),
  imageToolRegistration(registerHtmlPreview(), HtmlHandlers.layerPreview),
).pipe(Layer.provide(HtmlRender.layer));

const layerPreviewStandardToolkitRegistration = toolkitRegistration(
  PreviewStandardToolkit,
  PreviewHandlers.layerStandard,
);

const layerPreviewSnapshotRegistration = imageToolRegistration(
  registerPreviewSnapshot(),
  PreviewHandlers.layerSnapshot,
);

export const layerPreviewToolkit = Layer.mergeAll(
  layerPreviewStandardToolkitRegistration,
  layerPreviewSnapshotRegistration,
);

export const layerOrchestratorToolkit = toolkitRegistration(
  OrchestratorToolkit,
  OrchestratorHandlers.layer,
).pipe(Layer.provide(OrchestratorMcpService.layer), Layer.provide(ThreadMetadataMcpService.layer));

export const layerThreadToolkit = toolkitRegistration(ThreadToolkit, ThreadHandlers.layer);

const layerWorktreeToolkitRegistration = toolkitRegistration(
  WorktreeToolkit,
  WorktreeHandlers.layer,
).pipe(Layer.provide(WorktreeMcpService.layer));
// ardud: missions board (KanbanService comes from ArdudKanbanLive in server.ts)
const layerKanbanToolkitRegistration = toolkitRegistration(KanbanToolkit, KanbanHandlers.layer);
const layerContextResetToolkitRegistration = toolkitRegistration(
  ContextResetToolkit,
  ContextResetHandlers.layer,
).pipe(Layer.provide(ContextResetService.layer));
const layerImessageSendToolkitRegistration = toolkitRegistration(
  ImessageSendToolkit,
  ImessageSendHandlers.layer,
).pipe(
  Layer.provide(
    ImessageSendService.layer.pipe(
      Layer.provide(Layer.mergeAll(ControlStore.layer, ImessageBridgeCli.layer)),
    ),
  ),
);
const layerScheduledTaskBlockRetryRegistration = toolkitRegistration(
  ScheduledTaskBlockRetry.ScheduledTaskBlockRetryToolkit,
  ScheduledTaskBlockRetry.layer,
);

const layerPreviewControlsRegistration = toolkitRegistration(
  PreviewControlsToolkit,
  PreviewControlsHandlers.layer,
);

export const layerEnvironmentToolkit = toolkitRegistration(
  EnvironmentToolkit,
  EnvironmentHandlers.layer,
).pipe(Layer.provide(ThreadCommandExecutor.layer));

const layerProjectRegistration = toolkitRegistration(ProjectToolkit, ProjectHandlers.layer);

export const layerAttachmentToolkit = toolkitRegistration(
  AttachmentToolkit,
  AttachmentHandlers.layer,
);

export const layerPullRequestsToolkit = toolkitRegistration(
  PullRequestsToolkit,
  PullRequestsHandlers.layer,
);

const layerDeviceStandardToolkitRegistration = toolkitRegistration(
  DeviceStandardToolkit,
  DeviceHandlers.layerStandard,
);

const layerDeviceScreenshotRegistration = imageToolRegistration(
  registerDeviceScreenshot(),
  DeviceHandlers.layerScreenshot,
);

export const layerDeviceToolkit = Layer.mergeAll(
  layerDeviceStandardToolkitRegistration,
  layerDeviceScreenshotRegistration,
);

export const layerMcpTransport = McpServer.layerHttp({
  name: "T3 Code",
  version: packageJson.version,
  path: "/mcp",
  protocols: [McpProtocol.v2025_06_18],
  allowSessionTermination: true,
}).pipe(Layer.provide(layerMcpAuthMiddleware));

export const layer = Layer.mergeAll(
  toolkitRegistration(AnalyticsToolkit, AnalyticsHandlers.layer),
  layerPreviewToolkit,
  layerOrchestratorToolkit,
  layerThreadToolkit,
  layerAttachmentToolkit,
  layerProjectRegistration,
  layerEnvironmentToolkit,
  layerPreviewControlsRegistration,
  layerWorktreeToolkitRegistration,
  layerContextResetToolkitRegistration,
  layerImessageSendToolkitRegistration,
  layerScheduledTaskBlockRetryRegistration,
  // ardud: missions board
  layerKanbanToolkitRegistration,
  layerPullRequestsToolkit,
  layerDeviceToolkit,
  layerHtmlToolkit,
).pipe(Layer.provideMerge(layerMcpTransport));

export const layerRedactionToolkit = toolkitRegistration(
  RedactionTools.ThreadRedactionToolkit,
  RedactionTools.layer,
);
