# Changelog

All notable changes to **dsh-sunder** are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-21

### Added

- `dsh-sunder` bundle: replaces the deployment persona with the Sunder prompt
  pack (`sunder:identity` before the persona prefix, `sunder:rules` after the
  tool sections, `sunder:footer` after the persona suffix), so the next request
  of an already-open conversation picks it up without starting a new chat.
- Prompt pack in Chinese and English (`language: "zh" | "en"`, defaults to `zh`),
  with an `extraPrompt` slot for user additions.
- Announcement centre: fetches `announcements.json` from the repository, filters
  entries by the running version, surfaces unread notices in the runtime context
  and exposes them through the `sunder_notice` tool (`list` / `ack`).
- Self-update control: checks the GitHub Releases API at most once per
  `updateIntervalHours`, caches the result in `$DSH_HOME/sunder/state.json`,
  reports newer versions in the runtime context and through `sunder_status` /
  `sunder_update`.
- `sunder_status` tool: one call reports the running version, prompt state, feed
  cache, and unread announcements.
- `scripts/release.mjs`: version bump, changelog stub, commit, tag, push and
  `gh release create` in one command.
- GitHub Actions: CI (tests) and a release workflow that publishes a GitHub
  Release whenever a `v*` tag is pushed.
- Offline tests for the version range logic, announcement selection, prompt
  composition, and the real `@deepseek-ai/dsh-system-prompt` integration.

[Unreleased]: https://github.com/menghuanshiguang/dsh-sunder/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/menghuanshiguang/dsh-sunder/releases/tag/v1.0.0
