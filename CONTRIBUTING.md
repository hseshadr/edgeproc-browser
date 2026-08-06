# Contributing

Thanks for taking a look. This is a small library and the bar is simple: a
change ships with a test, and `pnpm gate` is green.

## Setup

You need Node >= 22.13 and pnpm. The exact Node version CI uses is 24.

```bash
git clone https://github.com/hseshadr/edgeproc-browser.git
cd errors
pnpm install
pnpm gate
```

`pnpm gate` runs lint (biome), typecheck (tsc), tests with coverage (vitest),
and the build — the same command, in the same order, that CI runs. If it passes
locally it should pass in CI. If it doesn't, that gap is a bug worth reporting.

## Making a change

1. Branch off `main`.
2. **Write the failing test first.** Watch it fail for the right reason, then
   make it pass. Bug fixes start with a test that reproduces the bug.
3. Run `pnpm gate`. Coverage is enforced at 100% — statements, branches,
   functions and lines. The library is pure logic with no I/O, so there is no
   honest reason for a line to be unreachable from a unit test.
4. Add a line to `CHANGELOG.md` under `[Unreleased]`.
5. Open a pull request describing what changed and why.

`pnpm lint:fix` will fix formatting for you. `pnpm test:watch` is the fast loop.

## Things that will be pushed back on

- **Renaming a shipped error code.** A code is a public API contract. Deprecate
  it and add a new one; never rename in place.
- **Adding a runtime dependency.** Zero dependencies is a feature of this
  package, not an accident. If you genuinely need one, make the case in the
  issue before writing the code.
- **Widening the surface without a use case.** New exports need a caller.

## Reporting bugs

Open an issue with the version you're on, what you passed in, what you got back,
and what you expected. A failing test is the best possible bug report.

For anything security-related, see [SECURITY.md](./SECURITY.md) — do not open a
public issue.
