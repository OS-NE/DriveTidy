# Phase 2 (final): Operation Journal, Crash Recovery and Undo

## Summary

Every file-changing step is written to an on-device journal (IndexedDB) and committed before the step runs. After a crash, a closed tab or an unplugged drive, DriveTidy shows what is unfinished, classifies each file by observing the drive, and waits for the user. Nothing runs automatically at startup. Undo exists only for moves and renames DriveTidy can prove it made. Permanent deletes are irreversible and are recorded, never undone. The journal stores paths, fingerprints, metadata and handles, never file contents. It is not a backup. There is no atomicity between IndexedDB and the drive. Every step after the last commit may or may not have happened, so recovery observes and never assumes.

Release 1 is genuinely read-only (section G). File-moving integration ships only after that foundation is tested.

## A. Code paths

- `src/lib/fs.ts` `moveFile()` stays the single entry point for fresh moves. It gains an awaited `journal` hook: each mutation's intent is committed before the filesystem call and its result after; a failed commit stops before the next call. The Phase 1/1.1 guarantees are unchanged.
- New in `fs.ts`: `journaledEnsureDir()` (per-folder records), `placeFinal()` (sections C2–C3), `finalizeVerifiedCopy()` (Finish move; never calls `moveFile`).
- Integrations: `RestructurePanel.apply()` and `RenamePanel.rename()` come in release 2. `DuplicatesPanel` and `HealthPanel` moves and deletes come in release 3.
- New modules: `src/lib/journal.ts`, `src/lib/recovery.ts` (pure classification), `src/lib/oplock.ts`, `src/components/tidy/HistoryPanel.tsx`, `src/components/tidy/RecoveryNotice.tsx`. `src/routes/index.tsx` gets a History tab and a notice. `activity.ts` stays the live in-memory log.

## B. IndexedDB schema (`drivetidy-journal`, version 1)

- `roots`: `{ id, handle?, name, firstSeen }`
- `batches`: `{ id, kind, rootId, title, createdAt, updatedAt, status, visibility: active|dismissed|archived, irreversible, durability: strict|relaxed, counts, schema }`
  - `kind`: restructure, rename, duplicates-move, quarantine-move, delete, empty-folders, undo
  - `status`: running, stopped, interrupted, completed, completed-with-issues, resolved, undone
- `ops` (indexed by `batchId`, `[batchId,state]` and `txId`): `{ id, txId, batchId, seq, action, fromDir, fromName, toDir, intendedName, stagingName?, finalName?, size, lastModified, sourceSha256, copiedSha256?, finalSha256?, sourceHandle?, stagingHandle?, finalHandle?, identity: { source, staging, final: handle|unconfirmed }, state, error?, updatedAt, undoOf? }`
- `dirs`: `{ id, opId, path, state: create-intent|created|observed-existing, handle?, intentAt }`
- **Handles:** file and directory handles are structured-cloned into records. Support is feature-detected per session with a probe write. On `DataCloneError` only paths are stored, and identity is `unconfirmed`.
- **Commit rule and durability:** safety-critical commits use `db.transaction(stores, "readwrite", { durability: "strict" })`. A step counts as committed only on `oncomplete`; a transaction abort, `QuotaExceededError` or an unavailable database blocks the next mutation and marks the batch `interrupted`.
  - `strict` is a browser hint to flush before `oncomplete`, not an absolute guarantee against OS or hardware loss.
  - If the option is unsupported (detected via `IDBTransaction.durability`), the default durability is used and the batch is marked `relaxed`. Before starting, the user sees "This browser can't request a guaranteed save of the history; after a power cut the last step may be missing from it." They can cancel. The recovery rules already tolerate a missing last record, because they observe the drive.
- Corrupt or unknown-version records are kept as "Unreadable record – needs review", with no actions.
- A failed migration opens the history read-only, shows "History unavailable" and blocks journaled operations; scanning still works.
- **Retention:** clean `completed` and `undone` batches are kept for the last 50 batches or 90 days, whichever keeps more. Nothing else is auto-pruned. "Delete record" is explicit and never touches files.

