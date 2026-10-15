# Documentation

## Operator guide

Start with the [Garage UI operator and user guide](wiki/Home.md) for installation, configuration, everyday storage tasks, account permissions, cluster operations, and troubleshooting. These pages describe current implementation behavior. The canonical Markdown sources live in `docs/wiki/`; update those files when correcting the published Wiki. Contributor build and verification commands belong in [Contributing](../CONTRIBUTING.md), while this guide covers operator and end-user tasks.

## Verification evidence

Reports describe particular source revisions and environments, not every later commit:

- [Nine audit fixes](../evidence/nine-fixes/report.md): corrected behavior, focused regressions, source/native/browser results, and reproduction commands.
- [Radix migration](../evidence/radix-migration/report.md): the earlier UI migration checkpoint, container and browser results, and their limits.
- [Screenshot metadata](images/README.md): build identity, fixture contents, and viewport sizes for the README images.

See the [delivery status and roadmap](roadmap.md) for implemented areas and deferred work, [Contributing](../CONTRIBUTING.md) for current build/check entrypoints, and [Releases](https://github.com/xjoker/garage-ui/releases) for published artifacts. A draft or an evidence report does not establish a published release.

## Working specifications

This directory is the breakdown of [`DEV-GUIDE.md`](../DEV-GUIDE.md) at the repository root. It is for implementation, parallel development, and acceptance. The original text stays. When the two sides conflict, this directory wins.

For local development and AI-assisted contributions, see [Contributing](../CONTRIBUTING.md). These chapters define requirements and acceptance targets, not a completed-feature checklist or a verification receipt. Consult the relevant implementation and record results for the exact source commit. The CI workflow remains disabled during development; the CI requirements below do not imply that CI checks are running.

Endpoint names and field names still follow the Admin API v2 definition in the Garage source. This directory contains no implementation code.

## Decisions already absorbed

| Decision | Where it landed |
|---|---|
| The backend is written in Rust | [decisions.md](decisions.md), [engineering.md](engineering.md) |
| The frontend toolchain is Bun | [decisions.md](decisions.md), [engineering.md](engineering.md) |
| Multiple agents may develop in parallel | [decisions.md](decisions.md) |
| Garage may run in a local container for tests and evaluation | [decisions.md](decisions.md), [engineering.md](engineering.md) |
| Runtime stack: Rust 1.99.0, axum 0.8.9, SQLx 0.9 with bundled SQLite. The rest is in the decisions file | [decisions.md](decisions.md), [engineering.md](engineering.md) |
| The admin UI itself supports containerized deployment (`linux/amd64` and `linux/arm64`) | [decisions.md](decisions.md), [engineering.md](engineering.md), [scope.md](scope.md) |
| The frontend drops daisyUI and zustand | [decisions.md](decisions.md), [engineering.md](engineering.md) |

The UI libraries are React 18, TypeScript, Vite, Radix Themes 3.3.0, `radix-ui` 1.8.1, TanStack Query, react-hook-form, zod, and Tailwind. Bun replaces the Node / pnpm toolchain layer. It is currently pinned at 1.4.2.

## Reading order

1. [decisions.md](decisions.md). What changed relative to the original draft.
2. [scope.md](scope.md). Goals, scope, and the minimum version.
3. [garage-api.md](garage-api.md). Versions, the capability probe, and the 46 endpoints.
4. [security.md](security.md). Security requirements and the role matrix.
5. [correctness.md](correctness.md). Correctness requirements.
6. Four feature documents: [data plane](features-data.md), [cluster and layout](features-cluster.md), [identity and audit](features-access.md), [UI](features-ui.md).
7. [engineering.md](engineering.md). Non-functional and engineering requirements (already rewritten for Rust and Bun).
8. [roadmap.md](roadmap.md). Delivery status, outstanding acceptance, and deferred scope.

Section numbers follow the original draft, so the two can be compared. For example, authentication that is safe by default is still 3.1, and buckets are still 5.1.
