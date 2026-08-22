# ADR 0055 — A state that wants pressing is a chip, and the header's readout is a status bar

Status: accepted (2026-08-21)

## Context

The app's toolbars are buttons: a thing you press to make something
happen. But several of the things sitting in them were not commands —
they were **states that occasionally want pressing**. A Connect button
whose label swapped to Disconnect reported a state. The system-messages
and signal-mapping launchers carried needs-attention badges, which are
states. A bus-health readout is a state that opens a panel.

Below them sat a status line that was a *sentence*:

```
Streaming from 2 servers (5 interfaces, 1 234 567 frames · 18.4k f/s ·
41:07 elapsed · 4.2 GB RAM · 12.1 GB cache). 3 DBCs.
```

The numbers could not align, because the prose in front of them changes
length with the session, and the one tooltip explaining all five figures
hung off the whole element.

A visual language invented inside one feature, for one readout, is how a
codebase ends up with five chips that each look almost the same. The
shared colour chip is the nearest precedent for the alternative: one
control, adopted by every site that needs it.

## Decision

### 1. A chip shows a state, and pressing it goes to where that state is managed

There is **one** status chip implementation, not a per-panel copy. Its
shape is the shared colour chip's — a 2px radius over a 1px
`--border-wash` hairline, with a rounded-square indicator rather than a
circle — so the two read as one family. What it adds is **tinting that
edge to carry state**.

The state vocabulary is `idle`, `connecting`, `connected`, `degraded`,
`failed`. `idle` is the plain hairline, identical to a colour chip's;
every other state recolours the same 1px edge. **No state changes a
border weight, a padding or a width**, so a chip never resizes as the
thing it reports progresses and nothing reflows under the pointer.

A chip may carry a right-aligned tabular-numeric **count** (`4 / 5`) and
a **badge** (a needs-attention count, absent at zero). Width uniformity
is *within* one chip's state set and is sized to that chip's longest
state — never global, which would spend the bar on short labels.

**A command wears the same silhouette, and is told apart by the dot.**
The chip shape is the app's one control shape — commands, toggles,
status chips and colour swatches read as one species — so a command is
the same hairline, radius and density, implemented as the very same
component with a press affordance rather than a second almost-identical
control. What separates the two is the indicator: **a chip carries a dot
only when it has a state to report**, and a plain command grows none.
The distinction stays readable without spending a second shape on it.

### 2. Something that cannot say *which* one is a launcher, not a chip

A single summary over several buses cannot name the bus that is off,
which is the only thing worth knowing when one is. Where that is true,
the control is a compact **icon launcher** that opens the panel where
the question is answered: neutral while there is nothing to report,
tinted with a count when there is, and naming the subject in its
tooltip.

### 3. The header's readout is a status bar, and it never wraps

The prose status line is a **status bar**: the connection chip, an
optional bus-health launcher, whatever is happening (with the response
to it), the numbers as discrete aligned metrics, and the chips that
report a condition pinned right.

- **The toolbar keeps no control that reports a condition.** The
  connection control lives in the bar, so nothing reports the connection
  from two places, and the toolbar is left as commands only.
- **Metrics are model facts.** Every figure is the host's; the frontend
  formats and never derives one.
- **The bar is one row and never wraps.** A header that grows a second
  line reflows every panel beneath it, so fit comes from removing
  things. Metrics **drop** from the right and stay reachable in the
  tooltip every metric label carries; pinned chips **collapse** from the
  right into a dropdown badged with the sum of the counts inside it. The
  two mechanisms differ deliberately: a hidden number is an
  inconvenience, a hidden alert is a defect.
- **The bar must not clip.** `overflow: hidden` looks like the
  belt-and-braces companion to `nowrap` and it breaks the overflow menu,
  which is an absolutely-positioned child: a clipping bar swallows its
  own dropdown. A future layout that genuinely needs the bar to clip
  must portal the menu out of it first.

### 4. Combining is fine for reporting and forbidden for editing

A chip that reports across several independent configurations (the RBS
mapping chip over a project's `.cannet_rbs` files) sums their problems,
because their *faults* are independent of the rule that their *values*
must never be merged. Editing still happens one configuration at a time.

## Consequences

- New state readouts adopt the shared chip rather than inventing a
  shape. A feature that needs a new *state* extends the vocabulary here;
  it does not add a sixth almost-identical control.
- A control's placement follows from what it is: a command in the
  toolbar, a state in the bar, a per-panel state in its own panel as the
  same component in a second placement.
- The bar's fit is arithmetic over measured widths, which means the drop
  and collapse behaviour can be driven to any width in a test rather
  than only observed at whatever width a browser happened to give.
- Anything added to the bar competes for finite width. A new metric has
  to be worth more than the one it pushes out, which is why clock offset
  keeps its home in the server-list row rather than displacing a time
  statistic.
