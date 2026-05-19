// Pure orchestrator for the "Insert filter upstream" button on the
// trace / plot toolbars. Creates a filter, transfers the sink's input
// streams onto it, then points the sink at the new filter. Tested in
// isolation via a fake registry so the orchestration is independent
// of React rendering.

import type { ElementRegistry } from "./projectElements";

/// Insert a filter between a consumer (trace / plot) and its current
/// sources. Returns the new filter's id, or `null` if the call was a
/// no-op (unknown sink, or the sink is a transmit — transmits don't
/// have `sources`). The filter's predicate is left unset; the user
/// configures it via the graph view's inline editor.
export function insertFilterUpstream(
  registry: ElementRegistry,
  sinkId: string,
): string | null {
  const current = registry.get(sinkId)?.element;
  if (!current || current.kind === "transmit") return null;
  const previousSources = current.sources ?? ["*"];
  const filterId = registry.create("filter");
  registry.update(filterId, { sources: previousSources });
  registry.update(sinkId, { sources: [filterId] });
  return filterId;
}
