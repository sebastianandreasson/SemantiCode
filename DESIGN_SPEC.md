# SemantiCode · Design Spec

The reference system for designing any surface in SemantiCode — a canvas-based
code editor focused on agentic coding, where the primary object is a graph of
semantic code symbols rather than a file tree. Follow this spec verbatim unless
a feature has an explicit reason to diverge; deviations should be deliberate
and documented.

---

## 1 · Philosophy

**Editor-minimal, dark-first, mono-forward.** The canvas of code symbols is the
product; every other surface is a quiet frame around it. Prefer hairlines,
tight density, uniform neutrals, and one accent over color, gradient, or
ornament. When in doubt: fewer pixels, smaller text, less chrome.

**Rules of thumb**
- No decorative gradients, shadows, glows, or animation. One-pixel borders and
  flat fills only. The only glow permitted is a 6px accent-colored soft shadow
  on a live status dot.
- No emoji. Kinds and states are represented by a colored square, a two-to-four
  letter mono tag, or a 1-character ascii glyph (`▸ ▾ ⌕ ⌘ ↵ ⑂`).
- No rounded "pills" larger than 3–4px radius, except status pills (999px) and
  tiny count badges.
- Type is monospace by default. Prose (agent output, purpose strings) uses
  Inter. Never mix within a line.
- Information density is a feature. Target ~6px vertical rhythm, 11–12px body,
  9.5px for eyebrows/metadata.
- Code is the source of truth. When a surface describes a symbol, prefer
  showing its code in context over paraphrased metadata.

---

## 2 · Tokens

Declared once as `T`. Do not hardcode colors.

### Neutrals — cool gray, hue 260, chroma 0.008–0.010
| token        | value                      | use                                   |
|--------------|----------------------------|---------------------------------------|
| `T.bg`       | `oklch(0.178 0.008 260)`   | app body                              |
| `T.bgDeep`   | `oklch(0.142 0.008 260)`   | canvas, code viewer, input wells      |
| `T.panel`    | `oklch(0.215 0.008 260)`   | toolbar, sidebars, inspector          |
| `T.panel2`   | `oklch(0.245 0.008 260)`   | selected row, dropdown trigger, hover |
| `T.line`     | `oklch(0.305 0.010 260)`   | primary 1px border                    |
| `T.lineSoft` | `oklch(0.255 0.010 260)`   | internal divider, dot-grid dot        |

### Text
| token         | value                    | use                           |
|---------------|--------------------------|-------------------------------|
| `T.text`      | `oklch(0.945 0.005 260)` | primary                       |
| `T.textMid`   | `oklch(0.745 0.010 260)` | secondary, inline labels      |
| `T.textDim`   | `oklch(0.555 0.012 260)` | signatures, group labels      |
| `T.textFaint` | `oklch(0.405 0.012 260)` | eyebrows, line numbers, hints |

### Semantic kind colors — uniform `L 0.72–0.76  C 0.13–0.15`
| kind       | hue | use                           |
|------------|-----|-------------------------------|
| function   | 240 | blue                          |
| component  | 300 | violet                        |
| type       | 75  | amber                         |
| hook       | 180 | teal                          |
| class      | 15  | rose                          |
| constant   | 145 | green                         |

Edges, kind tags, left stripes on symbol nodes, group dots, and code-range bars
all derive from this table. Never introduce a seventh kind without assigning it
a hue at least 40° from its neighbors.

### Accent
Single user-tunable hue. Default `215°`. Built via
`accentColor(h) = oklch(0.72 0.14 h)`. Used sparingly: selected-node border,
primary button fill, live status dots, dropdown bullet, composer caret, active
tab marker. Never for body text.

### Type
- **Mono:** JetBrains Mono (fallback Geist Mono, SF Mono, ui-monospace).
- **Sans:** Inter (fallback system-ui).
- Scale: `9.5 / 10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 18 / 26`. Nothing else.
- Letter-spacing: `1.2–1.6` on uppercase eyebrows; `-0.1 to -0.3` on 18–26px
  display; default elsewhere.
- Line-height: `1.3` for mono rows, `1.55` for prose, `1.6` for log lines.

