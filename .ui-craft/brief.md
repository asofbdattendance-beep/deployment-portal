# Design brief — Sewadar Deployment Portal

## Product identity

Dense Operate-mode web tool for ASO deployment + attendance operations. Earned familiarity over novelty: the tool disappears into the task.

## Design intent

**Refinement, not redesign.** Keep the incumbent identity (Inter, indigo `#6366f1`, Lucide, layered hairline shadows, z-scale, mobile tiers) and raise craft: stepped radius, subdued semantics, tabular numerals, honest states, skeleton loading, teaching empty states. Restructure the IA (Phase 1 Deployment / Phase 2 Attendance) and collapse duplicated views into shared primitives.

## Audience

ASO operators living in these screens for hours; centre staff on phones consenting sewadars; scanners marking attendance mid-visit, often offline. Scanability, 44px targets, offline-first states, print parity.

## Voice

Sentence case. Plain secondary text over colored pills. One line + next action in empty states. No marketing copy anywhere in the app.

## Constraints

- Stack: React 18 + Vite + single vanilla-CSS file. Never fight the stack; no Tailwind, no new CSS approach.
- No new npm dependencies without explicit approval (fonts included).
- No destructive surprises: no auto push/deploy, no Supabase writes, no irreversible deletes.
- Free-tier lanes only; bounded verification (screenshots + defect scan, then stop).
- "Super Admin" never appears in UI.

## Learned constraints

- 2026-10-04: refinement preserves — indigo brand, Inter, and mono stack stay; saturated hex semantics move to subdued OKLCH in Phase 2 tokens.
- 2026-10-04: report tables stay tables on phones (`.rows-on-phone`); never collapse data rows into label-per-line cards.
- 2026-10-04: award landing-page recipes (Lenis/ScrollTrigger/R3F/page choreography) do not apply to this Operate-mode app; only bounded-verify carries over.
- 2026-10-04: one screen, one job — Dashboard becomes a launcher; master switches live only in Control Panel.
