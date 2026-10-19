# Contributing

For the complete contributor workflow, read the repository's [Contributing guide](https://github.com/xjoker/garage-ui/blob/dev/CONTRIBUTING.md). That document owns build/check commands and contributor conventions; this Wiki explains operator and end-user tasks.

## Build a change locally

Install the Rust toolchain pinned in [rust-toolchain.toml](https://github.com/xjoker/garage-ui/blob/dev/rust-toolchain.toml) and the Bun version in [web/package.json](https://github.com/xjoker/garage-ui/blob/dev/web/package.json). The build script also requires Python 3 available as `python3` for version validation. Build the browser assets before the Rust binary:

```sh
scripts/build.sh
```

Use a separate UI data directory and a test Garage cluster for changes that write data. Do not use production credentials in test configuration, issue reports, or commits.

## Improve this guide

The canonical guide pages live in [docs/wiki](https://github.com/xjoker/garage-ui/tree/dev/docs/wiki). Keep instructions tied to the actual source behavior: exact labels, commands, defaults, expected results, and relevant failure cases. Requirements in [docs](https://github.com/xjoker/garage-ui/tree/dev/docs) are acceptance targets. Check the [delivery roadmap](https://github.com/xjoker/garage-ui/blob/dev/docs/roadmap.md) and its revision-specific evidence before labeling a requirement as complete or outstanding.

Write repository material in English. The Simplified Chinese locale catalog and non-ASCII test fixtures are intentional exceptions. Make a change focused enough to review independently, and explain which behavior you actually verified.

CI only builds and publishes artifacts for validated release tags. Branch pushes and pull requests do not trigger builds or tests. Contributors run affected checks locally, and maintainers complete release validation before pushing a version tag.

## Work with an AI assistant

Give the assistant a bounded task: desired behavior, allowed files, relevant source/specification, verification commands, and a concrete completion criterion. Require it to inspect current signatures before coding and to report real check results, including prerequisites that were unavailable.

For interface changes, reuse the repository's Radix controls and theme tokens. Check the affected flow in a real browser at 360, 390, 768, and 1280 CSS pixels. Verify keyboard access, touch targets, dialogs, and sensitive data in screenshots where relevant; the [contributor guide](https://github.com/xjoker/garage-ui/blob/dev/CONTRIBUTING.md) owns the full check commands.

When contributors work concurrently, use non-overlapping ownership and coordinate shared service ports, Garage fixtures, and SQLite state. Preserve other contributors' changes. Keep credentials and personal machine details out of prompts that will be published, patches, screenshots, and pull requests. The [AI contribution instructions](https://github.com/xjoker/garage-ui/blob/dev/CONTRIBUTING.md#use-ai-assistance-within-a-bounded-task) explain these boundaries; human maintainers review, merge, and publish the result.
