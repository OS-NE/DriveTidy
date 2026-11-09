# Windows installer notes — DriveTidy 0.8.0

- Windows x64 NSIS installer with DriveTidy branding.
- Per-user install by default; user can choose an installation directory.
- Desktop and Start Menu shortcuts.
- Uninstall leaves DriveTidy's local application data in place.
- Preflight verifies Nitro server output, public assets, Electron entry, and icon.
- GitHub Actions uses Bun and exact-pinned Electron packaging tools. On the first run it refreshes `bun.lock` to include the desktop dependencies and uploads that lockfile as a separate artifact; commit that artifact before the next release build for a fully locked dependency graph.
- Workflow runs tests, builds, packages, generates a SHA-256 checksum, and uploads both.
- Tag pushes (`v*`) also publish a GitHub Release with the `.exe` attached.
- The desktop server binds to `127.0.0.1:43821`; a per-launch token protects its
  health check. A busy port causes a visible startup error rather than fallback to
  a different origin.

## Code signing

This configuration does not sign the executable. Windows may display an
unknown-publisher / SmartScreen warning. A trusted Authenticode certificate and
secure CI secret configuration are required before publishing a signed installer.
Do not put a `.pfx` certificate or password in the repository.