## C. State machines

### C1. Per-file move

```text
planned -> hashed (sourceSha256, size, lastModified, sourceHandle)
  -> [folders: C4]
  native path:  native-intent -> [move()] -> native-moved -> [full hash of dest] -> completed | conflict
  copy path:    staging-intent -> [create .drivetidy-<txId>.part] -> staging-created (stagingHandle, before any write)
                -> [stream copy, hashing bytes read] -> copied (copiedSha256 must = sourceSha256, else conflict)
                -> [full hash of staging] -> staging-verified
                -> placement (C2) -> placed (finalSha256 = sourceSha256)
                -> staging-removal-intent -> [remove staging via owned handle] (fallback B only)
                -> source-revalidate (same entry + full hash = sourceSha256) -> source-removal-intent
                -> [remove source] -> completed
any -> stopped | failed | conflict | needs-review
```

- **Snapshot consistency:** size and lastModified are re-read right before the move. Any difference is a `conflict` ("changed after fingerprinting"). The bytes actually copied must hash to `sourceSha256`. A changed source never proceeds under the old fingerprint.

### C2. Final-name placement (no atomic no-overwrite exists)

The File System Access API has no create-exclusive call: `getFileHandle(name, { create: true })` returns an existing file, and `move()` onto an existing name may replace it. DriveTidy therefore never claims atomic placement. It narrows the race and stops whenever it has any doubt.

- **Promotion A** (`staging.move(dir, finalName)`, where supported):
  1. Commit `final-create-intent` with `finalName`.
  2. Confirm with `getFileHandle(finalName)` that the name is absent; if present, choose a new free name and commit it first.
  3. Run `move()`.
  4. Commit `final-created` with `finalHandle`.
  5. Fully hash the final file, then commit `final-verified` → `placed`.

  If `move()` reports "exists", or the post-move hash differs, the op stops for manual resolution; nothing is deleted.

- **Promotion B** (move unsupported):
  1. Commit `final-create-intent`, then pre-check that the name is absent.
  2. Call `getFileHandle(finalName, { create: true })`.
  3. Immediately inspect the returned file. It must be 0 bytes, with `lastModified` ≥ the intent time and not `isSameEntry` with any other known handle. Otherwise it is a pre-existing file: stop. Nothing is opened for writing, and the verified staging file is kept for the user.
  4. Commit `final-created` with `finalHandle`, before any write.
  5. Commit `final-copying`. Write with `createWritable({ keepExistingData: false })`, after re-checking that the file is still 0 bytes.
  6. Fully hash the final file and commit `final-verified`, then `placed`.

  The staging file is kept until `placed` is committed.

- **Residual risk:** another application could create, or write a 0-byte file at, the same name in the instant between the checks and the creation or write. DriveTidy detects every non-empty or older collision and stops. A same-instant empty file cannot be told apart and is the only accepted residual.
- A partial final file is removable only when the stored `finalHandle` `isSameEntry()` the file at that path. Otherwise the outcome is needs-review.

### C3. Delete (irreversible)

`delete-revalidate` (source same entry + full hash = recorded) → `delete-intent` → `[removeEntry]` → `delete-observed-absent`. Any revalidation failure means the file is not deleted and goes to review.

### C4. Folder creation (per segment)

For each segment:

1. Look it up without `create`. If it exists, record `observed-existing`; it is never a cleanup candidate.
2. If it is missing, commit `create-intent`, then call `getDirectoryHandle(seg, { create: true })`.
3. Commit `created` with the handle.

A crash leaves at most one segment in `create-intent`. A matching handle does **not** prove DriveTidy created the folder, because another program may have created it between the lookup and the create call. So `created` means "probably created by DriveTidy". Cleanup is offered only after Undo, only for `created` folders whose handle is the same entry and that are empty now. It is non-recursive, deepest first, and listed for explicit confirmation ("These folders appear to have been created by DriveTidy and are empty"). Folders in `create-intent` are never offered.

