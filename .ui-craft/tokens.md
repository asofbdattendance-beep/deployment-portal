# Design tokens

Source of truth for values; `src/index.css` `:root` is the implementation. DESIGN.md frontmatter is the machine-readable mirror.

## Current (observed 2026-10-04)

| Token | Value |
|---|---|
| `--bg` | `#f6f7fb` |
| `--surface` | `#ffffff` |
| `--surface-2` | `#f8fafc` |
| `--text` / `--text-sec` / `--text-muted` | `#0f172a` / `#64748b` / `#94a3b8` |
| `--border` | `#e2e8f0` |
| `--primary` / `--primary-dark` / `--primary-soft` | `#6366f1` / `#4f46e5` / `#eef2ff` |
| `--success` / `-soft` | `#10b981` / `#ecfdf5` |
| `--warning` / `-soft` | `#f59e0b` / `#fffbeb` |
| `--danger` / `--danger-soft` | `#ef4444` / `#fef2f2` |
| `--violet` | `#8b5cf6` |
| `--radius` | `12px` (cards), buttons `9px` |
| `--shadow` | `0 1px 2px rgba(15,23,42,.05), 0 1px 3px rgba(15,23,42,.06)` |
| `--shadow-lg` | `0 10px 40px rgba(15,23,42,.12)` |
| z-scale | filter 20 / tabbar 40 / modal 80 / sheet 90 / toast 200 / tooltip 9999 |
| body type | Inter stack, `line-height: 1.5`, antialiased |
| mono | `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` |

## Phase 2 target deltas (decided, not yet implemented)

- Radius steps: `--radius-sm: 6px` (inputs/chips), `--radius: 8px` (cards), `--radius-md: 10px`, `--radius-lg: 14px` (modals).
- Spacing discipline: `4 / 8 / 12 / 16 / 24` only.
- Semantics to subdued OKLCH (text/dots only, neutral grounds): success `oklch(60% .12 150)`, warning `oklch(72% .13 75)`, danger `oklch(58% .15 25)`, info `oklch(62% .12 240)`.
- `.tnum` utility: `font-variant-numeric: tabular-nums` on every numeric cell/metric/timestamp.
- One `:focus-visible` ring token; motion micro-only 150–250ms with `prefers-reduced-motion` respected.
