# ADR 0002: CommonJS, Jest, ESLint and Node 24

- **Status:** Accepted
- **Date:** 2026-09-24
- **Supersedes:** [ADR 0001](./0001-runtime-and-tooling.md)

## Context

The project brief was revised to name **TypeORM**, **Jest** and **ESLint** explicitly. ADR 0001 had adopted the NestJS 12 scaffold defaults (native ESM, Vitest, oxlint).

Two constraints shape how we adopt the brief's tools:

1. **TypeORM and ESM do not mix well.** Its migration CLI loads entity and migration files through globs. ESM also requires `Relation<T>` wrappers to break circular entity imports. CommonJS avoids both problems.
2. **NestJS 12 packages are published as ESM only.** A CommonJS application can load them through Node's `require(esm)`. Jest's module runtime supports this only on Node 24.9+ and only with `--experimental-vm-modules`.

## Decision

- **Runtime:** Node.js 24 LTS (`.nvmrc`, `engines: >=24.9`).
- **Module system:** CommonJS application code (no `"type": "module"`). Imports have no file extensions.
- **Tests:** Jest 30 with `ts-jest`, run through `node --experimental-vm-modules` so Jest can `require()` the ESM-only NestJS packages.
- **Linting:** ESLint with `typescript-eslint` type-checked rules. `no-explicit-any` and `no-floating-promises` are errors. `eslint-config-prettier` defers formatting to Prettier.
- **TypeScript:** unchanged from ADR 0001 (`strict` plus the additional strictness flags).

## Consequences

- The toolchain matches the brief and the most widely documented NestJS + TypeORM setup.
- Jest prints an `ExperimentalWarning` for VM modules. It is cosmetic, but it depends on an experimental Node API. If that API changes, the alternative is to move the application to native ESM and run Jest in ESM mode.
- Node 20/22 cannot run the test suite. Contributors must use Node 24.9+.