## D. Recovery classification (runs only on Review; labels only, never mutates)

| Last committed state                            | Observed                                                | Outcome                                                                       |
| ----------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------- |
| planned / hashed                                | source matches, nothing at destination                  | not started: Resume                                                           |
| hashed                                          | source size, date or hash differs                       | conflict: re-plan only                                                        |
| native-intent                                   | source matches, dest absent                             | not moved: Resume                                                             |
| native-intent / native-moved                    | source absent, dest hash matches, handle same entry     | completed                                                                     |
| any                                             | source absent, dest hash matches, identity unprovable   | **probable completion – identity unconfirmed**; Undo/Finish need confirmation |
| native-moved                                    | dest hash differs                                       | conflict; kept in place                                                       |
| staging-intent                                  | file at the staging path                                | needs-review (unproven origin); no delete offered                             |
| staging-created / copied                        | `.part` present, stagingHandle same entry               | reverted-safe: "Remove leftover partial copy"                                 |
| staging-created / copied                        | `.part` present, ownership unprovable                   | needs-review; no delete offered                                               |
| staging-verified / final-create-intent          | staging present, final absent                           | Resume placement                                                              |
| final-create-intent                             | file at final name                                      | needs-review "file at destination not proven ours"; untouched                 |
| final-created / final-copying                   | final present, finalHandle same entry, staging verified | partial final file: "Remove partial final copy" and Resume                    |
| final-created / final-copying                   | final present, ownership unprovable                     | needs-review; staging kept                                                    |
| final-verified / placed / source-removal-intent | source and final both match                             | awaiting-finalize: Finish move or Keep both; never re-copy                    |
| any                                             | source and dest both present, differ                    | needs-review                                                                  |
| delete-intent                                   | file present, matches                                   | not deleted: re-confirm                                                       |
| delete-intent                                   | file absent                                             | **absent – deletion outcome unconfirmed** (not attributed to DriveTidy)       |
| dirs create-intent                              | folder present                                          | ownership unknown; never removed                                              |
| any                                             | both absent                                             | needs-review "file missing"                                                   |
| any                                             | permission missing or drive absent                      | waiting for access                                                            |

## E. Actions

- **Resume:** only not-started or reverted-safe ops. It revalidates the source's identity and hash, then runs a fresh journaled `moveFile()`.
- **Finish move:**
  1. Source same entry.
  2. Full source hash = `sourceSha256`.
  3. Full final hash = `finalSha256`.
  4. Commit `source-removal-intent`.
  5. Remove the source.
  6. Commit `completed`.
- **Undo:** completed ops only, never deletes or rmdir, never irreversible batches. The destination must be the same entry and its full hash must match. If the original name is taken, the user chooses "(restored)" or Skip. The restore runs through journaled `moveFile()` and C2 placement. Folder cleanup follows C4.
- **Retry failed:** a new linked batch after source revalidation.
- **Dismiss:** hides the batch and keeps its records.
- **Unconfirmed identity:** Resume, Finish move and Undo require a per-batch confirmation: "DriveTidy can't prove these are the same files it recorded; fingerprints will still be checked."
- **Reconnect:** `requestPermission` only from a click. A reselected folder is checked with `isSameEntry`, else marked "folder identity unconfirmed".
- **Multiple tabs:** a Web Locks exclusive lock per root is held for every mutating batch; without Web Locks, mutations are refused.

## F. Tests

**Automated (Vitest, mocked handles plus fake-indexeddb):**

- One test per row of table D.
- Commit ordering: no filesystem call after a failed commit.
- Strict durability is requested; when unsupported, the batch is marked relaxed and the warning is required.
- C2:
  - A name taken between the check and creation → stop, staging kept.
  - The create call returns a non-empty or older file → no writable opened.
  - The final handle is stored before the first write.
  - A partial final file is removed only when it is the same entry.
  - `placed` is never committed before the final hash matches.
  - Promotion A "exists" error → stop.
