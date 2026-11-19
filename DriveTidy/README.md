# DriveTidy

DriveTidy is a privacy-first desktop file organizer. It scans folders locally,
finds verified duplicates within one drive or across several selected drives and
locally synced cloud folders, restructures files, and can suggest descriptive names
using Ollama running on your own computer.

The cross-drive comparison is a read-only report. Choose each external drive or
folder to include; for Google Drive and OneDrive, choose folders available through
their Windows sync clients. Online-only or provider-only files may need to be made
available on this PC before they can be read. DriveTidy compares file contents
locally with SHA-256 and does not connect to cloud APIs or upload file contents.

## Desktop app

Requirements: Node.js 22+ or Bun.

```sh
bun install
bun run build
bun run desktop
```

Create platform installers:

```sh
bun run desktop:verify
bun run desktop:win
bun run desktop:mac
bun run desktop:linux
```

Installers are written to `release/`. Build each installer on its target operating
system. A GitHub Actions workflow is included to build the Windows installer on a
Windows runner; see [LOCAL_SETUP.md](LOCAL_SETUP.md) for instructions.

## Architecture

- React, TypeScript, TanStack Start, and Tailwind CSS
- Electron desktop shell with a local Nitro Node server
- File access stays local through the browser File System Access API
- IndexedDB operation journal and explicit recovery review
- Optional local Ollama integration; no cloud AI requirement

## Development

```sh
bun install
bun run dev
```

\n\n## Restore quarantined files\n\nOpen **History**, find a completed **Quarantine verified duplicates** batch, and choose **Restore files**. DriveTidy verifies each quarantined file against its recorded SHA-256 fingerprint and returns it to its original folder only when that destination is available. DriveTidy checks for occupied destinations and skips conflicts; the browser file API cannot guarantee an atomic no-replace move against simultaneous external changes. Missing folders are also skipped and reported. Restores are recorded as separate history operations. The journal is not a backup, so keep independent backups of important data.\n\n\n## Interrupted operation review\n\nIf DriveTidy closes during a move, reopen the same drive and open **History**. Choose **Review recovery** on an unfinished batch. The review checks the recorded source and any reliably identifiable destination against their SHA-256 fingerprints and labels each step as not started, completed, probable completion, conflict, or needing manual review. Where the journal did not save a full nested destination path, DriveTidy deliberately marks the destination as unverified instead of guessing. This inspection is read-only: it does not move, delete, rename, or overwrite files. A probable completion means the file contents match but the destination's identity or exact location could not be fully confirmed. Follow the suggested next step only after checking the displayed paths in File Explorer.\n

### Recovery path safety

New journal entries record the full destination path relative to the selected drive, not only the destination folder name. Recovery review uses that path to inspect the exact destination. For an interrupted move, DriveTidy offers **Confirm this move** only when the original path is absent, the destination SHA-256 matches the recorded content, and the destination handle matches the handle saved by the journal. This confirmation updates history only; it does not move, rename, or delete files. Older records without a full path remain subject to conservative legacy inspection.

### Health-check safety

Problem and unreadable files are moved only into a journaled quarantine. The Health panel has no permanent-delete action, and the unused direct-delete helper has been removed. Review quarantined items in History and restore verified files when appropriate; occupied original paths are skipped.

## History backup and portability

Open **History** and choose **Export backup** to download a JSON snapshot of operation history. Choose **Import backup** to bring a snapshot into another DriveTidy installation.

Backups contain journal metadata and file paths, not file contents. The JSON export is not encrypted; treat it as private because names and folder paths may be sensitive. Imported records are deliberately added as **archived, read-only history**: DriveTidy assigns fresh record/root IDs, removes live filesystem handles, and does not let imported records trigger restore or recovery actions. Existing records are never overwritten. This is a history portability feature, not a file backup.

## Windows installer

The Windows installer is an x64 NSIS setup executable. Build it on Windows with
`bun run desktop:win`, or use the GitHub Actions workflow. The installer keeps
DriveTidy's local app data when uninstalled. The desktop app uses a stable,
loopback-only origin so its IndexedDB journal and saved directory handles remain
available between launches. See [LOCAL_SETUP.md](LOCAL_SETUP.md).

The Electron desktop build uses the stable, loopback-only origin `http://127.0.0.1:43821` to preserve browser storage between launches. It authenticates its local health check and stops if that port is already occupied.
