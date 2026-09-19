# AGENTS.md

## Purpose and scope

This file applies to the entire repository. It is the operating contract for coding agents, not a replacement for the project documentation or API specification.

Keep this file concise and durable. Put rationale in an ADR, wire-level details in `openapi.yaml`, and human-oriented orientation in `README.md`.

## Start here

Before changing anything:

1. Read `README.md` for the repository scope.
2. Read the ADRs relevant to the task under `docs/adr/`. ADR 0001 is foundational and must be read before changing authentication, event isolation, topic routing, credentials, delivery semantics, or observability.
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
- Save content and known dispatch results in centrally operated D1 under ADR 0002. Content must be saved before FCM; missing results do not authorize resend. D1 content storage does not change the secret-based event-key mapping.
- Deployment must not require a valid payment method across compute, content storage, and native metrics handoff. If provider conditions or measured usage cannot meet that constraint, reassess the decision rather than automatically enabling billing or dropping required data.
- `CCIP-Admin-Bueno` calls the Gateway directly from the browser. It reuses `CCIP-Server`'s existing roles endpoint as the source of the role list, but `CCIP-Server` must not gain a push endpoint or Gateway credential and is not in the push delivery path.
- Admin expands the UI choice "all" from that role list into concrete `roles[]`; neither the Gateway nor FCM has an `.all` topic.
- Each event Gateway key is bound centrally to exactly one permanent and unique `EVENT_ID`. The Gateway derives the event from the authenticated key.
- A send request must never accept a caller-supplied `event_id`, complete topic, device token, or Firebase Installation ID.
- Topic names follow the ADRs. Each App instance has at most one active OPass topic subscription per logged-in event and may remain subscribed to multiple events. Synced or restored credentials must be validated before adding subscriptions. A later successful login replaces the prior identity only for that event; switching the currently viewed event must not remove other event subscriptions. Reconcile on login, logout, role changes, confirmed credential invalidation, push-locale changes, FCM registration changes, and startup. Keep recoverable pending transitions local to the installation; do not sync or restore applied-subscription state or treat transient validation failures as logout.
- Apply validation results only to the captured event and still-current identity revision. Stale success or failure must not overwrite roles, clear newer credentials, or trigger subscriptions; serializing SDK operations alone is insufficient.
- Push content is always public information. Do not extend this design to private, personalized, or transactional messages.
- Announcements and push delivery are independent operations. Do not require an announcement ID or make either operation create the other.
- Support only App versions using the Gateway v1 contract. Do not add OneSignal compatibility, dual delivery, migration behavior, or UnifiedPush to Gateway v1.
- FCM performs topic fanout. Do not build a central device registry or send one Gateway request per attendee.

## Security and credentials

- The Firebase service-account JSON exists only in a Cloudflare secret controlled by the OPass team. Never expose it to organizers, Admin, Apps, logs, fixtures, or Git.
- Grant the Gateway service account only the FCM send permission it needs. It must not manage topic subscriptions or other Firebase resources.
- An event Gateway key is intentionally readable by every organizer who can pass that deployment's reverse-proxy Basic Auth. Treat those users as authorized publishers for that event.
- Load the event key through a Basic-Auth-protected, non-cacheable Admin runtime configuration. Never commit a real key or place it in an unprotected asset.
- Store only a strong key digest in the Gateway mapping, together with its `EVENT_ID`, allowed Admin origins, and lifecycle state. Support revocation and overlapping rotation.
- Maintain organizer identity and the event end time centrally per event. Stop new dispatches 30 days after the event ends; key rotation must not extend this deadline. Admin must verify its event against the authenticated Gateway context before sending.
- CORS limits browser access but is not authentication. Preflight must use the registered global origin allowlist; the actual request must validate both the bearer key and that key's allowed origin.
- Validate all trust-boundary input, apply per-event rate limits, and keep audit logs free of bearer keys and Firebase private-key material.
- Never send a live notification, deploy a Worker, change Cloudflare or Firebase configuration, issue or rotate a key, or publish externally without explicit user authorization.

