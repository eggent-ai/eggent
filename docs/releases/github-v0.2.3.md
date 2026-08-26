## Eggent v0.2.3 - Legible Interface

Every page of the dashboard was measured, then fixed against the measurement rather than against taste.

### Highlights

- **The palette can say "this worked".** It had one chromatic token and it meant failure. `--success`, `--warning` and `--info` are real tokens now, solved against their backgrounds (5.16:1, 4.93:1, 5.96:1 as text on white), and the 68 raw palette utilities that had been filling the gap are gone.
- **Edges you can see.** Control borders measured 1.26:1 and the keyboard focus ring 1.55:1 against the 3:1 that WCAG 2.2 SC 1.4.11 requires. Both clear it now, in both themes, and five components that were painting the ring at half opacity use the full token.
- **Touch targets and hover-only controls.** A 44px minimum applies where the pointer is coarse, and row actions that existed only on hover are reachable by touch and present in the tab order.
- **Loading shows a shape** instead of the word "Loading".
- **Motion, and a stated preference honoured.** `prefers-reduced-motion` was honoured nowhere; it is now, and a spinner slows rather than freezing. A page says it arrived, a turn says it landed, a control answers a press. Nothing loops.
- **`/login` is translated** and no longer prefills the default credentials on every visit.
- **`/dashboard/projects` opens.** It never rendered on a full page load - one element on screen with 27 controls present and invisible - while navigating to it from inside the app always worked.
- **Scheduled tasks can be retimed and deleted** from the dashboard.

### Platform Coverage

- Dashboard: contrast, focus, touch targets, loading states and motion across every route.
- Runtime: unchanged.
- API: unchanged.

### Upgrade Notes

- Compatibility: no data migration is required.
- Migration: none.
- Operational changes: none. Docker still binds `127.0.0.1` by default.

### Links

- Full notes: `docs/releases/0.2.3-legible-interface.md`
- README: `README.md`
