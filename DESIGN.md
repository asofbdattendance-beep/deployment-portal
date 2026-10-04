---
name: Sewadar Deployment Portal
description: Dense operator portal for sewadar deployment and attendance oversight.
colors:
  primary: "#6366f1"
  primary-dark: "#4f46e5"
  primary-soft: "#eef2ff"
  bg: "#f6f7fb"
  surface: "#ffffff"
  surface-2: "#f8fafc"
  text: "#0f172a"
  text-sec: "#64748b"
  text-muted: "#94a3b8"
  border: "#e2e8f0"
  success: "#10b981"
  success-soft: "#ecfdf5"
  warning: "#f59e0b"
  warning-soft: "#fffbeb"
  danger: "#ef4444"
  danger-soft: "#fef2f2"
  violet: "#8b5cf6"
typography:
  body:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    lineHeight: 1.5
  title:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
    fontSize: "0.95rem"
    fontWeight: 700
    letterSpacing: "-0.01em"
  mono:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
rounded:
  button: "9px"
  card: "12px"
spacing:
  md: "16px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "#ffffff"
    rounded: "{rounded.button}"
    padding: "0.45rem 0.9rem"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.card}"
---

## Overview

A dense Operate-mode web tool: single vanilla-CSS file (`src/index.css`), one font family (Inter), one accent (indigo), Lucide icons, sticky in-page navigation, and tables that stay tables on phones. Scanability and consistency outrank expression; the brand lives in precise details. Recorded from code 2026-10-04 (scan mode); the frontmatter above is normative.

## Colors

Neutrals do 90%+ of the work: app background (`bg`), white cards (`surface`), cool slate-blue text ramp (`text` / `text-sec` / `text-muted`), hairline borders (`border`). One indigo accent (`primary`, darkened for press states, soft tint for selected backgrounds) marks primary actions, active tabs, and selection — never decoration. Semantic colors each ship with a soft tint (`success-soft`, `warning-soft`, `danger-soft`) so status reads as tinted text/badges on neutral grounds, never as saturated fills. Violet (`violet`) is reserved for the few places the product needs a second voice (VSS surfaces).

**The One-Accent Rule.** If an element is not the primary action, the active selection, or a status, it is neutral. **The Soft-Status Rule.** Status backgrounds always use the `-soft` tint; full-strength hues appear only in dots, glyphs, and text.

## Typography

One family everywhere (Inter with system fallback), antialiased, `line-height: 1.5`. Card titles are small and tight (`0.95rem`, weight 700, `-0.01em` tracking); secondary copy drops to `0.78–0.83rem` in `text-sec`. Badges, IDs, and timestamps use the system mono stack. Numbers in tables are a known gap (no `tabular-nums` utility yet — scheduled in the refinement).

**The Tight-Title Rule.** Headings earn emphasis from weight and tracking, never from size jumps or extra colors.

## Layout

Pages sit in a centered container under a flex page header (title left, actions right, wrapping). In-page tabs are a sticky segmented bar (`tab-nav`, pinned top, hairline pills). Toolbars are compact rows of sub-44px controls except text inputs and explicit 44px tap targets. Telephony contract: device tiers T0–T7 shared by CSS and JS; at ≤768px the shell swaps to a bottom tab bar + More sheet; report tables keep `table` display on phones with a sticky header row and pinned Badge column inside a `70vh` scroll box. Print is a first-class layout: phone chrome stripped, tables forced back, `@page A4` with repeating `thead`.

**The Sticky-Context Rule.** Whenever a list scrolls, its header (and identity column) stays pinned — on desktop and on phones. **The Container Rule.** Page chrome (header, filters, tabs) never scrolls away with results it controls.

## Elevation & Depth

Borders first, shadows second. Cards are white with a 1px border and a two-layer hairline shadow; large overlays (toasts, sheets) step up to a soft 40px ambient shadow. The z-scale is fixed (`filter 20 / tabbar 40 / modal 80 / sheet 90 / toast 200 / tooltip 9999`) so confirm buttons can never hide behind the tab bar again.

**The Border-First Rule.** Depth is a 1px border plus one restrained shadow — never a shadow alone, never two competing elevations on siblings.

## Shapes

Cards radius 12, buttons radius 9, pills fully round. Status reads through pills and chips (DEPLOYED, FINAL, View-only, Locked); icon buttons stay square-ish with the button radius. Modals and sheets are the only surfaces allowed a larger presence, via scale and overlay dim rather than a different radius language.

## Components

- **Button**: inline-flex with icon gap, `.45rem/.9rem` padding; primary is white-on-indigo with a subtle lift shadow; disabled drops to 50% opacity; press is a near-instant settle, not a bounce.
- **Card**: white, bordered, radius 12; title + small secondary sub-line; content decides internal rhythm.
- **Tab nav**: sticky segmented pills; active segment carries the accent.
- **Pill/chip**: status vocabulary (neutral, info, success, warning, danger); filter chips are outline with a removable ×.
- **Toast**: white card, colored icon per severity, slide-fade in ~180ms, top-right stacked.
- **Table**: header row semibold secondary text; row hover is a background shift only; dense cells, no zebra on screen (zebra reserved for print).

**The Honest-Control Rule.** Every control shows all its states — disabled is visibly disabled, loading replaces content with skeleton rows (never a bare spinner in tables), and destructive actions always confirm.

## Do's and Don'ts

- Do keep 90%+ of any viewport neutral with a single accent doing the pointing.
- Do pin context (headers, identity columns, filter bars) over scrolling data.
- Do write empty states that teach the next action, with the shortcut when one exists.
- Do gate hover styles behind `(hover: hover)` so taps never leave stuck highlights.
- Don't add a second accent, a saturated fill, or a colored delta pill to "liven" a table.
- Don't collapse a data table into label-per-line cards on phones (reports opted out for a reason).
- Don't invent components, tokens, or copy that this file does not record.
