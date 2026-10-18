import type { MissionLink, MissionRecordRef } from "@t3tools/contracts";
import { refLabel } from "@t3tools/client-runtime/ardud/missions";

// Pure presentation.

function linkKey(link: MissionLink | MissionRecordRef): string {
  return "id" in link
    ? `${link.kind}:${link.id}`
    : `${link.kind}:${link.url ?? link.ref ?? link.label}`;
}

/** Links separated by dots. */
export function MissionLinkList(props: { links: ReadonlyArray<MissionLink | MissionRecordRef> }) {
  return props.links.map((link, index) => (
    <span key={linkKey(link)}>
      {index > 0 ? " · " : null}
      <MissionLinkText link={link} />
    </span>
  ));
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
