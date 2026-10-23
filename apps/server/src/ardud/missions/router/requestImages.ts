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

export interface StoredRequestImages {
  /** In the order they were given. */
  readonly images: ReadonlyArray<StoredRequestImage>;
  /** Drops the images this call created, for a message that never lands. */
  readonly undo: Effect.Effect<void>;
}

/** Stores a message's images together: a bad one stores none. */
export type StoreRequestImages = (input: {
  readonly missionId: MissionId;
  readonly requestId: OwnerRequestId;
  readonly images: ReadonlyArray<OwnerRequestImage>;
  readonly provenance: MissionProvenance;
}) => Effect.Effect<StoredRequestImages, MissionError>;

/**
 * Stores a request message's images as mission images about the request.
 * The views track owns the image store and sits above the router, so it
 * registers the store here at startup.
 */
export class RequestImages extends Context.Service<
  RequestImages,
  {
    readonly register: (store: StoreRequestImages) => Effect.Effect<void>;
    readonly store: StoreRequestImages;
  }
>()("t3/ardud/missions/router/requestImages") {}

const unwired: StoreRequestImages = () =>
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
