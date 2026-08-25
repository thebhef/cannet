# 0114 — One Name Per Thing

> **Status 2026-08-25 — groomed with the owner.** Queue items **1.37,
> 1.33b and 1.17**, from the 2026-08-24 walk of
> [`owner-review-queue.md`](../owner-review-queue.md) § 1. Fully ruled 2026-08-25; no
> open questions. No phases yet.

The chrome says one thing where the model says another. **1.37 is the
mechanism and the other two are its symptoms**, so this is one pass rather
than three string edits.

## 1. The commands are the model; the chips are a rendering · 1.37

> *"we basically* do have *a list of commands that gets rendered - that was
> the original shape, we've just added status and a different frontend
> rendering."*

That is what the code does:
[`commands.ts:1-9`](../../apps/gui/src/commands.ts#L1-L9) is a declared
50-command registry (ADR 0018) and every chip dispatches an id from it.
**The divergence is that a command carries two labels** — the chip table at
[`Toolbar.tsx:116-159`](../../apps/gui/src/Toolbar.tsx#L116-L159) declares
its own label, icon and tooltip rather than deriving anything, so
`project.new` is *New project* in the palette and **New** on the bar.
Nothing makes them agree, which is how 1.33b went stale.

**Work:** amend ADR 0055 to say what the owner said — the command list is
the model, the chip bar one rendering of it. **Optional, separable:**
declare the chip label beside the palette label so the two cannot drift
again.

## 2. The toolbar chip reads "DBC" · 1.33b

The DBC → Database rename was made everywhere else — panel title at
[`dockLayout.ts:133`](../../apps/gui/src/dockLayout.ts#L133), palette entry,
and a `normalizeSingletonTitles` migration for saved layouts pinned at
[`dockLayout.dom.test.ts:94-100`](../../apps/gui/src/dockLayout.dom.test.ts#L94-L100).
One chip is the straggler.

**Work:** label → `Database`. Keep the tooltip *Add DBC…* and the palette
entry, which name the file format. Two literals — the component and
`Toolbar.dom.test.tsx`'s hand-copied `BAR`.

## 3. The virtual-bus adapter cell reads "bus" · 1.17

> *"the 'adapter' is just reported as 'bus', not blank. 'virtual bus' would
> be better."*

**The owner was right and the original finding was wrong.** The cell at
[`BusHealthPanel.tsx:136-145`](../../apps/gui/src/BusHealthPanel.tsx#L136-L145)
renders `adapter` then `applied`; the finding described `applied`. It reads
"bus" because the adapter lookup at
[`busHealth.ts:141-145`](../../apps/gui/src/busHealth.ts#L141-L145) falls
back to `binding.interface` when no interface matches, and every local-vbus
binding carries `LOCAL_VBUS_INTERFACE = "bus"`
([`types.ts:274`](../../apps/gui/src/types.ts#L274)) — a wire id reaching
the screen.

**Ruled 2026-08-25 — the generic string, not the bus's name:** *"this is
the hardware column. We already have the user's bus name on the same row."*
Column 1 is `{row.name}`
([`BusHealthPanel.tsx:112`](../../apps/gui/src/BusHealthPanel.tsx#L112));
the column in question is headed **Adapter**. Repeating the name there
would say nothing, and the honest answer to "what hardware is behind this
bus" is that there is none.

**Work:** a local-vbus binding renders `virtual bus` in the adapter cell.
No vbus list is consulted — the fix is at the fallback, not in the lookup.
`busHealth.ts`'s comment claiming the fallback matches the project panel is
wrong and goes with it.

## Exit criteria

1. **ADR 0055 says the command registry is the model and the chip bar one
   rendering of it**, amended in the same commit as any code change.
2. **The toolbar chip reads `Database`**, tooltip and palette entry
   unchanged, test table updated with it.
3. **A virtual bus's Adapter cell reads `virtual bus`**, not
   `LOCAL_VBUS_INTERFACE`, pinned by a test; the bus's own name still
   appears in column 1 and is not duplicated.
4. **If the optional leg lands**, a test pins that the bar derives its
   labels rather than declaring them.
5. **Queue rows 1.37, 1.17 and 1.33b struck** with the date.
6. **Full CI green** — six jobs, each named with its command.
