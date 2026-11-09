# claude-code-zh

A local Chinese-localization toolkit for the **Claude Code extension in VS Code**.

It is not a language-pack extension and it ships no Anthropic code. It does one thing: replace the **UI strings bundled into the JS** of the extension you already have installed with Chinese text — backing up every file first, syntax-checking immediately after, and rolling back automatically on failure.

> Unofficial project, not affiliated with Anthropic. Anthropic and Claude are trademarks of Anthropic PBC.

## What it touches

The extension's UI text lives as string literals in three files:

| File | Contents |
|---|---|
| `package.json` | Command titles, setting descriptions, walkthrough |
| `webview/index.js` | Sidebar, session management, permission prompts, plugin marketplace |
| `extension.js` | Notifications, status bar, a few hints |

Only text **fully enclosed in quotes** is replaced. Object keys, URLs, paths and identifiers are skipped, so code structure is untouched — only displayed text changes.

## Usage

Requires Node.js (any LTS; no dependencies to install).

**Windows**: double-click the matching script

- `扫描.cmd` — scan untranslated UI strings in the current version, output to `scan-report.txt`
- `重新汉化.cmd` — apply the dictionary and self-check (use this after an extension update)
- `自检.cmd` — re-localize only when the extension version changed; can be scheduled at logon (`注册开机自检.cmd`)

**Command line** (any platform with node)

```bash
node claude-zh.js status      # show install location, version, patch state
node claude-zh.js scan        # scan untranslated UI strings → scan-report.json/txt
node claude-zh.js apply       # preview replacements (no writes)
node claude-zh.js apply --yes # write (auto backup + syntax check + rollback on failure)
node claude-zh.js verify      # syntax check
node claude-zh.js restore     # full restore from .zhbak
node claude-zh.js guard       # re-localize only when the extension version changed
node claude-zh.js selftest    # built-in sample test, confirms the tool itself works
```

Optional flags: `--dir "<extension dir>"` to point at the extension manually, `--ext-only` / `--cli-only`, `--all-versions`, `--roots "<dir>"`.

## Dictionary

`zh-dict.json` maps "English source → Chinese", 600+ entries today:

- plain entries match the **whole string exactly**;
- entries starting with `~` are **fragment replacements**, for composite text such as `Thought for ${n}s`;
- translations must not contain quotes or backslashes, and fragment entries additionally forbid `/ < > ; =` — those would cut the source string apart.

To add an entry, append a key/value pair to `zh-dict.json`. The key must match the source string **byte for byte** (spaces, punctuation, ellipsis included). If you are unsure what the original looks like, run `scan` or `grep "keyword"` first.

## Known limitations

**What cannot be translated**

- Text produced by the CLI process or the server: mod notices (`This mod is now loaded.`), `No response requested.`, `From the xxx plugin`, model lists and pricing — none of these strings exist in the extension directory.
- Split fragments (`Yes, allow `, ` of output.`) read wrong in isolation and are left in English by default.
- ajv / Zod / MCP SDK schema errors are developer-facing and deliberately kept in English for searchability.

**About the CLI**: current extensions bundle `resources/native-binary/claude.exe` (a compiled binary). This project **does not touch it** — patching a binary breaks length offsets, and a corrupted binary stops the whole extension from starting.

**Version sensitive**: UI strings change between releases, so some entries stop matching after an upgrade (`apply` lists the misses). Verified against **Claude Code for VS Code 2.1.319**.

**Conflicts with third-party language packs**: if you already use a full-package translation such as `zstings.claude-code-zhcn`, disable or uninstall it first. Two tools editing the same files means `restore` can no longer reconcile state.

## Safety

- No network access, no telemetry.
- Display text only, no logic changes; every modified file gets a `.zhbak` backup.
- After each write: `node --check` / JSON parse; on failure the change is rolled back on the spot.
- Known risk: if a string is also used as a value passed **across processes**, replacement may break the comparison. Audited on 2.1.319: exactly one string participates in an `===` comparison, and both sides carry the same Chinese text.

## License

Tool and dictionary are released under MIT. English phrases in the dictionary are used only for string matching; copyright in them remains with Anthropic. This project neither bundles nor redistributes the extension itself.
