# Federation policy

Effective date: {{EFFECTIVE_DATE}}.

feddit.com exchanges public discussions with independent ActivityPub servers. An invitation controls local account creation, not all incoming content. We apply our rules to what our instance shows and relays.

## Peer review

New or unknown peers begin quarantined: text only, subject to moderation, link checks and rate limits. Media stays off until the administrator checks the server's moderation contact, public rules, response to credible abuse and recent incidents. Quarantine does not mean that text is safe; child-abuse links, grooming, threats and scams are also actionable. The 131 communities feddit.com already followed before cutover are imported as accepted follows; their servers are not quarantined as new peers but remain subject to the restrictions below.

We may restrict media, pause a peer's inbox, hide particular objects or defederate for persistent illegal material, sexual exploitation, harassment, unmoderated pornography, repeated failure to respond to serious reports, malicious traffic or evasion of restrictions. We choose the narrowest effective action when feasible. Serious harm can require an immediate server-wide block.

We record the reason, scope and review date. An affected peer operator can ask for review at {{CONTACT_EMAIL}}, supplying remediation details. Reconnection requires evidence that the cause is fixed, followed by a limited text-only trial. Peer block lists are leads to review, not automatic proof of misconduct.

## Remote media and deletion

Remote NSFW or sensitive content is rejected by default. All remote media, including link-preview thumbnails, is fetched at view time through a signed non-persisting proxy; we do not hotlink or mirror it. Proxy safety checks and emergency blocks apply before delivery. An image may be served from Cloudflare's edge cache for up to one hour if, when it was fetched, the content it belongs to could be seen by anyone without signing in. When that content or its source is taken down, we request its removal from that cache, normally within about 20 seconds and again about two minutes later; if removal fails, it may be served from there until its hour is up. Images of content that only some viewers could see when they were fetched, such as sensitive or removed content, are not put there. Public text and activity metadata may be cached locally. No media from remote servers is stored on our servers or in our storage: previews of remote content are fetched through the proxy and not kept, and nothing will be stored until our safety scanning is live.

We can stop serving a remote object locally and block its proxy URL, or every proxy URL from a remote domain. Because the proxy keeps nothing, there is no stored remote copy to purge; we also request removal of any copy Cloudflare's edge cache may serve, as described above. We may send a federated report to the originating administrator using only necessary details. We do not send a survivor's identity or harmful attachment to an unsafe origin.

Local deletions are sent to peers and known remote deletions are applied locally. Remote operators, archives and users may retain copies, so neither deletion nor defederation recalls everything already delivered. We do not treat a non-persisting proxy as immunity from responsibility for content shown through it.
