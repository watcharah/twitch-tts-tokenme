"use strict";

const { app, BrowserWindow, shell, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const https = require("https");
const http = require("http");
const { spawn } = require("child_process");
const { listen } = require("./tokenme-server/server");

const UPDATE_REPO = "watcharah/twitch-tts-tokenme";
const UPDATE_ASSET = "TwitchChatTTS-windows-portable.zip";
const UPDATE_CHECK_DELAY_MS = 3000;

let mainWindow = null;
let proxyServer = null;
let proxyUrl = "http://127.0.0.1:8765";
let pendingUpdate = null;
let updateInProgress = false;

function compareSemver(a, b) {
  const pa = String(a || "0").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const pb = String(b || "0").replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: {
          "User-Agent": "TwitchChatTTS-Updater",
          Accept: "application/vnd.github+json",
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          fetchJson(res.headers.location).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(
      url,
      {
        headers: { "User-Agent": "TwitchChatTTS-Updater" },
        timeout: 120000,
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          downloadFile(res.headers.location, dest, onProgress).then(resolve, reject);
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers["content-length"] || "0", 10) || 0;
        let received = 0;
        const out = fs.createWriteStream(dest);
        res.on("data", (chunk) => {
          received += chunk.length;
          if (onProgress) {
            onProgress({
              received,
              total,
              percent: total ? Math.min(100, Math.round((received / total) * 100)) : 0,
            });
          }
        });
        res.pipe(out);
        out.on("finish", () => out.close(() => resolve(dest)));
        out.on("error", reject);
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
  });
}

function getInstallRoot() {
  if (app.isPackaged) {
    // electron-packager: .../TwitchChatTTS-win32-x64/TwitchChatTTS.exe
    return path.dirname(process.execPath);
  }
  return app.getAppPath();
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

async function checkForUpdates({ silent } = { silent: true }) {
  try {
    const current = app.getVersion();
    const release = await fetchJson(
      `https://api.github.com/repos/${UPDATE_REPO}/releases/latest`
    );
    const tag = String(release.tag_name || "").replace(/^v/i, "");
    if (!tag || compareSemver(tag, current) <= 0) {
      return { updateAvailable: false, current, latest: tag || current };
    }
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const asset = assets.find((a) => a && a.name === UPDATE_ASSET);
    if (!asset || !asset.browser_download_url) {
      throw new Error(`ไม่พบไฟล์ ${UPDATE_ASSET} ใน Release`);
    }
    pendingUpdate = {
      version: tag,
      current,
      name: release.name || `v${tag}`,
      notes: release.body || "",
      url: asset.browser_download_url,
      size: asset.size || 0,
    };
    sendToRenderer("update-available", pendingUpdate);
    return { updateAvailable: true, ...pendingUpdate };
  } catch (err) {
    if (!silent) {
      sendToRenderer("update-error", err.message || String(err));
    }
    return { updateAvailable: false, error: err.message || String(err) };
  }
}

function writeInstallerBat({ zipPath, extractDir, installRoot, exeName }) {
  const batPath = path.join(app.getPath("temp"), "twitch-tts-update-installer.bat");
  const pid = process.pid;
  // Escape for batch: use short paths via quotes; replace % carefully
  const q = (p) => `"${String(p).replace(/"/g, "")}"`;
  const bat = `@echo off
setlocal
set PID=${pid}
set ZIP=${q(zipPath)}
set EXTRACT=${q(extractDir)}
set TARGET=${q(installRoot)}
set EXE=${q(path.join(installRoot, exeName))}

:waitloop
tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL
if not errorlevel 1 (
  timeout /t 1 /nobreak >NUL
  goto waitloop
)

if exist %EXTRACT% rmdir /s /q %EXTRACT%
mkdir %EXTRACT% >NUL 2>&1

tar -xf %ZIP% -C %EXTRACT% 2>NUL
if errorlevel 1 (
  powershell -NoProfile -Command "Expand-Archive -LiteralPath %ZIP% -DestinationPath %EXTRACT% -Force"
)

set SRC=
if exist %EXTRACT%\\TwitchChatTTS-win32-x64\\TwitchChatTTS.exe (
  set SRC=%EXTRACT%\\TwitchChatTTS-win32-x64
) else if exist %EXTRACT%\\TwitchChatTTS.exe (
  set SRC=%EXTRACT%
) else (
  for /d %%D in (%EXTRACT%\\*) do (
    if exist "%%D\\TwitchChatTTS.exe" set SRC=%%D
  )
)

if not defined SRC (
  echo Update extract failed > %TEMP%\\twitch-tts-update-error.txt
  goto cleanup
)

xcopy /E /Y /I /Q "%SRC%\\*" %TARGET% >NUL
start "" %EXE%

:cleanup
timeout /t 2 /nobreak >NUL
if exist %ZIP% del /f /q %ZIP% >NUL 2>&1
if exist %EXTRACT% rmdir /s /q %EXTRACT% >NUL 2>&1
del /f /q "%~f0" >NUL 2>&1
`;
  fs.writeFileSync(batPath, bat, "utf8");
  return batPath;
}

async function startUpdate() {
  if (updateInProgress) return { ok: false, error: "กำลังอัปเดตอยู่แล้ว" };
  if (!pendingUpdate || !pendingUpdate.url) {
    const result = await checkForUpdates({ silent: false });
    if (!result.updateAvailable) {
      return { ok: false, error: result.error || "ไม่มีเวอร์ชันใหม่" };
    }
  }
  updateInProgress = true;
  try {
    const tempDir = app.getPath("temp");
    const zipPath = path.join(tempDir, UPDATE_ASSET);
    const extractDir = path.join(tempDir, "TwitchChatTTS-update-extract");
    if (fs.existsSync(zipPath)) {
      try { fs.unlinkSync(zipPath); } catch (_) {}
    }
    sendToRenderer("update-progress", { percent: 0, received: 0, total: pendingUpdate.size || 0, stage: "download" });
    await downloadFile(pendingUpdate.url, zipPath, (p) => {
      sendToRenderer("update-progress", { ...p, stage: "download" });
    });
    sendToRenderer("update-progress", { percent: 100, stage: "install" });
    const installRoot = getInstallRoot();
    const exeName = path.basename(process.execPath) || "TwitchChatTTS.exe";
    const batPath = writeInstallerBat({
      zipPath,
      extractDir,
      installRoot,
      exeName: app.isPackaged ? exeName : "TwitchChatTTS.exe",
    });
    const child = spawn("cmd.exe", ["/c", batPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.unref();
    setTimeout(() => app.quit(), 400);
    return { ok: true };
  } catch (err) {
    updateInProgress = false;
    sendToRenderer("update-error", err.message || String(err));
    return { ok: false, error: err.message || String(err) };
  }
}

async function startProxy() {
  try {
    const result = await listen(8765);
    proxyServer = result.server;
    proxyUrl = result.url;
    console.log("[main] TokenMe proxy at", proxyUrl);
  } catch (err) {
    console.error("[main] TokenMe proxy failed:", err.message);
  }
}

function createWindow() {
  const iconPath = path.join(__dirname, "build", process.platform === "win32" ? "icon.ico" : "icon.png");
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 800,
    minHeight: 600,
    title: "Twitch Chat TTS",
    icon: iconPath,
    backgroundColor: "#0f1115",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  const indexPath = path.join(__dirname, "web", "index.html");
  const qs = new URLSearchParams({ proxy: proxyUrl, desktop: "1" }).toString();
  mainWindow.loadFile(indexPath, { search: qs });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => { mainWindow = null; });
}

function registerIpc() {
  ipcMain.handle("get-app-version", () => app.getVersion());
  ipcMain.handle("check-for-updates", async () => checkForUpdates({ silent: false }));
  ipcMain.handle("start-update", async () => startUpdate());
}

app.whenReady().then(async () => {
  registerIpc();
  await startProxy();
  createWindow();
  setTimeout(() => {
    checkForUpdates({ silent: true }).catch(() => {});
  }, UPDATE_CHECK_DELAY_MS);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

function shutdownProxy() {
  if (proxyServer) {
    try { proxyServer.close(); } catch (_) {}
    proxyServer = null;
  }
}

app.on("window-all-closed", () => {
  shutdownProxy();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", shutdownProxy);
