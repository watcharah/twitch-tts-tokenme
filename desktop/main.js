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

function writeInstallerScript({ zipPath, extractDir, installRoot, exeName }) {
  const ps1Path = path.join(app.getPath("temp"), "twitch-tts-update-installer.ps1");
  const lit = (p) => "'" + String(p).replace(/'/g, "''") + "'";
  const ps = `$ErrorActionPreference = 'SilentlyContinue'
$procId = ${process.pid}
$zip = ${lit(zipPath)}
$extract = ${lit(extractDir)}
$target = ${lit(installRoot)}
$exe = ${lit(path.join(installRoot, exeName))}
for ($i = 0; $i -lt 120; $i++) {
  if (-not (Get-Process -Id $procId -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 500
}
Start-Sleep -Milliseconds 500
if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
New-Item -ItemType Directory -Path $extract -Force | Out-Null
Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force
$found = Get-ChildItem -LiteralPath $extract -Recurse -Filter 'TwitchChatTTS.exe' | Select-Object -First 1
if ($found) {
  Copy-Item -Path (Join-Path $found.DirectoryName '*') -Destination $target -Recurse -Force
  Start-Process -FilePath $exe
} else {
  'Update extract failed' | Out-File (Join-Path $env:TEMP 'twitch-tts-update-error.txt')
}
Start-Sleep -Seconds 2
Remove-Item -LiteralPath $zip -Force
Remove-Item -LiteralPath $extract -Recurse -Force
Remove-Item -LiteralPath $PSCommandPath -Force
`;
  fs.writeFileSync(ps1Path, "\ufeff" + ps, "utf8");
  const vbsPath = path.join(app.getPath("temp"), "twitch-tts-update-launch.vbs");
  const vbs = `Set sh = CreateObject("WScript.Shell")\r\nsh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""${ps1Path.replace(/"/g, "")}""", 0, False\r\nCreateObject("Scripting.FileSystemObject").DeleteFile WScript.ScriptFullName\r\n`;
  fs.writeFileSync(vbsPath, vbs, "utf8");
  return vbsPath;
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
    const vbsPath = writeInstallerScript({
      zipPath,
      extractDir,
      installRoot,
      exeName: app.isPackaged ? exeName : "TwitchChatTTS.exe",
    });
    const child = spawn("wscript.exe", ["//B", "//Nologo", vbsPath], {
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
