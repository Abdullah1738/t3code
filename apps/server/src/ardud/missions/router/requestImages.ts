import {
  MissionError,
  type MissionId,
  type MissionProvenance,
  type OwnerRequestId,
  type OwnerRequestImage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export interface StoredRequestImage {
  readonly assetId: string;
  /** The stored copy on this server, which agents read. */
  readonly path: string;
}

export type StoreRequestImage = (input: {
  readonly missionId: MissionId;
  readonly requestId: OwnerRequestId;
  readonly image: OwnerRequestImage;
  readonly provenance: MissionProvenance;
}) => Effect.Effect<StoredRequestImage, MissionError>;

/**
 * Stores a request message's images as mission images about the request.
 * The views track owns the image store and sits above the router, so it
 * registers the store here at startup.
 */
export class RequestImages extends Context.Service<
  RequestImages,
  {
    readonly register: (store: StoreRequestImage) => Effect.Effect<void>;
    readonly store: StoreRequestImage;
  }
>()("t3/ardud/missions/router/requestImages") {}

const unwired: StoreRequestImage = () =>
  Effect.fail(
    new MissionError({ code: "invalid", detail: "This server can't store request images." }),
  );

export const requestImagesRegistry = Layer.effect(
  RequestImages,
  Effect.gen(function* () {
    const current = yield* Ref.make(unwired);
    return RequestImages.of({
      register: (store) => Ref.set(current, store),
      store: (input) => Effect.flatMap(Ref.get(current), (store) => store(input)),
    });
  }),
);
