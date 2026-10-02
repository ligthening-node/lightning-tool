# Lightning Tool design system (source of truth)

Chosen with the `ui-ux-pro-max` skill (searches: fintech/crypto and financial-dashboard products,
colour, UX, shadcn stack). The skill's generated "pattern" was a FAQ landing page, which does not
suit a dashboard, so it was not used. Where the skill's palettes disagreed, the Fintech/Crypto row
(amber primary) won because amber is Bitcoin's colour.

## Direction
- Style: Minimalism and Swiss, on Dark Mode (OLED) with a Data-Dense Dashboard layout. No glassmorphism.
- Dark theme is the default. A light theme exists and the choice is remembered (`localStorage` key `theme`).
- Dials: variance 3 (centred, calm), motion 3 (subtle), density 7 (standard to dense).

## Colour (tokens live in `frontend/app/globals.css`)
| Token | Dark | Light | Use |
|---|---|---|---|
| background | #0b1220 | #f8fafc | page |
| card | #131c2e | #ffffff | surfaces |
| foreground | #f8fafc | #0f172a | text |
| muted-foreground | #9aa8bd | #475569 | secondary text |
| primary | #f59e0b | #f59e0b | the one brand accent, with dark text (#0f172a) on it |
| accent-foreground | #fcd34d | #78350f | amber text on tinted backgrounds |
| success / warning / info | #4ade80 / #fbbf24 / #38bdf8 | #166534 / #92400e / #0369a1 | status |
| destructive | #f87171 | #b91c1c | danger |
| border / input | #26324a / #334155 | #cbd5e1 / #94a3b8 | lines |

Rules: amber is for brand and active state only; green is only success; red is only danger. Raw hex
never goes in components, use the tokens. Every text and background pair passes 4.5:1 (checked by
calculation, see the commit that introduced this file).

## Type
- IBM Plex Sans for text, JetBrains Mono for ids, hashes and amounts, both through `next/font`.
- Body 16px, line height 1.5. Amounts and ids are always mono.

## Components
- Status is an icon plus a word, never colour alone (payments: succeeded, pending, failed).
- Sats are the unit shown, with the BTC value under the total balance.
- Tables use a real `<table>`; below `md` they become stacked cards.
- Touch targets are 40 to 44px on small screens. Icon-only buttons always have an accessible label.
- Cards are opaque so text never sits on the animated background.

## Motion
- Transitions 150 to 250ms. `prefers-reduced-motion` turns all motion off (global rule in `globals.css`).
- Background: faint drifting network with an occasional pulse (`components/shell/network-background.tsx`).
  Pauses when the tab is hidden, draws one still frame under reduced motion, never takes input.

## Shared patterns (stage 2)
- Every page starts with `PageHeader` (title, one line of help, optional actions).
- Below `md`, buttons and inputs are 40px tall and icon buttons 36px, then shrink to the dense desktop sizes.
- A disabled primary button turns neutral grey, never a dimmed amber.
- Empty lists show a dashed box or an icon with one sentence and the next step.
- The liquidity bar has a legend, so what the colours mean is written, not only coloured.
- The channel address placeholder is the local regtest peer (`127.0.0.1:9736`).
