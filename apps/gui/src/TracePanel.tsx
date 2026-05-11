import { useCallback, useState } from "react";
import type { IDockviewPanelProps } from "dockview";

import { TraceView } from "./TraceView";
import { useTraceData } from "./traceData";

/**
 * A trace panel inside the dockview layout. Renders the shared capture
 * (via {@link useTraceData}) through a {@link TraceView}, plus the bits
 * of state that are *per panel*: the auto-scroll toggle. Scroll
 * position and expanded rows live inside `TraceView` itself, so they're
 * already per-instance.
 */
export function TracePanel(_props: IDockviewPanelProps) {
  const { count, version, baseTimestampSeconds, getFrame, ensureVisible } =
    useTraceData();

  // While true the view pins to the live tail; a user scroll in the
  // trace flips it off (TraceView calls onAutoScrollDisabled).
  const [autoScroll, setAutoScroll] = useState(true);
  const handleAutoScrollDisabled = useCallback(() => setAutoScroll(false), []);

  return (
    <div className="trace-panel">
      <div className="trace-panel-toolbar">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
      </div>
      <TraceView
        count={count}
        version={version}
        autoScroll={autoScroll}
        baseTimestampSeconds={baseTimestampSeconds}
        getFrame={getFrame}
        ensureVisible={ensureVisible}
        onAutoScrollDisabled={handleAutoScrollDisabled}
      />
    </div>
  );
}
