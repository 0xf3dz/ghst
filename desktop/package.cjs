"use strict";

const path = require("node:path");

(async () => {
  if (process.arch !== "arm64" && process.arch !== "x64") {
    throw new Error(
      "macOS packaging requires an arm64 or x64 host architecture.",
    );
  }
  require("./build-zoom-audio.cjs").buildZoomAudio();
  const { packager } = await import("@electron/packager");
  const project = path.join(__dirname, "..");
  const applications = await packager({
    dir: project,
    out: path.join(project, "dist"),
    name: "Ghst",
    executableName: "Ghst",
    appBundleId: "local.ghst.desktop",
    platform: "darwin",
    arch: process.arch,
    prune: true,
    overwrite: true,
    asar: false,
    extendInfo: {
      NSAudioCaptureUsageDescription:
        "Ghst captures system output audio to transcribe speech with your permission.",
      NSMicrophoneUsageDescription:
        "Ghst uses your selected audio input to transcribe speech with your permission.",
      NSScreenCaptureUsageDescription:
        "Ghst requests screen capture to access system audio through the display media API.",
    },
    ignore: [
      /^\/(?!package\.json$|server\.js$|lib(?:\/|$)|public(?:\/|$)|desktop(?:\/|$)|node_modules(?:\/|$)|LICENSE(?:\.[^/]*)?$|NOTICE(?:\.[^/]*)?$)/,
      /^\/desktop\/(?:package|prepare-macos)\.cjs$/,
      /\.test\.js$/,
    ],
  });
  for (const directory of applications) {
    console.log(
      `Created local macOS application: ${path.join(directory, "Ghst.app")}`,
    );
  }
  console.log(
    "Open Ghst.app from Finder and grant screen/system audio or microphone access when requested.",
  );
  console.log(
    "This build has no Developer ID signing or notarization and is intended for local use, not public distribution.",
  );
})().catch((error) => {
  console.error(`macOS packaging failed: ${error.message}`);
  process.exitCode = 1;
});
