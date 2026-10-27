"use strict";

const { contextBridge, ipcRenderer } = require("electron");

function setBoolean(channel, value) {
  if (typeof value !== "boolean") {
    return Promise.reject(
      new TypeError("The desktop setting must be a boolean."),
    );
  }
  return ipcRenderer.invoke(channel, value);
}

function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("Audio callback must be a function.");
  const handler = (_event, value) => callback(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}
contextBridge.exposeInMainWorld(
  "desktop",
  Object.freeze({
    isDesktop: true,
    startZoomAudio: () => ipcRenderer.invoke("desktop:start-zoom-audio"),
    stopZoomAudio: () => ipcRenderer.invoke("desktop:stop-zoom-audio"),
    onZoomAudio: (callback) => subscribe("desktop:zoom-audio", callback),
    onZoomAudioError: (callback) => subscribe("desktop:zoom-audio-error", callback),
    setCompact: (enabled) => setBoolean("desktop:set-compact", enabled),
    setAlwaysOnTop: (enabled) =>
      setBoolean("desktop:set-always-on-top", enabled),
  }),
);