### Geometry
- Radii: **0** (code rows), **2** (inline chips), **3** (buttons, inputs, dropdown),
  **4** (symbol node, drawer tabs), **6** (floating panels), **999** (status pills
  and dots).
- Borders: always `1px solid T.line`. `T.lineSoft` for intra-panel dividers.
- Grid: 16px dot grid on canvases (`T.lineSoft` dots on `T.bgDeep`).

---

## 3 · Layout

The canonical app shell:

```
┌─────────────── Toolbar · 44px ─────────────────────┐
│ brand │ path/workspace │ view ▾ │ status │ ⌘K      │
├──────┬────────────────────────────┬────────────────┤
│      │                            │                │
│ left │         canvas             │   inspector    │
│ 248  │         (flex)             │     360        │
│      │                            │                │
├──────┴────────────────────────────┴────────────────┤
│ agent composer strip · 40px                        │
└────────────────────────────────────────────────────┘
```

- **Toolbar** 44px, `T.panel`, bottom `T.line`.
- **Left rail** 248px. Grouped symbol list (see §5).
- **Canvas** flex. Dot grid. Never add chrome inside it beyond the zoom cluster
  (bottom-left), minimap (bottom-right), and stats eyebrow (top-right).
- **Inspector** 360px, `T.panel`, left `T.line`. See §6.
- **Agent composer** 40px. Persistent, single-line. Full panel opens elsewhere.

### Floating surfaces (palettes, popovers)
- Centered or anchored, `T.panel` fill, `1px T.line`, radius 6, shadow
  `0 16px 40px -12px rgba(0,0,0,.55)` max. No backdrop blur.

---

## 4 · Core components

### Kind dot / kind tag
- **Dot:** 5–8px square, radius 2, filled with `T.kind[k]`.
- **Tag:** 9.5px mono, letter-spacing 0.6, uppercase 3–4 letter abbreviation
  (`fn comp type hook class const`), color `T.kind[k]`, background
  `color-mix(in oklch, T.kind[k] 12%, transparent)`, padding `1px 5px`, radius 3.

### Symbol node (canvas card)
Dimensions: 240 × 72 compact (default). Three densities:
- **minimal:** tag + name. Single line.
- **compact:** tag, name, caller count, signature (1 line, ellipsed).
- **rich:** adds file path on third line.

Structure: 2px left stripe in kind color; `T.panel` fill; border `T.line` →
kind color on hover → accent on select. Selected adds a second accent ring via
box-shadow. Radius 4. No shadow on idle.

### Edges
Cubic bezier with 0.45·|dx| control handles, right→left. Vertical same-column
edges route through a midpoint. `T.lineSoft` at 1px opacity 0.55 idle;
kind-colored 1.5px opacity 0.95 with arrowhead when an endpoint is selected;
other edges dim to opacity 0.25.

---

## 5 · Left rail — grouped symbol list

Built for hundreds of symbols.

- Header: 9.5px uppercase "Symbols · N", sort indicator `sort: loc ▾`, and a
  filter input (`T.bgDeep`, 4×8 padding, `⌕` glyph, 10.5px hint).
- **Group headers:** collapsible, `▸/▾` glyph, 5px kind dot, pluralized label
  (`components`, `classes`, `hooks`…), and a right-aligned
  `N · <sum> loc` stat in `T.textFaint`.
- **Rows:** 3px vertical padding, 22px left indent under the group, name in
  11.5px mono, tiny **complexity bar** (26×3px, kind-colored, opacity 0.65) and
  a right-aligned LOC count in `T.textFaint`. Selected row: `T.panel2` fill,
  2px accent left border.
- Sort within a group: **LOC descending**. Default group order:
  `component → hook → class → function → type → constant`.
- Footer: `≡ group · kind` hint and total LOC.

Alternative grouping modes (file, callers, recency) may be added as dropdown
options on the sort chip; never replace the kind grouping as default.

---

## 6 · Inspector — code-first

The right panel is primarily a **code viewer showing the symbol's range
highlighted within its file**.

Order, top to bottom:
1. **Header** — kind tag, file path in 10px `T.textFaint`, symbol name in 18px
   mono (`letter-spacing: -0.3`), signature in 12px `T.textDim`.
