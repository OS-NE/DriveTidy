const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const required = [
  ".output/server/index.mjs",
  ".output/public",
  "electron/main.cjs",
  "build/icon.ico",
  "src/server.ts",
];

const missing = required.filter((item) => !fs.existsSync(path.join(root, item)));
if (missing.length) {
  console.error("Desktop packaging check failed. Missing build inputs:");
  for (const item of missing) console.error(`  - ${item}`);
  console.error("Run the production build and restore the desktop source assets.");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!pkg.version || !pkg.main || pkg.main !== "electron/main.cjs") {
  console.error("package.json must define a version and main=electron/main.cjs.");
  process.exit(1);
}

const build = pkg.build || {};
const winTargets = build.win?.target || [];
const hasX64Nsis = winTargets.some((target) =>
  typeof target === "string"
    ? target === "nsis"
    : target?.target === "nsis" && (target.arch || []).includes("x64"),
);
if (!hasX64Nsis) {
  console.error("Windows packaging must include the NSIS x64 target.");
  process.exit(1);
}
if (build.nsis?.oneClick !== false || build.nsis?.allowToChangeInstallationDirectory !== true) {
  console.error("NSIS must use the assisted installer with directory selection.");
  process.exit(1);
}
if (!build.files?.includes("build/icon.ico")) {
  console.error("build/icon.ico must be included for the desktop window icon.");
  process.exit(1);
}

const electronMain = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");
const serverSource = fs.readFileSync(path.join(root, "src/server.ts"), "utf8");
if (
  !electronMain.includes("const PORT = 43821") ||
  !electronMain.includes("x-drivetidy-health-token") ||
  !serverSource.includes("/__drivetidy_health") ||
  !serverSource.includes("DRIVETIDY_HEALTH_TOKEN")
) {
  console.error("Stable-origin authenticated local health-check configuration is incomplete.");
  process.exit(1);
}

const serverEntry = fs.readFileSync(path.join(root, ".output/server/index.mjs"), "utf8");
if (!serverEntry.trim()) {
  console.error("Nitro server entry is empty.");
  process.exit(1);
}

console.log(`Desktop package preflight passed for DriveTidy ${pkg.version}.`);
console.log(
  "Found Nitro server output, public assets, Electron entry, Windows x64 NSIS config, icon, and authenticated health check.",
);
