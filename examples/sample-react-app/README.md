# ReactFig sample app — Dashboard

A small, realistic product screen used as ReactFig's end-to-end benchmark
(Phase 7). Built and verified for real in this repository (`npm install`,
`tsc -b`, and `vite build` all genuinely run — see
`docs/e2e/phase7-report.md` for the exact commands and output).

```
Dashboard (screen)
├── Sidebar            nav list (repeated <li> items), CSS Grid page column
├── Header             title/subtitle + user Avatar, flex row
├── StatCard × 3        repeated elements, flex-wrap row
└── SessionCard × 3     repeated elements, each composing:
      ├── Avatar         <img> asset
      ├── status dot      position:absolute over the avatar's corner
      ├── Badge           variant-typed tone
      └── Button          variant/size axes
```

## Run it

```bash
cd examples/sample-react-app
npm install
npm run dev       # http://localhost:5173
```

`vite.config.ts` pins the dev server to port 5173 so `generate_design_ir`
has a stable URL to navigate Playwright to.

## Complexity checklist (Phase 7's requirements)

| Requirement | Where |
|---|---|
| Nested components | `SessionCard` composes `Card` + `Avatar` + `Badge` + `Button` |
| Reusable components | `Button`/`Avatar`/`Badge`/`Card` are each used ≥2 places |
| Component variants | `Button.variant` (primary/secondary/ghost) × `.size`; `Badge.tone` |
| Typography hierarchy | `Header` title (28px/800) → subtitle (14px/muted) → `SessionCard` name (15px/700) → meta (12px/muted) |
| Images/assets | `Avatar`'s `<img src>`, 4 real placeholder PNGs in `public/avatars/` |
| Flex layout | `Button`, `SessionCard` row, `Sidebar` nav, `Header`, stats row |
| CSS Grid | `.dashboard-page` (page columns) **and** `.dashboard-session-grid` (auto-fill card grid) — two independent Grid usages |
| Absolute positioning | `SessionCard`'s status dot, positioned over the `Avatar`'s corner |
| Responsive behavior | `@media (max-width: 768px)`: `Sidebar` flips vertical-column flex → horizontal-row flex; `.dashboard-page`/`.dashboard-session-grid` collapse to one column |
| Repeated elements | `Sidebar` nav items, `StatCard`s, `SessionCard`s — all `.map()`-rendered from arrays |

## Benchmark targets (per Phase 7's requirement to use more than an isolated Button)

1. **Button** (`src/components/Button.tsx`) — isolated component check.
2. **SessionCard** (`src/components/SessionCard.tsx`) — nested composition,
   absolute positioning, variant props.
3. **Dashboard** (`src/screens/Dashboard.tsx`) — the complete representative
   screen; the primary evaluation target.
