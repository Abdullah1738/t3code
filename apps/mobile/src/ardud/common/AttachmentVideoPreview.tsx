/**
 * A video attachment on the attachment screen, played by the app's own player.
 *
 * - Every attempt to play asks the server for a fresh address. The address a
 *   file opens with is signed for an hour; a screen left open past that would
 *   otherwise retry the dead address for ever. A file still on the phone has
 *   no address to renew and plays from where it is.
 * - The player and its still frame are kept under a key that names the server
 *   (`attachmentVideoKey`), so the same attachment id on another server never
 *   shows this one's frame.
 */
import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { View } from "react-native";

import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { useRefreshAssetUrl } from "../../state/assets";

export function AttachmentVideoPreview(props: {
  readonly name: string;
  /** Where the file is now: a signed address, or a file on the phone. */
  readonly uri: string;
  /** The file is on the phone (a draft's attachment): nothing to renew. */
  readonly local: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly resource: Extract<AssetResource, { readonly _tag: "attachment" }>;
  readonly videoKey: string;
  readonly sizeBytes: number;
}) {
  const { uri, local } = props;
  const renew = useRefreshAssetUrl(local ? null : props.environmentId, props.resource);
  return (
    <View className="flex-1 items-center justify-center bg-sheet p-4">
      <MediaVideoPlayer
        uri={uri}
        resolvePlaybackUri={async () => (local ? uri : renew())}
        name={props.name}
        thumbnailKey={props.videoKey}
      />
    </View>
  );
}