- Snapshot change → conflict.
- Native move with a hash mismatch → conflict.
- Delete revalidation failure → no delete.
- Absent file after `delete-intent` → "outcome unconfirmed".
- Folders:
  - A crash in `create-intent` → never offered for cleanup.
  - An `observed-existing` folder → never offered.
  - A non-empty folder → refused.
- Undo, Retry, Dismiss, retention, the permission click spy, the lock, schema migration and corrupt records.
- All 53 existing tests still pass.

**Manual acceptance (required before release 2 and again before release 3), in Chrome and Edge on Windows plus one of macOS or Linux, with a real local folder and a USB drive:**

1. Same-drive and cross-drive restructure of small and multi-GB files; hashes match afterwards.
2. Another application (Explorer or a script) creates the final filename during a long copy → DriveTidy stops and the user file is intact.
3. Kill the tab or browser during staging copy, during final copying and before source removal; restart, then Review shows the correct rows and actions.
4. Unplug the USB drive mid-copy → classified as waiting for access, then correct after reconnecting.
5. Restart the browser → the permission prompt appears only on click; reselecting a different folder is flagged.
6. Two tabs on the same drive → the second is blocked.
7. Undo after editing one moved file → that file is skipped.

Mock tests alone are not proof of real filesystem behaviour; results are recorded in the plan archive.

## G. Releases, performance, limitations

**Release 1 (read-only, no file mutations):**

- `journal.ts` with strict commits.
- `oplock.ts`.
- `recovery.ts` classification over fixtures.
- History tab, notice and Reconnect.

No panel writes journal mutations yet. Batches can be recorded as dry-run plans only.

**Release 2 (after release 1 tests and manual checks):**

- Journaled `moveFile`, C2 placement and C4 folders.
- Restructure, then Rename.
- Finish move, Resume, Retry and Undo.

**Release 3:** duplicate and quarantine moves, delete revalidation and records, retention.

Complexity: high, about 10–12 sessions.

**Reads and writes per file of size S:**

| Path                   | Steps                                                                                                                | Total                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Native same-drive move | fingerprint 1R + destination hash 1R                                                                                 | 2R                                     |
| Copy path, promotion A | fingerprint 1R + copy 1R/1W (hashed in-stream) + staging hash 1R + final hash after move 1R + source revalidation 1R | 5R + 1W                                |
| Copy path, promotion B | fingerprint 1R + copy 1R/1W + staging hash 1R + staging→final copy 1R/1W + final hash 1R + source revalidation 1R    | 6R + 2W, with 2×S temporary free space |
| Delete                 | revalidation                                                                                                         | 1R                                     |

At about 100 MB/s (USB 3), a 4 GB file takes about 1.5 min natively, about 4 min with A and about 5–6 min with B. USB 2 is about 4× slower. Hashing runs on the page thread until Phase 4.

Progress stages: Fingerprinting → Preparing folders → Copying → Verifying copy → Placing → Verifying final file → Re-checking original → Removing original. The ETA uses measured throughput.

**Remaining API limitations:**

- No create-exclusive file creation and no atomic no-overwrite rename. A same-instant empty-file collision is undetectable (C2).
- No atomic "delete if unchanged": a write between the final revalidation and `removeEntry` is undetectable.
- `isSameEntry` proves identity, not authorship. It can't prove DriveTidy created a folder or file, only that a stored handle points to the same entry.
- `durability: "strict"` is a hint. A power cut can still lose the last commit, and recovery tolerates this by observing the drive.
- `move()` support and its overwrite behaviour vary by OS, filesystem and Chromium version; cross-drive moves usually fall back to copying.
- Stored handles usually need permission again after a restart; drive-letter changes need the folder to be reselected.
- No IndexedDB-to-drive transaction exists; the journal records intent, not outcome.
