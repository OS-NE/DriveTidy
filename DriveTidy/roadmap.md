# Roadmap

- [x] Fix offline mode (worker install failed on wrong file addresses)
- [x] Fix 'File picker already active' error
- [x] Scan activity log: skipped/moved files and why
- [x] Phase 2 plan approved
- [x] Phase 2 release 1: journal, lock, recovery classification, History tab (read-only)
- [x] Phase 2 release 2: journaled moves for restructure and duplicate moves; duplicate cleanup quarantines instead of permanently deleting
- [x] Phase 2 release 3: guided restore for completed quarantine batches; verifies fingerprints, refuses occupied destinations, and records restore operations
- [x] Phase 2 release 4: guided inspection of unfinished journaled moves with SHA-256 source/destination checks and recovery classifications
- [x] Phase 2 release 5: full destination paths for new move records and per-file confirmation of completed moves only when source absence, SHA-256 equality, and saved destination-handle identity are proven

## Recovery safety

Recovery review is read-only except for **Confirm this move**, which updates journal state only after the identity checks pass. It does not move, rename, or delete files. Legacy records without full destination paths remain conservative. Permanent deletion remains disabled in recovery.

- [x] Phase 2 release 6: remove permanent deletion from the Health panel; unreadable/problem files can only be moved into a journaled quarantine and restored through History

## Destructive-operation policy

DriveTidy does not expose a permanent-delete workflow for scanned files. Health-check results can only be moved into a journaled quarantine. Removing a history record never removes files. Quarantine restoration remains fingerprint-checked and skips occupied original paths.

- [x] Phase 2 release 7: portable journal export/import with validation, fresh imported IDs, stripped filesystem handles, archived read-only imported records, and no overwrite of existing history.
- [x] Optional encrypted journal backup with user-managed passphrase, authenticated encryption, and safe read-only import.
- [x] Reusable restructuring preferences, safe custom folder templates, extension overrides, and scan-based layout recommendations.

## Windows desktop release

- [x] Configure DriveTidy 0.8.0 Windows x64 NSIS installer with branded icon and assisted per-user install.
- [x] Use a stable loopback origin and authenticated health check so desktop storage remains origin-stable and the shell does not trust an unrelated local process.
- [x] Add desktop packaging preflight checks for Nitro output, icon, NSIS x64 target, and health-check configuration.
- [x] Update Windows GitHub Actions to use the repository's Bun lockfile, run tests, package the installer, and publish SHA-256 checksums.
- [ ] Run the GitHub Actions Windows build and verify installation, first launch, file picker permissions, journal persistence after restart, and uninstall behavior.
- [ ] Configure Authenticode signing before distributing a public installer; unsigned builds may trigger Windows SmartScreen warnings.

## Recovery inspection reliability — 0.9.0

- [x] Continue destination inspection when the original parent directory was removed after a move.
- [x] Add inspection progress and cancellation.
- [x] Allow metadata-only batch finalization only when every destination is hash- and handle-identity-verified, with explicit confirmation.
- [ ] Run the full Vitest suite and Windows installer workflow.
- [ ] Validate the recovery flow against a disposable test folder before using it on a user's drive.
