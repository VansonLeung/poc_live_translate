import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  Menu,
  safeStorage,
  session,
  systemPreferences,
} from "electron";
import express from "express";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { createApp } from "../server/app";
import { environmentConfiguration, SettingsStore } from "../server/settings";

app.setName("Live Translate");
if (process.env.LIVE_TRANSLATE_DATA_DIR)
  app.setPath("userData", resolve(process.env.LIVE_TRANSLATE_DATA_DIR));
// Terminal-launched Electron lacks the packaged app's audio capture usage description.
if (process.platform === "darwin" && !app.isPackaged)
  app.commandLine.appendSwitch(
    "disable-features",
    "MacCatapLoopbackAudioForScreenShare",
  );

let window: BrowserWindow | null = null;
let server: Server | undefined;
let origin = "";
const isAppOrigin = (value: string) => {
  try {
    return new URL(value).origin === origin;
  } catch {
    return false;
  }
};

function createWindow() {
  window = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 720,
    minHeight: 580,
    title: "Live Translate",
    backgroundColor: "#f5f7f9",
    show: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppOrigin(url)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => window?.show());
  window.on("closed", () => {
    window = null;
  });
  void window.loadURL(origin);
}

async function start() {
  await app.whenReady();
  const profile = app.getPath("userData");
  const settings = new SettingsStore(environmentConfiguration({}), {
    path: join(profile, "connections.enc"),
    label: "Encrypted desktop profile",
    encode: (value) => {
      if (!safeStorage.isEncryptionAvailable())
        throw new Error(
          "OS credential storage is unavailable. Unlock your account and try again.",
        );
      return safeStorage.encryptString(value);
    },
    decode: (value) => safeStorage.decryptString(value),
  });
  const token = randomBytes(32).toString("hex");
  const api = createApp(settings, fetch, {
    desktop: true,
    token,
    origin: () => origin,
  });
  const dist = join(app.getAppPath(), "dist");
  api.use((_req, res, next) => {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob: data:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    next();
  });
  api.use(express.static(dist));
  api.get("/{*path}", (_req, res) => {
    res.sendFile(join(dist, "index.html"));
  });
  server = await new Promise<Server>((resolveServer, reject) => {
    const listener = api.listen(0, "127.0.0.1", () => resolveServer(listener));
    listener.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start the desktop service.");
  origin = `http://127.0.0.1:${address.port}`;
  const desktopSession = session.defaultSession;
  // The secret stays in the main process and only accompanies requests to this app's server.
  desktopSession.webRequest.onBeforeSendHeaders(
    { urls: [`${origin}/*`] },
    (details, callback) => {
      callback({
        requestHeaders: { ...details.requestHeaders, "X-Desktop-Token": token },
      });
    },
  );
  desktopSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (contents !== window?.webContents || !isAppOrigin(requestingOrigin))
        return false;
      return (
        permission === "display-capture" ||
        permission === "clipboard-sanitized-write" ||
        (permission === "media" && details.mediaType !== "video")
      );
    },
  );
  desktopSession.setPermissionRequestHandler(
    async (contents, permission, callback, details) => {
      if (
        contents !== window?.webContents ||
        !isAppOrigin(details.requestingUrl)
      ) {
        callback(false);
        return;
      }
      if (permission === "media") {
        if (
          "mediaTypes" in details &&
          details.mediaTypes?.some((type) => type !== "audio")
        ) {
          callback(false);
          return;
        }
        if (
          process.platform === "darwin" &&
          !app.commandLine.hasSwitch("use-fake-device-for-media-stream")
        ) {
          callback(await systemPreferences.askForMediaAccess("microphone"));
        } else callback(true);
      } else
        callback(
          permission === "display-capture" ||
            permission === "clipboard-sanitized-write",
        );
    },
  );
  desktopSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (
        !request.frame ||
        request.frame !== window?.webContents.mainFrame ||
        !isAppOrigin(request.securityOrigin)
      ) {
        callback({});
        return;
      }
      try {
        const screens = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
        });
        if (!screens.length || !window) {
          callback({});
          return;
        }
        const choice = await dialog.showMessageBox(window, {
          title: "Share desktop audio",
          message: "Choose a screen to share its system audio.",
          detail: "Only audio is processed. Stop listening to end sharing.",
          buttons: [...screens.map((screen) => screen.name), "Cancel"],
          cancelId: screens.length,
          defaultId: 0,
        });
        if (
          choice.response >= screens.length ||
          !window ||
          request.frame !== window.webContents.mainFrame
        ) {
          callback({});
          return;
        }
        callback({
          video: screens[choice.response],
          audio: request.audioRequested ? "loopback" : undefined,
        });
      } catch {
        callback({});
      }
    },
    { useSystemPicker: true },
  );
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" as const }] : []),
      { role: "fileMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" },
    ]),
  );
  createWindow();
  app.on("activate", () => {
    if (!window) createWindow();
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  void start().catch((error) => {
    dialog.showErrorBox(
      "Live Translate could not start",
      error instanceof Error ? error.message : "Unexpected startup error.",
    );
    app.quit();
  });
}
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", () => {
  server?.closeAllConnections();
  server?.close();
});
