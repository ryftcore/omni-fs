# ADR-0005: pnpm workspaces with Turborepo

- **Status:** Accepted
- **Date:** 2026-09-18

## Context

The repo holds two applications and six packages that must build in dependency
order, and the boundary between `packages/` and `apps/` is load-bearing (see
ADR-0001).

## Decision

pnpm workspaces for dependency management, Turborepo for the task graph.

## Consequences

**Good.** pnpm's strict, non-hoisted `node_modules` means a package can only
import what it declares — an accidental cross-package import fails rather than
silently resolving, which reinforces the architectural boundary at install time
as well as at lint time. Turborepo caches build output and orders tasks from the
dependency graph.

**Bad.** Two tools for contributors to have installed, and pnpm's strictness
occasionally surfaces a missing peer dependency that a hoisted layout would have
hidden.

**Mitigation.** `packageManager` is pinned in the root `package.json`, and
`allowBuilds` in `pnpm-workspace.yaml` is an explicit allowlist so a fresh
`pnpm install` is non-interactive.
