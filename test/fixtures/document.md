# Testing guide

Two layers, different jobs. Reach for the cheapest one that can actually catch
the class of bug you care about.

## Component tests — the default

For **logic and component behavior** — effect dependencies, state transitions,
hook wiring. Fast, deterministic, runs in CI with no backend.

- Config: `vitest.config.ts` (jsdom; do **not** reuse `vite.config.ts` — its
  build plugins are irrelevant under jsdom and cause noise).
- Run: `pnpm test` once
  tests exist.
- Reference example: `src/Foo.test.tsx` — reproduces a
  real render-loop bug.

Two non-obvious gotchas, both learned the hard way:

1. **Mocks must return referentially-stable values when the real hook memoizes.**
   If your mock returns a fresh `[]` each call, the consumer's effects re-fire
   every render and you either mask the bug or manufacture a fake loop.

2. **Guard against infinite render loops with a render counter, not a timeout.**
   A synchronous render loop blocks the event loop, so a timeout
   can't fire — the run hangs CI instead of failing.

## Which one?

- Bug is in *our* logic (deps, state, conditionals) → **component test**.
- Question is "does the real wired-up thing do X end-to-end" → **e2e**.
- When both apply, write the component test first and use
  e2e to confirm the integrated behavior.
