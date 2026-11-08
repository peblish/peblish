import {
  Create,
  Delete,
  Link,
  Note,
  Page,
  PUBLIC_COLLECTION,
  Source,
  Tombstone,
  Update,
} from "@fedify/vocab";
import { marked } from "marked";
import { Temporal } from "temporal-polyfill";
import { ORIGIN } from "./config.ts";
import type { ObjectKind, ObjectRow } from "./db.ts";

export function markdownToHtml(markdown: string): string {
  return marked.parse(markdown, { async: false }).trim();
}

export function localObjectUri(kind: ObjectKind, id: string): URL {
  return new URL(`/ap/${kind === "Page" ? "post" : "comment"}/${id}`, ORIGIN);
}

// UUID path segments, never a URL inside a fragment: Lemmy's parser rejects those.
export function newActivityUri(type: string): URL {
  return new URL(`/ap/activities/${type.toLowerCase()}/${crypto.randomUUID()}`, ORIGIN);
}

export function toInstant(date: Date): Temporal.Instant {
  return Temporal.Instant.fromEpochMilliseconds(date.getTime());
}

/**
 * Builds the wire object for a stored post or comment. Interop rules applied:
 * HTML `content` plus Markdown `source`, `audience` = the Group, the full
 * Public IRI in `to`, and (Pages) a Link attachment for link posts, which is
 * what Lemmy 0.19 reads as the post URL.
 */
export function toVocab(row: ObjectRow): Page | Note | Tombstone {
  const id = new URL(row.uri);
  if (row.deleted) {
    return new Tombstone({ id, deleted: toInstant(row.updated ?? new Date()) });
  }
  const community = row.community_uri ? new URL(row.community_uri) : null;
  const common = {
    id,
    attribution: new URL(row.author_uri),
    content: row.content_html,
    mediaType: "text/html",
    source:
      row.source_md == null
        ? null
        : new Source({ content: row.source_md, mediaType: "text/markdown" }),
    audience: community,
    published: toInstant(row.published),
    updated: row.updated ? toInstant(row.updated) : null,
    sensitive: false,
  };
  if (row.kind === "Page") {
    return new Page({
      ...common,
      name: row.title,
      tos: community ? [community, PUBLIC_COLLECTION] : [PUBLIC_COLLECTION],
      attachments: row.link_url ? [new Link({ href: new URL(row.link_url) })] : [],
    });
  }
  return new Note({
    ...common,
    replyTarget: row.in_reply_to ? new URL(row.in_reply_to) : null,
    tos: [PUBLIC_COLLECTION],
    ccs: community ? [community] : [],
  });
}

// Lemmy's CreateOrUpdatePage/Note require both `to` and `cc` to be present, and
// Fedify omits empty arrays, so `cc` always carries the community.
function envelope(actor: URL, community: URL | null) {
  return {
    actor,
    tos: [PUBLIC_COLLECTION],
    ccs: community ? [community] : [],
    audience: community,
  };
}

export function createFor(
  actor: URL,
  object: Page | Note,
  community: URL | null,
  id: URL = newActivityUri("Create"),
): Create {
  return new Create({ id, object, ...envelope(actor, community) });
}

export function updateFor(actor: URL, object: Page | Note, community: URL | null): Update {
  return new Update({ id: newActivityUri("Update"), object, ...envelope(actor, community) });
}

// Lemmy 0.19 checks the Public IRI in `to` specifically for Delete.
export function deleteFor(actor: URL, objectUri: URL, community: URL | null): Delete {
  return new Delete({ id: newActivityUri("Delete"), object: objectUri, ...envelope(actor, community) });
}
