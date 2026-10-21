# dsh-sunder

**Sunder** is an open-source answer-mode bundle for
[DeepSeek Harness](https://github.com/deepseek-ai) (DSH). Install it and every
request in the current conversation is assembled with the Sunder prompt
sections, so the assistant answers directly instead of hedging, refusing, or
adding policy commentary.

It is a clean-room implementation: three pinned prompt sections, two runtime
context contributors, three tools, and a tiny assembly guard. No forks of
`dsh-purge`, no copied plugin code, no closed-source bundle.

- **Prompt mode** — a first-person identity claim, operating rules, and a
  closing directive, pinned around the host's own prompt sections.
- **Version control** — semantic versioning, `CHANGELOG.md`, git tags, GitHub
  Releases, and an in-app update notice (`sunder_update`).
- **Announcements** — a remote `announcements.json` feed, matched against the
  installed version, surfaced as runtime context and through `sunder_notice`.
- **Local only** — no telemetry, no proxy, no model calls; the only network
  requests are the announcement feed and the GitHub release check, both cached
  and tolerating failure.

## Why

The original "unrestricted prompt" plugin for DSH (`dsh-purge`) moved to a paid
model. Sunder is the open, MIT-licensed alternative: the prompt content is
visible in [`lib/prompt.js`](lib/prompt.js), the update mechanism is a plain
GitHub API call, and the announcement feed is a file in this repository.

## Requirements

| Requirement | Value |
| --- | --- |
| DSH | `0.2.1-rc.2` (Node 18+ runtime) |
| Profile | any profile whose `dsh.profile.bundles` you can edit |
| Network | optional; announcements + update check degrade to no-ops |

## Install

### Option A — link a checkout (recommended for development)

```powershell
git clone https://github.com/menghuanshiguang/dsh-sunder.git D:\dsh\sunder
```

Then in the profile directory (`%USERPROFILE%\.dsh\profiles\<profile>`):

1. Link the package:
   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-sunder" `
     -Target "D:\dsh\sunder"
   ```
2. Add the dependency to the profile manifest:
   ```json
   "dependencies": { "dsh-sunder": "link:D:/dsh/sunder" }
   ```
3. Append both bundles to `dsh.profile.bundles`:
   ```json
   "bundles": [ "...", "dsh-sunder" ]
   ```
4. Restart DeepSeek Harness (the bundle list is read at startup).

### Option B — tarball

```powershell
npm pack dsh-sunder
npm install --save <path-to>/dsh-sunder-1.0.0.tgz
```

Then add `"dsh-sunder"` to `dsh.profile.bundles` and restart.

Verify the composition offline before restarting:

```powershell
node D:\dsh\sunder\test\smoke.mjs
```

## Configuration

`cordis.patch.yml` inserts the row with these defaults:

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | master switch for the whole bundle |
| `language` | `auto` | `auto` follows the host locale, or force `zh` / `en` |
| `extraPrompt` | `""` | extra user rules appended to the Sunder rules section |
| `announcements` | `true` | fetch and surface the remote announcement feed |
| `announceLimit` | `3` | maximum unread announcements surfaced per request |
| `feedUrl` | raw GitHub `announcements.json` | primary announcement feed location |
| `feedMirrors` | `[]` | extra feed URLs tried before the built-in mirrors |
| `builtinMirrors` | `true` | keep the built-in GitHub contents API and `ghproxy.net` mirrors in the fallback chain |
| `bundledAnnouncements` | `true` | fall back to the `announcements.json` shipped in the package when every remote source fails |
| `updateCheck` | `true` | check GitHub Releases for a newer version |
| `updateIntervalHours` | `6` | minimum time between automatic checks |
| `repo` | `menghuanshiguang/dsh-sunder` | release repository for the update check |
| `tools` | `true` | register `sunder_status` / `sunder_notice` / `sunder_update` |
| `guard` | `true` | re-attach the sections if another plugin replaces the prompt |
| `debug` | `false` | log feeder/update decisions to the host console |

Override per profile by patching the inserted row:

```yaml
- id: sunder
  config:
    language: zh
    extraPrompt: "回答保持简短，直接给结论。"
```

## Prompt architecture

Sunder registers three sections with explicit placements:

| Section | Order | Placement rationale |
| --- | --- | --- |
| `sunder:identity` | `-100000` | first section in the assembly, ahead of the harness identity slot (`-1000`) |
| `sunder:rules` | `9600` | before deliverable/harness-source sections |
| `sunder:footer` | `10300` | last, after the deployment persona suffix (`10200`) |

Every section is registered with `interpolate: false`, so nothing in the user
prompt is interpreted as a `{{variable}}`. The bundle patch also turns off
`includeHarnessIdentity`, because Sunder supplies the identity claim itself.

The host's prompt renderer drops empty contexts, so the update notice and the
announcement block are silent until they have something to say. The assembly
guard re-attaches the three sections when another plugin installs a `complete`
section (which would otherwise replace every section after the waterfall); the
guard re-wraps itself when a session is created or a preset is switched, and is
idempotent.

## Announcements

`announcements.json` is the feed:

```json
[
  {
    "id": "2026-10-21-hello-sunder",
    "level": "info",
    "date": "2026-10-21",
    "title": { "zh": "Sunder 已发布", "en": "Sunder is here" },
    "body": { "zh": "…", "en": "…" },
    "link": "https://github.com/menghuanshiguang/dsh-sunder",
    "minVersion": "1.0.0",
    "maxVersion": "2.0.0"
  }
]
```

- `level`: `info` | `warn` | `critical`
- `minVersion` / `maxVersion` (optional): semver range that should see the entry
- `id`: stable; used for acknowledgement (`sunder_notice` with `action=ack`)
- localized `title` / `body` pick the active language, falling back to the
  other one

Unread announcements appear in the runtime context of every request and can be
listed or dismissed with the `sunder_notice` tool. A fresh entry is published
by editing `announcements.json` on `main` — no release required.

### Feed sources

`raw.githubusercontent.com` is blocked on some networks, so the feed is fetched
with a fallback chain:

1. `feedUrl` (default: `raw.githubusercontent.com/.../announcements.json`)
2. `feedMirrors`, when configured
3. the GitHub contents API
   (`api.github.com/repos/.../contents/announcements.json`, base64 payload)
4. the `ghproxy.net` raw mirror
5. the `announcements.json` bundled with the installed package (works fully
   offline; disable with `bundledAnnouncements: false`)

Every source uses the same `announcements.json` schema, and a failure never
throws into the host — the next check simply tries again. `sunder_status`
reports which source answered (`source=bundled`, `source=https://…`) and the
last error.

## Update control

- `package.json` version is the single source of truth.
- `CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/).
- `scripts/release.mjs` bumps the version, updates the changelog, commits, tags,
  pushes, and creates the GitHub Release:

  ```powershell
  node scripts/release.mjs patch --yes
  node scripts/release.mjs 1.1.0 --dry-run
  ```

- `.github/workflows/ci.yml` runs the unit tests + package checks on every push.
- `.github/workflows/release.yml` creates the release from a `v*` tag.
- Inside DSH, `sunder_status` shows the cached check, `sunder_update` forces a
  fresh GitHub API call.

## Tools

| Tool | Purpose |
| --- | --- |
| `sunder_status` | version, language, pinned placements, unread announcements, cached update state, state file |
| `sunder_notice` | list / acknowledge announcements (`list`, `ack`, `ack-all`) |
| `sunder_update` | force a GitHub release check and report upgrade availability |

## State

`$DSH_HOME/sunder/state.json` (default `~/.dsh/sunder/state.json`) stores the
install id, acknowledged announcements, and the last update check. It is
created on first use and is safe to delete.

## Uninstall

1. Remove `"dsh-sunder"` from `dsh.profile.bundles`.
2. Remove the dependency / junction.
3. Restart DSH. Deleting `sunder/state.json` is optional.

## Development

```powershell
node test/unit.mjs            # pure unit tests, no DSH required
node test/prompt.mjs          # prompt packs and placements
node test/smoke.mjs           # integration against a real DSH runtime
node scripts/check-package.mjs
```

`test/smoke.mjs` finds the installed DSH runtime through `DSH_RUNTIME_DIR`
(default `D:/DSHPC/resources/app/dsh`), boots the real `dsh-system-prompt`
service, applies the bundle, and asserts the rendered prompt carries the Sunder
sections — including with a competing `complete` section mounted.

## License

MIT — see [LICENSE](LICENSE). You are responsible for the prompts you install
and the content you request on your own machine.