2. **Code block** — flex:1. Eyebrow reads `Code · L12–L34 · … · 73 LOC`.
   - Background `T.bgDeep`, 10.5px mono, line-height 1.55.
   - Gutter: 30px right-aligned line numbers in `T.textFaint`.
   - Lines in the symbol's range get a kind-tinted background
     (`color-mix 4%`) and a 2px left bar at 45% kind color.
   - Lines in a "hotspot" sub-range get `color-mix 10%` background and a solid
     kind-color bar.
   - Lines outside the range render at opacity 0.35 — still legible for
     scroll-context but clearly secondary.
   - Syntax tokens: keywords → violet, strings → green, built-ins → teal,
     literals → amber, punctuation → `T.textDim`, operators → teal, comments
     → `T.textFaint`.
3. **Callers** — 10px uppercase eyebrow `Callers · N`, then wrapped 10.5px chips
   (`T.panel2` fill, `T.line` border, radius 3).
4. **Actions** — 12px top padding, `1px T.line` above. Primary: full-width accent
   button `ask agent ↵` (mono 11, weight 600, `T.bgDeep` text). Secondary:
   `T.panel2` fill / `T.textMid` / `open →`.

Never stack Purpose/Related/Call-graph as separate large blocks — they belong
as tabs inside the code block or as hover affordances.

---

## 7 · Agent surface

The agent lives as a **persistent thin composer** (40px strip at the bottom of
the app) that expands on demand — not a permanent sidebar.

- Strip: accent status dot (with 6px soft shadow), `agent` label, thin
  "following · {symbol}" trail, inline input well (`T.bgDeep`, `T.line`, radius
  3), `⏎` glyph at the right.
- On ⌘K or focus, expand into a full-height overlay or a right-anchored pane.
  Either is acceptable; never steal canvas permanently.
- Agent prose in Inter 12.5/1.55; user messages in mono 12; traces rendered as
  1px-dashed boxes with kind dots and `├ └` glyphs.

---

## 8 · Toolbar

- Brand mark (18px conic gradient square with a `T.panel` inner).
- Path → workspace, with a branch pill in accent at 10.5px.
- **View picker:** a single dropdown (not tabs). `T.panel2` fill, `T.line`,
  radius 3, `5px accent dot + current view + ▾`. Options: `files · symbols ·
  semantic · callgraph`.
- Right cluster: embedding status (`green dot · N/M`) and a `⌘K` hint chip.

---

## 9 · States & feedback

- **Selected:** accent left-border (2px) on rows; accent border + box-shadow on
  nodes.
- **Hover:** raise neutral surface to `T.panel2`. Never change type weight.
- **Dimmed:** opacity 0.35. Reserved for "not in current range / not in current
  selection neighborhood". Do not overload.
- **Live:** 6px soft accent glow on the status dot only.
- **Loading:** a single 1px progress bar in accent along the bottom of the
  relevant panel. No spinners.
- **Error:** red is `oklch(0.66 0.19 25)`; inline 11px text only. Never a
  toast.

---

## 10 · New-feature checklist

Before shipping a new surface, verify:
1. Colors come from `T` or `accentColor(h)`.
2. Kinds use `T.kind[k]` and the approved tag abbreviation for labeling.
3. Type uses the approved scale; mono for UI chrome, Inter for prose.
4. Borders are 1px, radii from the geometry set.
5. No emoji, no decorative gradients, no animation (other than a 150ms opacity
   cross-fade on selection dim).
6. The canvas, if present, keeps its zoom cluster, minimap, and stats eyebrow
   — nothing else.
7. Dense lists are **grouped by a categorical dimension** and **sorted by a
   scalar complexity signal** (LOC by default). Always show the sort + count.
8. Any detail pane prefers showing **code in context** over paraphrased
   metadata.
9. The agent is never a modal that blocks the canvas; it lives in the composer
   strip or an expanded overlay dismissible with `⎋`.
10. Accessibility: all interactive surfaces have a non-accent fallback state
    (borders, not color, carry the selection), and text contrast ≥ AA against
    its fill.
