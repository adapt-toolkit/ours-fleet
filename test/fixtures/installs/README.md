# Divergent-install fixtures

Two miniature `@ours.network/fleet` install roots that share the exact same
semver (`0.16.0`) but were cut from different source trees, reproducing the
host skew that motivated build provenance:

| fixture   | build id       | `monitor.interrupt: after_tool` |
|-----------|----------------|---------------------------------|
| `legacy`  | *(none)*       | rejected                        |
| `current` | `c0ffee123456` | accepted                        |

`legacy` deliberately ships **no** `dist/build-info.json` — it stands in for
every artifact built before build provenance existed, which is the case a real
host hits first.

Each `dist/cli.js` is a stub, not the real CLI: it answers `--version`,
`version --json` and `config <file>` only, which is everything the provenance
tests need to prove which artifact serves a path.

Tests must not exec these from a checked-out path directly — `test/provenance.test.ts`
copies them into a temp prefix and creates the `bin/ours-fleet` symlinks there,
so nothing outside the temp dir is touched.
