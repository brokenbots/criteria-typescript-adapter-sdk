# Deferred: serveRemote (WS21)

`src/serveRemote.ts` is the remote-serve entrypoint for TypeScript adapters,
originally developed under WS21 in the criteria monorepo
(`criteria-typescript-adapter-sdk/` in-tree). It implements the remote
identity/handshake + Unix-socket bridge for the out-of-process remote
adapter path.

It is **not** part of the published `@criteria/adapter-sdk` (v0.5.0) on `main`:
the remote-serve path was deferred during the v2 SDK cut (the Go SDK dropped
`serve_remote_test.go` for the same reason). This branch preserves the
implementation so it can be wired up (proto loading, tests, `index.ts` export)
when the feature is picked back up, rather than re-derived.

Provenance: monorepo `criteria-typescript-adapter-sdk/src/serveRemote.ts`
(176 lines), preserved 2026-06-05 during the SDK-folder disentanglement.
