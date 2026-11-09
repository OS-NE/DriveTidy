# DriveTidy desktop shell

DriveTidy is packaged as a native desktop application using Electron. Electron hosts
the production TanStack/Nitro Node server on `127.0.0.1:43821`, then opens it in a
hardened Chromium window. The server is not exposed to the LAN.

The fixed loopback origin preserves Chromium IndexedDB and persisted File System
Access handles across launches. Before opening the window, Electron checks that the
port is free, starts the Nitro server, and requires a per-launch token-authenticated
health response. If the port is occupied or the expected server does not start, the
application displays an error and quits instead of connecting to another process.

The shell enables context isolation and sandboxing, disables Node integration,
restricts navigation to its own loopback origin, and opens approved external links
in the system browser. Build the web app before launching Electron.
