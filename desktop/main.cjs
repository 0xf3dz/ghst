"use strict";

const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ZoomAudio } = require("./zoom-audio.cjs");
const {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  screen,
  session,
  systemPreferences,
} = require("electron");

app.setName("Ghst");
let mainWindow = null;
let localServer = null;
let localOrigin = null;
let quitting = false;
let shutdownComplete = false;
let capturePending = false;
let startup;
const zoomAudio = new ZoomAudio((channel, value) => {
  if (mainWindow && !mainWindow.isDestroyed() && isTrustedContents(mainWindow.webContents))
    mainWindow.webContents.send(channel, value);
});

function isLocalURL(value) {
  try {
    const url = new URL(value);
    return url.origin === localOrigin && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isTrustedContents(contents) {
  return (
    mainWindow &&
    !mainWindow.isDestroyed() &&
    contents === mainWindow.webContents &&
    !contents.isDestroyed() &&
    isLocalURL(contents.getURL())
  );
}

function isTrustedFrame(frame) {
  return (
    frame &&
    mainWindow &&
    !mainWindow.isDestroyed() &&
    frame === mainWindow.webContents.mainFrame &&
    isLocalURL(frame.url)
  );
}

function requireTrustedBoolean(event, value) {
  if (
    quitting ||
    !isTrustedContents(event.sender) ||
    !isTrustedFrame(event.senderFrame)
  ) {
    throw new Error(
      "Desktop controls are available only to the local application.",
    );
  }
  if (typeof value !== "boolean")
    throw new TypeError("The desktop setting must be a boolean.");
  return mainWindow;
}

function installWindowControls() {
  ipcMain.handle("desktop:start-zoom-audio", (event) => {
    requireTrustedBoolean(event, true);
    return zoomAudio.start();
  });
  ipcMain.handle("desktop:stop-zoom-audio", (event) => {
    requireTrustedBoolean(event, true);
    return zoomAudio.stop();
  });
  ipcMain.handle("desktop:set-compact", (event, compact) => {
    const win = requireTrustedBoolean(event, compact);
    if (win.isFullScreen())
      throw new Error("Exit full screen before changing the window size.");
    if (win.isMaximized()) win.unmaximize();
    win.setSize(compact ? 520 : 1280, compact ? 760 : 860);
    return compact;
  });
  ipcMain.handle("desktop:set-always-on-top", (event, enabled) => {
    const win = requireTrustedBoolean(event, enabled);
    win.setAlwaysOnTop(enabled);
    return win.isAlwaysOnTop();
  });
}

function capturePlatformError() {
  if (process.platform === "darwin") {
    const [major, minor] = process.getSystemVersion().split(".").map(Number);
    if (major < 14 || (major === 14 && minor < 2)) {
      return (
        "Native system audio capture in this application requires macOS 14.2 or later. " +
        "Use a virtual loopback audio input with microphone mode on older macOS versions."
      );
    }
    const access = systemPreferences.getMediaAccessStatus("screen");
    if (access === "denied" || access === "restricted") {
      return (
        "Screen recording is not permitted. Enable this app in System Settings > Privacy & Security " +
        "> Screen & System Audio Recording, then restart it. When launched from a terminal or IDE, " +
        "check permission for that application too."
      );
    }
    return null;
  }
  if (process.platform !== "win32") {
    return (
      "Native system audio loopback is not supported by this launcher on this platform. " +
      "Select a virtual loopback or monitor audio input in microphone mode instead."
    );
  }
  return null;
}

function installCaptureHandler(desktopSession) {
  desktopSession.setDisplayMediaRequestHandler(
    async (request, callback) => {
      if (
        quitting ||
        capturePending ||
        !request.userGesture ||
        !request.audioRequested ||
        !request.videoRequested ||
        !isLocalURL(request.securityOrigin) ||
        !isTrustedFrame(request.frame)
      ) {
        callback(null);
        return;
      }

      capturePending = true;
      let streams = null;
      try {
        const unsupported = capturePlatformError();
        if (unsupported) throw new Error(unsupported);
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false,
        });
        if (!sources.length)
          throw new Error(
            "No screen source is available. Check screen recording permission and try again.",
          );
        if (quitting || !isTrustedFrame(request.frame)) return;
        const primaryId = String(screen.getPrimaryDisplay().id);
        const source =
          sources.find((item) => item.display_id === primaryId) || sources[0];
        const macPermission =
          process.platform === "darwin"
            ? "\n\nmacOS also requires System Audio Recording permission and NSAudioCaptureUsageDescription " +
              "in the responsible application Info.plist. For an unpackaged launch, this can be your terminal " +
              "or IDE. An audio track alone does not prove that audio samples are available."
            : "";
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: "question",
          title: "Capture system audio",
          message: "Allow system audio and screen capture?",
          detail:
            `Source: ${source.name}. This captures all system output audio, including Zoom and other apps, ` +
            "not Zoom alone. The browser API also supplies screen video. The application uses the audio " +
            "for transcription. Share only content that you have permission to record." +
            macPermission,
          buttons: ["Cancel", "Start capture"],
          defaultId: 0,
          cancelId: 0,
          noLink: true,
        });
        if (response === 1 && !quitting && isTrustedFrame(request.frame)) {
          streams = { video: source, audio: "loopback" };
        }
      } catch (error) {
        if (!quitting) {
          dialog.showErrorBox(
            "System audio capture unavailable",
            `${error.message}\n\nNo capture was started. Check recording permissions and try again. ` +
              "If native capture remains unavailable, use a virtual loopback audio input in microphone mode.",
          );
        }
      } finally {
        capturePending = false;
        callback(streams);
      }
    },
    { useSystemPicker: false },
  );
}

