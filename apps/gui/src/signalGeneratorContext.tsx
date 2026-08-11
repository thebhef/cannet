// The generator index (ADR 0026): the project's ordered generator
// rules, resolved against the DBC signal catalog into `signalKey` →
// color-wheel slot.
//
// The rules are user-supplied regexes, so the matching is the host's
// job — this provider sends the enabled patterns plus the catalog's
// distinct signal names to `evaluate_signal_generators` and zips the
// positional answers back onto the canonical keys. The frontend never
// compiles a pattern, and the map it caches is view-shaped data
// bounded by the loaded DBCs, not by the capture.
//
// One provider serves every surface that colors a signal, so a rule
// edit costs one round-trip rather than one per panel.

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";

import { signalKey } from "./plotData";
import { useElementRegistry } from "./projectElements";
import { useSignalCatalog } from "./signalCatalogContext";
import type { ProjectElement } from "./types";

/// Empty map shared by the default context value and every "no rules"
/// answer, so a project without generators never churns consumer memos.
const NO_INDEXES: ReadonlyMap<string, number> = new Map();

export const SignalGeneratorContext = createContext<ReadonlyMap<string, number>>(NO_INDEXES);

/// The color-wheel slot each signal's generator rule derives, by
/// canonical `signalKey`. A key that is absent is a signal no rule
/// claims — it falls through to the identity hash.
export function useSignalGeneratorIndexes(): ReadonlyMap<string, number> {
  return useContext(SignalGeneratorContext);
}

/// The patterns to evaluate, in evaluation order: every enabled,
/// non-blank rule of every `generator` element, concatenated in element
/// order. Blank rules are unfinished, not match-everything.
function generatorPatterns(elements: readonly ProjectElement[]): string[] {
  return elements
    .filter((e): e is Extract<ProjectElement, { kind: "generator" }> => e.kind === "generator")
    .flatMap((e) => e.rules.filter((r) => r.enabled).map((r) => r.pattern))
    .filter((p) => p !== "");
}

/// Resolves the project's generator rules against the signal catalog
/// and shares the answer via {@link useSignalGeneratorIndexes}. Must be
/// mounted inside the element registry and the signal-catalog provider
/// — it re-evaluates when either the rules or the catalog change.
export function SignalGeneratorProvider({ children }: { children: ReactNode }): ReactNode {
  const registry = useElementRegistry();
  const { catalog } = useSignalCatalog();

  // Keyed on the joined patterns rather than the entries array: any
  // element edit (a panel persisting its config, a trace scrolling)
  // replaces `entries`, and only a change to the rules themselves
  // should cost a host round-trip. A newline can't occur in a pattern
  // typed into the editor's single-line field.
  const patternKey = useMemo(
    () => generatorPatterns(registry.entries.map((e) => e.element)).join("\n"),
    [registry.entries],
  );
  const patterns = useMemo(
    () => (patternKey === "" ? [] : patternKey.split("\n")),
    [patternKey],
  );
  // Rules match the display name, so one question per distinct name
  // answers every bus the signal appears on.
  const names = useMemo(
    () => [...new Set(catalog.map((c) => c.signal_name))],
    [catalog],
  );

  const [byName, setByName] = useState<ReadonlyMap<string, number>>(NO_INDEXES);
  useEffect(() => {
    if (patterns.length === 0 || names.length === 0) {
      setByName(NO_INDEXES);
      return;
    }
    let live = true;
    void invoke<(number | null)[]>("evaluate_signal_generators", { patterns, names })
      .then((slots) => {
        if (!live) return;
        const m = new Map<string, number>();
        names.forEach((n, i) => {
          const slot = slots[i];
          if (slot != null) m.set(n, slot);
        });
        setByName(m);
      })
      .catch(() => {
        if (live) setByName(NO_INDEXES);
      });
    return () => {
      live = false;
    };
  }, [patterns, names]);

  const indexes = useMemo(() => {
    if (byName.size === 0) return NO_INDEXES;
    const m = new Map<string, number>();
    for (const c of catalog) {
      const slot = byName.get(c.signal_name);
      if (slot != null) {
        m.set(signalKey(c.bus_id, c.message_id, c.extended, c.signal_name), slot);
      }
    }
    return m;
  }, [byName, catalog]);

  return (
    <SignalGeneratorContext.Provider value={indexes}>{children}</SignalGeneratorContext.Provider>
  );
}
