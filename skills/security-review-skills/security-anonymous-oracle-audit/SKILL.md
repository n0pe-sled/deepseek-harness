---
name: security-anonymous-oracle-audit
description: Use to enumerate and test the anonymous web surface including controller, meta, and slug routes, applying the known-vs-unknown differential before any read surface is certified clean
disable-model-invocation: true
user-invocable: false
---

# Security Anonymous Oracle Audit

Anonymous surface maps miss the web front end. The machine interfaces, API,
GraphQL, RPC, git, and storage, are not the whole anonymous read surface.
Handler-rendered GET routes with meta tags, og:image, slug or ID lookups,
account-management and unsubscribe-style pages, markdown, and AJAX endpoints
leak existence or state. Treat them as first-class surface.

Enumerate:
- handlers or controllers that skip authentication, including renders that
  touch users, settings, or images;
- meta and og/twitter rendering paths that dereference a looked-up record;
- routes keyed by slug, ID, or opaque token where a known value renders a
  different page than an unknown value.

Test every anonymous read with the known-vs-unknown differential:
- a known value returns the expected page;
- a same-shaped unknown value must render byte-identical to a fabricated path;
- any rendering difference is an existence or state oracle.

Only then certify the surface clean. A surface is not clean because a request
succeeds; it is clean because denial is indistinguishable from absence across
all framings. Record the differential bytes for every certified route.

This skill feeds `security-vulnerability-discovery` for enumeration and
`security-attack-simulation` for the differential control.
