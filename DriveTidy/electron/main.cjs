const { app, BrowserWindow, dialog, shell } = require("electron");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { randomBytes } = require("node:crypto");

const HOST = "127.0.0.1";
// A stable origin is required for Chromium IndexedDB and persisted file handles.
const PORT = 43821;
const HEALTH_PATH = "/__drivetidy_health";
const HEALTH_TOKEN = randomBytes(32).toString("hex");
let mainWindow;
let startupPromise;

app.setName("DriveTidy");
if (process.platform === "win32") {
  app.setAppUserModelId("com.tawheedxd.drivetidy");
}

function assertPortAvailable(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(
          `DriveTidy cannot start because its local port ${port} is already in use. ` +
          "Close the other application using this port and try again."
        ));
      } else {
        reject(error);
      }
    });
    probe.listen(port, HOST, () => {
      probe.close((error) => error ? reject(error) : resolve());
    });
  });
}

async function waitForServer() {
  const url = `http://${HOST}:${PORT}${HEALTH_PATH}`;
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        headers: { "x-drivetidy-health-token": HEALTH_TOKEN },
        signal: AbortSignal.timeout(1200),
        cache: "no-store",
      });
      if (response.status === 204) return;
      lastError = new Error(`Unexpected local health response: HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`DriveTidy's private local server did not become ready: ${lastError || "timeout"}`);
}

async function startLocalServer() {
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    await assertPortAvailable(PORT);
    const serverEntry = path.join(app.getAppPath(), ".output", "server", "index.mjs");
    process.env.NODE_ENV = "production";
    process.env.HOST = HOST;
    process.env.NITRO_HOST = HOST;
    process.env.PORT = String(PORT);
    process.env.NITRO_PORT = String(PORT);
    process.env.NITRO_PRESET = "node-server";
    process.env.DRIVETIDY_HEALTH_TOKEN = HEALTH_TOKEN;
    await import(pathToFileURL(serverEntry).href);
    await waitForServer();
    return PORT;
  })();
  try {
    return await startupPromise;
  } catch (error) {
    startupPromise = undefined;
    throw error;
  }
}

async function createMainWindow() {
  const port = await startLocalServer();
  const appOrigin = `http://${HOST}:${port}`;
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 980,
    minHeight: 680,
    show: false,
    backgroundColor: "#101216",
    title: "DriveTidy",
    icon: path.join(app.getAppPath(), "build", "icon.ico"),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("mailto:")) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let targetOrigin;
    try {
      targetOrigin = new URL(url).origin;
    } catch {
      event.preventDefault();
      return;
    }
    if (targetOrigin !== appOrigin) event.preventDefault();
  });
  await mainWindow.loadURL(`${appOrigin}/`);
  mainWindow.on("closed", () => { mainWindow = null; });
}

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await createMainWindow();
    } catch (error) {
      console.error("DriveTidy startup failed:", error);
      dialog.showErrorBox("DriveTidy could not start", error?.message || String(error));
      app.quit();
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow().catch((error) => {
        console.error("Could not reopen DriveTidy:", error);
        dialog.showErrorBox("DriveTidy could not reopen", error?.message || String(error));
      });
    }
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
