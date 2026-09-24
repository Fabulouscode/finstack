# ADR 0001: Runtime and tooling

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

FinStack is scaffolded with NestJS 12. Its CLI now generates native ESM projects with Vitest and oxlint rather than CommonJS with Jest and ESLint. The original project brief listed Jest and ESLint.

## Decision

- **Runtime:** Node.js 22 LTS (pinned in `.nvmrc`, enforced via `engines`).
- **Module system:** native ESM (`"type": "module"`, `nodenext` resolution). Relative imports use `.js` extensions.
- **Tests:** Vitest for unit, integration and e2e tests. Its API is Jest-compatible (`describe`, `it`, `expect`, `vi` instead of `jest`).
- **Linting:** oxlint with type-aware rules. `no-explicit-any` and `no-floating-promises` are errors.
- **Formatting:** Prettier.
- **TypeScript:** `strict` plus `noUncheckedIndexedAccess`, `noImplicitOverride`, `noImplicitReturns` and `noFallthroughCasesInSwitch`.

## Consequences

- We stay on the framework's default path, which lowers upgrade friction.
- Vitest and oxlint are significantly faster than Jest and ESLint, which keeps the feedback loop tight as the test suite grows.
- Contributors familiar with Jest can read and write tests with minimal adjustment.
- Some ESLint plugins have no oxlint equivalent. If a needed rule is missing, ESLint can be added alongside oxlint for that rule only.
