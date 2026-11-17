# ContextOS 1.2.1 install-safety candidate

Prepared on 2026-11-17. This is an unpublished patch candidate for the three
install/release findings against 1.2.0.

Local validated archive SHA-256:
`9ef6bfaca7687db17ff62ce436392dcc41bf5f9f36e64a3652abb1b5810f0591`.

## Behavior

- Global npm installation never calls global instruction setup. Existing agent
  instruction files, including previously installed managed blocks, remain intact.
  `contextos enable --dry-run --json` previews the explicit opt-in operation.
- Existing-project migration remains a separate hook. `CONTEXTOS_SKIP_SETUP=1`
  suppresses it while set. Released 1.2.0 needs both that setting and
  `CONTEXTOS_GLOBAL_INSTRUCTIONS=0` to suppress both install-time hooks.
- The publish workflow packs once, validates the archive, checks that same archive
  on Linux/macOS/Windows with Node 22/24, then verifies its checksum and publishes
  the downloaded tarball with scripts disabled. Publication has not been run.
- [The upgrade guide](../UPGRADING.md) covers deferred first-use migration,
  existing managed-block removal, and recovery for older daemons and project data.

## Local results

| Check                                                  | Result                                                                 |
| ------------------------------------------------------ | ---------------------------------------------------------------------- |
| TypeScript build, lint, formatting                     | Passed                                                                 |
| Full test suite                                        | 493 tests in 83 files passed                                           |
| Documentation lint and production build                | Passed with Next.js 16.4.6                                             |
| Critical production advisory gate                      | Passed; remaining moderate advisories are not treated as a clean audit |
| Installed-package suite, including live 1.2.0 upgrade  | 11 checks passed                                                       |
| Actual published 1.0.3 upgrade and saved-data recovery | 4 checks passed                                                        |
| Linux Node 22 packed installation                      | 4 checks passed                                                        |
| macOS/Windows and Node 24 packed installation          | CI validation required                                                 |

One existing setup test initially exceeded its five-second limit while the
documentation build ran concurrently. The subsequent full suite passed without
that competing build. No test timeout or assertion was relaxed.

The documentation build initially stopped for GHSA-mfr8-8qww-v76h in Next.js
16.4.3. Next.js and its ESLint configuration were patched to 16.4.6; the lockfile
and SBOM were refreshed, and the build passed.

The historical 1.0.3 test creates a real indexed project and saved memory, session
events, prompt history, and an SQLite backup using the published old package.
The new install refuses to signal its unauthenticated daemon. After closing the
old database, the harness terminates only its own fixture process because 1.0.3
leaves a cleanup timer running. This covers process-exit recovery, not a claim of
fully automatic graceful shutdown for 1.0.x. A failed setup caused by malformed
MCP JSON then retries successfully, preserving original IDs and saved data before
reindexing. The legacy database and backup remain available during verification.

## Reproduce with an isolated packed package

```bash
npm run build
npm pack --pack-destination /tmp --silent
npm pack @siddharthakatiyar/contextos@1.2.0 --pack-destination /tmp --silent
npm pack @siddharthakatiyar/contextos@1.0.3 --pack-destination /tmp --silent

npm run test:packed-install -- /tmp/siddharthakatiyar-contextos-1.2.1.tgz /tmp/packed-install.json
node scripts/release-package-test.mjs /tmp/siddharthakatiyar-contextos-1.2.1.tgz /tmp/release-package.json /tmp/siddharthakatiyar-contextos-1.2.0.tgz
node scripts/legacy-upgrade-test.mjs /tmp/siddharthakatiyar-contextos-1.2.1.tgz /tmp/legacy-upgrade.json /tmp/siddharthakatiyar-contextos-1.0.3.tgz
```

The packed-install smoke script is portable; use a platform-appropriate temporary
path on Windows. The full installed-package and legacy-daemon harnesses run on
Linux in CI. Each harness uses an isolated home and npm prefix and removes its
fixtures. The candidate package and scripts do not modify the real user's agent
files during these tests.
