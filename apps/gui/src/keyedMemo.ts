/**
 * Identity-preserving helpers for memo inputs.
 *
 * Both of these exist for the same reason: a `useMemo` compares its
 * dependencies by identity, so a derivation re-runs — and every memoised
 * consumer downstream re-renders — whenever an input is *replaced*, even
 * if what the derivation reads from it did not move.
 *
 * ## Per-key memoisation for a list-shaped derivation
 *
 * A `useMemo` that derives a list recomputes *every* entry whenever any
 * of its inputs move, so an edit to one entry re-mints all of them.
 * Downstream that is indistinguishable from "everything changed": a
 * memoised child handed one of those freshly-minted objects re-renders
 * even though nothing it draws moved.
 *
 * This keeps each key's derived value next to the inputs it was computed
 * from and reuses it while those inputs are identical — `Object.is` over
 * a dependency list, the same comparison React's own dependency arrays
 * use. Keys not asked for during a pass are dropped by {@link
 * KeyedMemo.commit}, so the cache cannot outgrow the list it serves.
 *
 * Meant to live in a ref (see {@link useKeyedMemo}) and be driven from
 * inside a `useMemo`. That is safe under StrictMode's double invocation:
 * the second pass asks for the same keys with the same dependencies, so
 * it hits the entries the first one stored and yields the same values.
 */
import { useRef } from "react";

export interface KeyedMemo<K, T> {
  /** `key`'s value, recomputed by `make` only when `deps` have moved
   * since the last committed pass. */
  get(key: K, deps: readonly unknown[], make: () => T): T;
  /** End a pass: keys asked for during it are kept, the rest retire. */
  commit(): void;
}

interface Entry<T> {
  deps: readonly unknown[];
  value: T;
}

const sameDeps = (a: readonly unknown[], b: readonly unknown[]): boolean =>
  a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

export function createKeyedMemo<K, T>(): KeyedMemo<K, T> {
  let current = new Map<K, Entry<T>>();
  let pass = new Map<K, Entry<T>>();
  return {
    get(key, deps, make) {
      const hit = current.get(key);
      const value = hit && sameDeps(hit.deps, deps) ? hit.value : make();
      pass.set(key, { deps, value });
      return value;
    },
    commit() {
      current = pass;
      pass = new Map();
    },
  };
}

/** A {@link KeyedMemo} that lives for the component's lifetime. */
export function useKeyedMemo<K, T>(): KeyedMemo<K, T> {
  const ref = useRef<KeyedMemo<K, T> | null>(null);
  if (ref.current == null) ref.current = createKeyedMemo<K, T>();
  return ref.current;
}

/**
 * Hold a freshly-built list's identity for as long as its members are
 * the same objects, in the same order.
 *
 * For a list filtered out of a container that is replaced wholesale on
 * every change to *anything* in it — the element registry's `entries`,
 * replaced whenever any element is patched, this panel's own config
 * persist included — while the members themselves are only replaced when
 * that member changed. Selecting the members a memo actually reads and
 * passing them through here turns "something, somewhere, was edited"
 * into "what I read was edited".
 *
 * Call it with a list built inline during render; it returns either that
 * list or the previous one.
 */
export function useStableMembers<T>(list: readonly T[]): readonly T[] {
  const ref = useRef(list);
  const held = ref.current;
  if (held !== list && (held.length !== list.length || held.some((v, i) => !Object.is(v, list[i])))) {
    ref.current = list;
  }
  return ref.current;
}
