import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

/** 9router serves the Antigravity account's models under this prefix. */
export const ANTIGRAVITY_GATEWAY_MODEL_PREFIX = "ag/";

const ANTIGRAVITY_GATEWAY_TIMEOUT = "10 seconds";

export interface AntigravityGatewayModel {
  readonly id: string;
  readonly name: string;
}

export class AntigravityGatewayError extends Schema.TaggedError<AntigravityGatewayError>()(
  "AntigravityGatewayError",
  { detail: Schema.String },
) {}

const ModelsResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeModelsResponse = Schema.decodeUnknownEffect(ModelsResponse);

export function antigravityGatewayModelsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/v1/models`;
}

/** Keeps the gateway's `ag/*` models in its own order, without duplicates or blank ids. */
export function selectAntigravityGatewayModels(
  entries: ReadonlyArray<{ readonly id: string; readonly name?: string | null | undefined }>,
): ReadonlyArray<AntigravityGatewayModel> {
  const seen = new Set<string>();
  return entries.flatMap((entry): AntigravityGatewayModel[] => {
    const id = entry.id.trim();
    // The runtime splits its model allowlist on commas.
    if (!id.startsWith(ANTIGRAVITY_GATEWAY_MODEL_PREFIX) || id.includes(",") || seen.has(id)) {
      return [];
    }
    seen.add(id);
    const name = entry.name?.trim();
    return [{ id, name: name ? name : id }];
  });
}

/**
 * Reads the gateway's model list. The runtime never fetches `/v1/models` itself, so this list
 * becomes its model fleet. Errors name the URL and status, never the key.
 */
export const fetchAntigravityGatewayModels = Effect.fn("fetchAntigravityGatewayModels")(
  function* (input: { readonly baseUrl: string; readonly apiKey: string }) {
    const client = yield* HttpClient.HttpClient;
    const url = antigravityGatewayModelsUrl(input.baseUrl);
    const unreachable = (reason: string) =>
      new AntigravityGatewayError({
        detail: `The Antigravity gateway at ${input.baseUrl} is unreachable (${reason}). Start it or fix the gateway URL in the Antigravity provider settings.`,
      });
    // One deadline covers the request, the body and its decoding, so a gateway that sends
    // headers and then stalls can't hold up provider refreshes.
    const body = yield* Effect.gen(function* () {
      const response = yield* client
        .execute(
          HttpClientRequest.get(url).pipe(
            HttpClientRequest.setHeaders({
              accept: "application/json",
              ...(input.apiKey ? { authorization: `Bearer ${input.apiKey}` } : {}),
            }),
          ),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.mapError(() => unreachable("connection failed")),
        );
      if (response.status === 401 || response.status === 403) {
        return yield* new AntigravityGatewayError({
          detail: `The Antigravity gateway at ${input.baseUrl} rejected the gateway key (HTTP ${response.status}).`,
        });
      }
      if (response.status < 200 || response.status >= 300) {
        return yield* unreachable(`HTTP ${response.status}`);
      }
      return yield* response.json.pipe(
        Effect.flatMap(decodeModelsResponse),
        Effect.mapError(() => unreachable("its model list could not be read")),
      );
    }).pipe(
      Effect.timeoutOrElse({
        duration: ANTIGRAVITY_GATEWAY_TIMEOUT,
        orElse: () => Effect.fail(unreachable("no answer within 10 seconds")),
      }),
    );
    const models = selectAntigravityGatewayModels(body.data);
    if (models.length === 0) {
      return yield* new AntigravityGatewayError({
        detail: `The Antigravity gateway at ${input.baseUrl} lists no ${ANTIGRAVITY_GATEWAY_MODEL_PREFIX}* models. Connect an Antigravity account to it.`,
      });
    }
    return models;
  },
);