function installPermissions(desktopSession) {
  desktopSession.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) => {
      if (
        !isTrustedContents(contents) ||
        !isLocalURL(requestingOrigin) ||
        !details.isMainFrame ||
        (details.requestingUrl && !isLocalURL(details.requestingUrl))
      )
        return false;
      if (permission === "display-capture") return true;
      return permission === "media" && details.mediaType === "audio";
    },
  );

  desktopSession.setPermissionRequestHandler(
    async (contents, permission, callback, details) => {
      if (
        quitting ||
        !isTrustedContents(contents) ||
        !details.isMainFrame ||
        !isLocalURL(details.requestingUrl)
      ) {
        callback(false);
        return;
      }
      if (permission === "display-capture") {
        callback(true);
        return;
      }
      if (
        permission !== "media" ||
        !details.mediaTypes?.length ||
        !details.mediaTypes.every((type) => type === "audio")
      ) {
        callback(false);
        return;
      }
      try {
        let allowed = true;
        if (process.platform === "darwin") {
          const access = systemPreferences.getMediaAccessStatus("microphone");
          allowed =
            access === "granted" ||
            (access === "not-determined" &&
              (await systemPreferences.askForMediaAccess("microphone")));
          if (!allowed && !quitting) {
            dialog.showErrorBox(
              "Microphone access unavailable",
              "Enable microphone access in System Settings > Privacy & Security > Microphone, " +
                "then restart the app. A packaged app must include NSMicrophoneUsageDescription.",
            );
          }
        }
        callback(Boolean(allowed && !quitting && isTrustedContents(contents)));
      } catch (error) {
        if (!quitting)
          dialog.showErrorBox("Microphone access unavailable", error.message);
        callback(false);
      }
    },
  );
}

async function launch() {
  const { startServer } = await import(
    pathToFileURL(path.join(__dirname, "..", "server.js")).href
  );
  const result = await startServer({ port: 0 });
  localServer = result.server;
  const url = new URL(result.url);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password
  ) {
    throw new Error(
      "The local server must provide an HTTP URL bound to 127.0.0.1 on its assigned port.",
    );
  }
  localOrigin = url.origin;
  if (quitting) return;

  localServer.on("error", (error) => {
    if (!quitting) {
      dialog.showErrorBox("Local server error", error.message);
      app.quit();
    }
  });
  const desktopSession = session.fromPartition("thesis-desktop");
  installPermissions(desktopSession);
  installCaptureHandler(desktopSession);
  installWindowControls();

  mainWindow = new BrowserWindow({
    title: "Ghst",
    width: 1280,
    height: 860,
    minWidth: 460,
    minHeight: 600,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      session: desktopSession,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    },
  });
  const contents = mainWindow.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  const restrictNavigation = (event) => {
    if (!event.isMainFrame || !isLocalURL(event.url)) event.preventDefault();
  };
  contents.on("will-navigate", restrictNavigation);
  contents.on("will-frame-navigate", restrictNavigation);
  contents.on("will-redirect", restrictNavigation);
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("content-bounds-updated", (event) => event.preventDefault());
  contents.on("render-process-gone", (_event, details) => {
    if (!quitting) {
      dialog.showErrorBox(
        "Application window stopped",
        `The renderer stopped (${details.reason}). Restart the application.`,
      );
      app.quit();
    }
  });
  mainWindow.on("closed", () => {
    void zoomAudio.stop();
    mainWindow = null;
  });
  await mainWindow.loadURL(url.href);
  if (!quitting && mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

async function closeServer() {
  if (!localServer?.listening) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => localServer.closeAllConnections(), 5000);
    localServer.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    localServer.closeIdleConnections();
  });
}

app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void (async () => {
    await startup;
    await zoomAudio.stop();
    try {
      await closeServer();
    } catch (error) {
      dialog.showErrorBox("Local server shutdown failed", error.message);
    } finally {
      shutdownComplete = true;
      app.quit();
    }
  })();
});
app.on("window-all-closed", () => app.quit());
process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());

startup = app
  .whenReady()
  .then(launch)
  .catch((error) => {
    if (!quitting) dialog.showErrorBox("Ghst could not start", error.message);
    app.quit();
  });
