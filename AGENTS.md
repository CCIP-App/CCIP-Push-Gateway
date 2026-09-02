# AGENTS.md

## Purpose and scope

This file applies to the entire repository. It is the operating contract for coding agents, not a replacement for the project documentation or API specification.

Keep this file concise and durable. Put rationale in an ADR, wire-level details in `openapi.yaml`, and human-oriented orientation in `README.md`.

## Start here

Before changing anything:

1. Read `README.md` for the repository scope.
2. Read the accepted ADRs relevant to the task under `docs/adr/`. ADR 0001 is foundational and must be read before changing authentication, event isolation, topic routing, credentials, delivery semantics, or observability.
3. Read `openapi.yaml` before changing any HTTP behavior.
4. Inspect the working tree and preserve unrelated or uncommitted user changes.

Sources of truth:

- `openapi.yaml` is normative for the public HTTP contract.
- Accepted ADRs are normative for architecture, trust boundaries, and tradeoffs.
- `README.md` is an overview for human collaborators.
- This file governs how agents work in this repository.

When behavior and documentation disagree, do not silently choose one. Identify the mismatch and update the authoritative artifact as part of the requested change.

## Current project state

This is currently a documentation-first repository. It has no Worker implementation, package manager, build system, or test runner yet. Do not add scaffolding, dependencies, or deployment configuration unless the task requires implementation.

When the first implementation is added, update this file with the actual install, validation, test, and local-development commands. Never invent commands that do not exist in the repository.

## Non-negotiable architecture

- The Gateway is a centrally operated Cloudflare Worker that sends through the FCM HTTP v1 API.
- `CCIP-Admin-Bueno` calls the Gateway directly from the browser. It reuses `CCIP-Server`'s existing roles endpoint as the source of the role list, but `CCIP-Server` must not gain a push endpoint or Gateway credential and is not in the push delivery path.
- Admin expands the UI choice "all" from that role list into concrete `roles[]`; neither the Gateway nor FCM has an `.all` topic.
- Each event Gateway key is bound centrally to exactly one permanent and unique `EVENT_ID`. The Gateway derives the event from the authenticated key.
- A send request must never accept a caller-supplied `event_id`, complete topic, device token, or Firebase Installation ID.
- Topic names follow the ADR. Each App instance has at most one active OPass topic subscription. Apps subscribe only after a successful login. A later successful login replaces the prior identity; Apps also reconcile after event changes, push-locale changes, and startup.
- Push content is always public information. Do not extend this design to private, personalized, or transactional messages.
- Announcements and push delivery are independent operations. Do not require an announcement ID or make either operation create the other.
- Support only new App versions using this contract. Do not add OneSignal compatibility, dual delivery, or migration behavior.
- FCM performs topic fanout. Do not build a central device registry or send one Gateway request per attendee.

## Security and credentials

- The Firebase service-account JSON exists only in a Cloudflare secret controlled by the OPass team. Never expose it to organizers, Admin, Apps, logs, fixtures, or Git.
- Grant the Gateway service account only the FCM send permission it needs. It must not manage topic subscriptions or other Firebase resources.
- An event Gateway key is intentionally readable by every organizer who can pass that deployment's reverse-proxy Basic Auth. Treat those users as authorized publishers for that event.
- Load the event key through a Basic-Auth-protected, non-cacheable Admin runtime configuration. Never commit a real key or place it in an unprotected asset.
- Store only a strong key digest in the Gateway mapping, together with its `EVENT_ID`, allowed Admin origins, and lifecycle state. Support revocation and overlapping rotation.
- CORS limits browser access but is not authentication. Preflight must use the registered global origin allowlist; the actual request must validate both the bearer key and that key's allowed origin.
- Validate all trust-boundary input, apply per-event rate limits, and keep audit logs free of bearer keys and Firebase private-key material.
- Never send a live notification, deploy a Worker, change Cloudflare or Firebase configuration, issue or rotate a key, or publish externally without explicit user authorization.

## API and FCM behavior

- Implement the request and response shapes exactly as specified in `openapi.yaml`.
- Preserve the three push locales: `en`, `zh-Hant`, and `zh-Hans`. Both `nan-Hant-*` and `nan-Latn-*` map to `zh-Hant`; other non-Chinese App languages fall back to `en` as defined by the ADR.
- Send one FCM topic message for each role-locale pair. Do not change the role limit, retry count, or fanout strategy independently; together they keep one invocation within the documented Workers subrequest budget. Keep at most six outgoing FCM requests in flight at once.
- Use FCM notification messages, not data-only notifications. Include `push_id` and the optional HTTPS `uri` in FCM data so Apps can route notification clicks. Preserve the normal delivery priority, default sound, no-badge behavior, and Android `announcements` channel contract from the ADR.
- Validate every generated FCM topic payload against the 2,048-byte UTF-8 limit before sending any message. OpenAPI character limits alone are insufficient.
- Retry only documented transient upstream failures and at most as specified by the ADR. Do not retry validation or authorization failures.
- An FCM message ID means FCM accepted the message, not that a device received or opened it. Keep these states distinct in code, logs, UI text, and tests.
- Reuse one `push_id` as the Analytics label for all role-locale messages in one operation. Only the platform-available aggregate delivery and open trends defined by the ADR are required; do not promise symmetric or per-device reporting.

## Implementation discipline

- Prefer the smallest implementation that satisfies the current contract.
- Use Cloudflare Workers Web APIs, Web Crypto, and `fetch` before adding dependencies. Call FCM HTTP v1 directly; do not add Firebase Admin SDK merely as a wrapper.
- Do not add a queue, device database, key-management UI, custom analytics system, or idempotency store until an accepted requirement or measured limit justifies it.
- Keep cross-repository changes in their owning repositories. This repository owns the Gateway and its contract, not Android, iOS, Admin, or Server implementations.
- Add the smallest runnable test that protects each non-trivial security, parsing, retry, or routing behavior introduced by a change.
- Prefer explicit, boring code over speculative abstractions. Reuse existing patterns before adding new ones.

## Verification

Before reporting an implementation change complete:

- Run every repository-provided formatter, linter, type check, and test relevant to the changed files.
- Validate `openapi.yaml` syntax and local `$ref` targets after contract edits.
- Cover invalid and revoked keys, cross-event isolation, rejection of `all` and caller-supplied routing targets, role and locale validation, CORS behavior, multi-byte payload limits, bounded retries, and secret redaction where relevant.
- Use mocks or FCM `validate_only` for automated checks. A test must not deliver a real notification.
- Review the final diff and report any validation that could not be run.

## Documentation and language

- Write this agent-facing `AGENTS.md` in English.
- Write `README.md`, ADRs, and other human-facing documentation in Traditional Chinese using natural Taiwan terminology.
- Keep code identifiers and protocol field names in English. OpenAPI descriptions and examples may use Traditional Chinese when that improves maintainer comprehension.
- Record a changed architecture or governance decision by adding or superseding an ADR; do not rewrite decision history without explanation.

## Change authority

- For explanation, review, diagnosis, or planning requests, inspect and report; do not implement unrequested changes.
- For requested code or documentation changes, make scoped local edits and run non-destructive verification.
- A request to edit does not authorize committing, pushing, deploying, sending notifications, or changing external services. Require explicit authorization for each of those actions.
- Use Conventional Commits when the user explicitly requests a commit.