## API and FCM behavior

- Implement the request and response shapes exactly as specified in `openapi.yaml`.
- Require English (`en`) and Traditional Chinese (`zh-Hant`) content; these are the currently enabled push locales. Chinese App locales (`zh` and its extensions), `nan-Hant-*`, and `nan-Latn-*` map to `zh-Hant`; all other App languages fall back to `en` as defined by the ADR. Keep App interface translations separate from push locales.
- Send one FCM topic message for each role-locale pair. Do not change the role limit, retry count, or fanout strategy independently; together they keep one invocation within the documented Workers subrequest budget. Keep at most six outgoing FCM requests in flight at once.
- Use FCM notification messages, not data-only notifications. Include the key-derived `event_id`, `push_id`, and the optional HTTPS `uri` in FCM data so Apps can route notification clicks, including notifications from an event that is not currently open. Preserve the normal delivery priority, default sound, no-badge behavior, and Android `announcements` channel contract from the ADR.
- Use the centrally registered organizer name as the notification title. All dispatches and bounded retries in one operation share a fixed one-hour expiry. Set Android TTL and APNs expiration explicitly, and `aps.mutable-content: 1` for the minimal FCM delivery-metrics extension retained on iOS after removing OneSignal.
- Validate every generated FCM topic payload against the 2,048-byte UTF-8 limit before sending any message. OpenAPI character limits alone are insufficient.
- Retry only explicit documented transient upstream failures and at most as specified by the ADR. Do not retry validation or authorization failures, unknown transport outcomes, or partial operations. Accept missed notifications; do not add push-operation resend or recovery workflows.
- An FCM message ID means FCM accepted the message, not that a device received or opened it. Keep these states distinct in code, logs, UI text, and tests.
- Reuse one `push_id` as the Analytics label for all role-locale messages in one operation. Require only platform-available aggregate delivery/open counts and event-scoped CSV handoff through native Firebase/Analytics/BigQuery exports. Preserve the content mapping until CSV handoff and verify that exported metrics can be matched to notification content as required by ADR 0001. Label units, coverage, and cutoff times; unavailable is not zero and counts are not unique people. Do not add conversion tracking, a reporting backend, or indefinite central retention for next-year analysis.

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
- Also cover fixed expiry, event cutoff and rotation, context mismatches, honest unknown/not-attempted results, and the subscription-recovery and event-scoped CSV cases in ADR 0001 where relevant.
- Use mocks or FCM `validate_only` for automated checks. A test must not deliver a real notification.
- Review the final diff and report any validation that could not be run.

## Documentation and language

- Write this agent-facing `AGENTS.md` in English.
- Write `README.md`, ADRs, and other human-facing documentation in Traditional Chinese using natural Taiwan terminology.
- Keep code identifiers and protocol field names in English. OpenAPI descriptions and examples may use Traditional Chinese when that improves maintainer comprehension.
- Write project documentation for readers without the conversation history: state behavior, scope, ownership, and prerequisites directly. Keep task progress and session-relative wording out of durable guides; attach validation results to an identified revision in commit, PR, or release records.
- Keep decision status, implementation status, and deployment evidence separate. Do not mark an ADR accepted or an integration verified solely because code exists.
- Before implementing an architectural decision, reconcile the relevant ADR status with established decisions and implementation authorization. Record the adopted scope and date before dependent implementation commits, and identify any unresolved product or governance choices and when they must be resolved. Do not ask the user to repeat decisions already made.
- Refine proposed ADRs in place. Record changes to accepted architecture or governance decisions in a new or superseding ADR; do not silently rewrite decision history.

## Change authority

- For explanation, review, diagnosis, or planning requests, inspect and report; do not implement unrequested changes.
- For requested code or documentation changes, make scoped local edits and run non-destructive verification.
- A request to edit does not authorize committing, pushing, deploying, sending notifications, or changing external services. Require explicit authorization for each of those actions.
- Use Conventional Commits when the user explicitly requests a commit.
