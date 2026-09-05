# Unity MCP Ghost Security Policy

## Supported versions

Security fixes are applied to the current development branch and `0.2.x` release candidates. Automated and live coverage proves Unity `2022.3.62f1` on Windows; local Node gates currently prove Node `24.11.1`, while CI is configured for the latest Node 20, 22, and 24 runners. The toolchain requires Node 20.19+, 22.13+, or 24+; this compatibility range is not a claim that every patch was tested. Unity `2021.3`, Unity `6000.x`, macOS, and Linux remain unverified until their matrix gates are observed green; do not treat them as certified.

## Threat model and trust boundary

Ghost controls a live Unity Editor and can change scripts, assets, scenes, packages, and runtime state. Its boundary is the signed-in operating-system user running Unity and the MCP server. It is not a sandbox against another process running as that same user, an administrator/root process, a malicious Unity package, or malicious code already loaded into the project.

The bridge binds only to loopback. HTTP and WebSocket requests require a cryptographically random per-project bearer token and exact project/editor instance IDs. Browser requests carrying an `Origin` header are rejected and Ghost does not enable CORS. The durable queue uses an HMAC proof bound to request metadata instead of persisting the raw token in queue files.

Native remote binding is deliberately unsupported. For remote use, place an authenticated encrypted tunnel in front of the loopback endpoint and keep the Unity bridge loopback-only. Never expose the bridge port directly to a LAN or the internet.

## Credentials and identity

Ghost creates these ignored files under the Unity project:

- `Library/UnityMcpGhost/bridge-token.txt`: 256-bit random token. On Windows its ACL is replaced with an owner-only rule; on macOS/Linux Ghost requests mode `0600`.
- `Library/UnityMcpGhost/bridge-identity.json`: project/editor identity, separately advertised HTTP and WebSocket ports, heartbeat, versions, enabled capability classes, and token-file location. It does not contain the token.
- `Library/UnityMcpGhost/bridge-settings.json`: persisted project-local bridge settings and package-source allowlist.

Do not commit, log, paste, or place the token in generated evidence. If it may have been disclosed, stop Unity, delete only the token file, and restart Unity to generate a new token. Existing MCP processes must then be restarted.

## High-risk capabilities

The following capability classes default to disabled and are enabled per project in `Window > Unity MCP Ghost`:

- **Destructive**: deletes, component removal, package removal, and screenshot pruning.
- **Package / Network**: package search/add/remove. Package additions must also match `PackageSourceAllowlist`; the default permits official `com.unity.` identifiers only.
- **Arbitrary Code**: future generic execution operations. No such operation is enabled by default, and enabling it would not provide a sandbox.
- **Reflection**: future reflection-driven operations.

Dry runs are permitted when they do not perform the high-risk action. Batch authorization recursively applies the strongest nested capability requirement. Tool annotations identify deletes/package removal as destructive and package discovery/addition as open-world.

## Path and transport defenses

Asset paths are canonicalized under the selected project's `Assets` root. Project artifact paths are canonicalized under the selected project root. Traversal outside the boundary is rejected. Existing symlink/junction/reparse-point components are rejected so they cannot redirect an apparently safe path outside the project.

The bridge enforces JSON content type and POST method for HTTP; aggregate byte limits for HTTP and fragmented WebSocket messages; bounded concurrent HTTP requests and WebSocket clients; and a shared request-rate limit. HTTP uses the project-persisted bridge port. WebSocket uses its own project-persisted loopback port because Unity 2022.3's Mono `HttpListener` does not complete upgraded connections reliably; both endpoints are listed in the identity file and enforce the same token and project/editor pinning. Mutations retain request IDs, deadlines, idempotency metadata, and explicit unknown-outcome semantics across reconnects.

The optional MCP-facing Streamable HTTP endpoint is separate from the Unity bridge. It also accepts only literal-loopback binding and requires the project's owner-only token plus exact project/editor headers. It rejects browser `Origin` requests, enables no CORS, and bounds bodies, results, admission and response delivery. Tool profiles control discovery, not authorization. Stdio remains the default. See the README for the explicit HTTP flags and credential handling; never put a token in a command-line argument.

HTTP disconnect/timeout is not permission to cancel or replay a mutation. Graceful CLI shutdown closes HTTP admission, drains actual handlers and scenario restoration/finalization, and only then disposes Unity. A failed drain prevents disposal; unresolved finalization is reported with retained recovery state. Force-killing the process bypasses graceful cleanup and requires reconciliation of durable operations before retrying mutations.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability that could expose credentials or permit unintended code/project modification. Use GitHub's private vulnerability-reporting or Security Advisory flow for `CrispyW0nton/Unity-MCP-Ghost` and include affected versions, reproduction steps, impact, and any proposed mitigation. Remove project assets, tokens, usernames, and absolute private paths from the report.
