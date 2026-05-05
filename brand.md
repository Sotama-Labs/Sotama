# Brand — Sotama

_Status: deferred_

This project uses a hand-rolled Apple HIG-inspired design system (CSS custom
properties in `src/app/globals.css`) instead of Tailwind + shadcn/ui. The
standard `brand-design` flow assumes Tailwind tokens and would conflict with
the existing `--label-*`, `--bg-*`, `--material-*`, `--accent`, `--slot-*`
variable architecture.

The `frontend-design-guidelines` skill will continue to apply (accessibility,
states, motion discipline, copy, focus rings, etc.) but will defer to the
existing token system for color, type, radius, and material decisions.

To replace the HIG system with a generated palette later, run:

    /brand-design

`brand-design` will detect this deferred state, prompt before overwriting the
existing tokens, and re-theme the project in one pass.

_Deferred at: 2026-05-04_
