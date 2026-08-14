# Task 69 — Extension Architecture

Implement the extension architecture decided in
[ADR 0051](../../docs/adr/0051-extension-architecture.md):
out-of-process, GUI-host-supervised extensions speaking a new
`ExtensionHost` gRPC service on the existing evolving `cannet.proto`.

Design was groomed with the owner in a dedicated session (2026-08-13);
the ADR carries the decisions and the rejected alternatives, and
`docs/CONTEXT.md` § Extensions carries the vocabulary. Adopted onto
the roadmap 2026-08-13; the terminology renames the ADR called for
(ADR 0035 "plugin/utility" → "extension/utility", the RBS task's
non-goal wording) were applied when the ADR landed.

## Scope (from ADR 0051's consequences)

1. **Wire**: `ExtensionHost` service, `Event` and `Signal` messages,
   and the monotonic Extension API version constant in
   `cannet.proto`. Filtered frame subscription (bus + arbitration-id
   predicate); transmit RPC gated by manifest consent
   (`CODE_TX_REJECTED` posture).
2. **Host**: extensions-directory scan at startup (app-data root,
   one subdirectory per Extension, unpacked-dir dev flow valid); a
   supervisor per Extension generalizing the `cannet-sidecar`
   supervision crate (spawn, banner, dial-in, stdin-EOF stop,
   process-tree kill backstop); manifest reader/validator (API
   version gate with a clear refusal error, transmit-consent gate).
3. **Views**: webview hosting for contributed views in dockview via
   a scoped local-asset scheme, with the opaque `postMessage` relay
   through the extension host connection.
4. **Packaging**: `.cannet-extension` (zip) install path — extract
   into the extensions directory.
5. **Reference Extension**: in-repo Python extension (`uv`-managed,
   mirroring `cannet-python-can`'s dev flow) exercising the full
   surface: frame subscribe + send (transmit declared), event emit,
   signal read, contributed webview view.

## Non-goals (ADR 0051, explicit)

- No registry/marketplace, no auto-update.
- No server-side extensions.
- No in-process WASM/scripting runtime, no native-dylib loading.
- Extensions are not always-on daemons — they run while the GUI
  runs.

## Grooming needed before implementation

- Phase split (wire → supervisor generalization → manifest+scan →
  views relay → reference extension is the natural layering; firm
  up at task start).
- Manifest format details (file name, schema, how transmit consent
  is worded to the user if surfaced).
- Where installed-Extension status surfaces in the GUI (a panel?
  system log only?) and the install/uninstall UX (file-open of a
  `.cannet-extension`? drop into the directory only?).
- Extension API version v1 freeze: which RPCs/fields are in the
  frozen first version.

## Exit criteria (draft — firm up at grooming)

- `cannet.proto` carries `ExtensionHost` + `Event`/`Signal` + the
  API version constant; additive-vs-breaking policy documented in
  the proto.
- The host scans, validates, launches, supervises, and cleanly
  stops extensions; version-mismatch and undeclared-transmit are
  refused with clear errors (tests for both gates).
- A contributed view renders in dockview with the `postMessage`
  relay working end to end; the host never interprets relayed
  payloads.
- The reference Python extension exercises the full surface against
  a live capture, and its install path (`.cannet-extension` and
  unpacked dir) both work.
- README documents installing and developing extensions; CONTEXT.md
  and ADR 0051 stay consistent with what shipped.
