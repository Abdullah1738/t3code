import type { MissionLink, MissionRecordRef } from "@t3tools/contracts";
import { refLabel } from "@t3tools/client-runtime/ardud/missions";

import { linkKey } from "./cards/chips";

// Pure presentation.

/** Links spaced apart on one wrapping line. */
export function MissionLinkList(props: { links: ReadonlyArray<MissionLink | MissionRecordRef> }) {
  return (
    <span className="inline-flex min-w-0 flex-wrap gap-x-3 gap-y-0.5">
      {props.links.map((link) => (
        <MissionLinkText key={linkKey(link)} link={link} />
      ))}
    </span>
  );
}

/** A link record as an anchor when it has a URL, plain text otherwise. */
export function MissionLinkText(props: { link: MissionLink | MissionRecordRef }) {
  const link = props.link;
  if ("id" in link) return <span className="text-foreground">{refLabel(link)}</span>;
  if (link.url === null) return <span className="text-foreground">{link.label}</span>;
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      className="text-foreground underline underline-offset-2 hover:text-primary"
    >
      {link.label}
    </a>
  );
}
