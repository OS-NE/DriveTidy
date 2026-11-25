# DriveTidy — install and run as a desktop app

DriveTidy is designed to run locally on your computer. The desktop build opens in
its own application window, starts a private server bound only to `127.0.0.1`, and
does not require hosting, a public website, an account, or a cloud AI key.

## Build prerequisites

- Node.js 22 or newer (or Bun)
- Git (optional)
- For packaging: Windows, macOS, or Linux build environment
- Optional: [Ollama](https://ollama.com/download) for local AI renaming

## Build and run from source

```sh
bun install
bun run build
bun run desktop
```

Bun works too: `bun install && bun run build && bun run desktop`.

The first build compiles the app into Nitro's self-hosted Node server output. The
Electron shell then launches that server on the stable loopback origin
`http://127.0.0.1:43821` and opens the desktop window. The server listens only on
`127.0.0.1`, not on your network.

## Create an installer

Run the platform-specific command on the operating system you want to package:

```sh
bun run desktop:verify  # verify Nitro/Electron packaging inputs
bun run desktop:win     # Windows x64 NSIS installer in ./release
bun run desktop:mac     # macOS DMG in ./release
bun run desktop:linux   # Linux AppImage and DEB in ./release
```

Or run `bun run desktop:dist` for the current platform.

Installers are built locally; code signing/notarization credentials are not bundled.
Unsigned macOS builds may require approval in Privacy & Security on first launch.
Windows SmartScreen may show a warning until the app is code-signed.

## Optional local AI (Ollama)

1. Install Ollama: https://ollama.com/download
2. Pull a supported vision model, for example `ollama pull llama3.2-vision`.
3. Open DriveTidy → Settings → Local AI · Ollama → Save & test.

AI requests go to Ollama on your own machine. File contents are not uploaded to a
DriveTidy server.

## Data and safety

- File access stays in the desktop renderer through the File System Access API.
- The desktop shell exposes no Node.js APIs to the UI (`contextIsolation`,
  `sandbox`, and `nodeIntegration: false`).
- The embedded app server binds to loopback only.
- Operation history is stored locally in IndexedDB. It is a journal, not a backup.
- Always review a proposed operation before applying it and keep independent backups
  of important files.

### Recovery path safety

New journal entries record the full destination path relative to the selected drive, not only the destination folder name. Recovery review uses that path to inspect the exact destination. For an interrupted move, DriveTidy offers **Confirm this move** only when the original path is absent, the destination SHA-256 matches the recorded content, and the destination handle matches the handle saved by the journal. This confirmation updates history only; it does not move, rename, or delete files. Older records without a full path remain subject to conservative legacy inspection.

Safety note: Health checks quarantine problem files rather than permanently deleting them. Restore verified items from History; conflicting original paths are skipped.

### Exporting and importing operation history

In the History panel, use **Export backup** for a portable JSON journal snapshot, or **Encrypted export** to protect the snapshot with a passphrase. Import accepts either format. Encrypted backups use PBKDF2-SHA-256 and AES-256-GCM; choose at least 12 characters and keep the passphrase separately because it cannot be recovered. Backups contain paths and operation metadata but never file contents. Imported entries are archived, read-only records and cannot authorize changes to files.

### Windows installer and persistent desktop storage

The Windows build creates an x64 NSIS installer named `DriveTidy-Setup-<version>.exe`.
The installer offers a per-user installation path, Start Menu/Desktop shortcuts, and
does not delete DriveTidy's local application data when the app is uninstalled.

The desktop shell uses the stable loopback origin `http://127.0.0.1:43821`. Keeping
the port stable is important: Chromium storage, including the IndexedDB operation
journal and saved directory handles, is scoped to an origin. DriveTidy also performs
a token-authenticated local health check before opening the window. If the port is
already occupied, startup stops with an explanatory error rather than opening an
untrusted local service or silently switching storage origins.

To build in GitHub Actions, open **Actions → Build DriveTidy for Windows → Run workflow**.
The `.exe` is uploaded as a 30-day workflow artifact. Pushing a version tag such as
`v0.8.0` additionally publishes a GitHub Release with the installer attached.

The Windows CI workflow uses Bun because `bun.lock` is the repository's dependency
lockfile. Electron and electron-builder are pinned in `package.json`. The first
Windows workflow run refreshes `bun.lock` for those newly added desktop dependencies
and uploads it as a separate `DriveTidy-Bun-Lockfile` artifact. Download and commit
that updated lockfile before the next release build. Do not switch to npm unless an
npm `package-lock.json` is generated and committed as the chosen lockfile.
