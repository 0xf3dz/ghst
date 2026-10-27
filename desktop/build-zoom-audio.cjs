"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function buildZoomAudio() {
  if (process.platform !== "darwin") return null;
  const architecture = { arm64: "arm64", x64: "x86_64" }[process.arch];
  if (!architecture) throw new Error("Zoom audio capture requires an arm64 or x64 Mac.");
  const source = path.join(__dirname, "zoom-audio.swift");
  const directory = path.join(__dirname, "native");
  const binary = path.join(directory, `zoom-audio-${process.arch}`);
  if (fs.existsSync(binary) && fs.statSync(binary).mtimeMs >= fs.statSync(source).mtimeMs) {
    return binary;
  }
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${binary}.${process.pid}.tmp`;
  try {
    const result = spawnSync("/usr/bin/xcrun", [
      "--sdk", "macosx", "swiftc", "-O", "-swift-version", "5",
      "-target", `${architecture}-apple-macos13.0`,
      "-framework", "AppKit", "-framework", "CoreAudio",
      "-framework", "CoreGraphics", "-framework", "CoreMedia",
      "-framework", "ScreenCaptureKit", source, "-o", temporary,
    ], { encoding: "utf8", shell: false, timeout: 120000, maxBuffer: 1024 * 1024 });
    if (result.error || result.status !== 0) {
      throw new Error(
        "Could not build the Zoom-only audio helper. Install current Xcode Command Line Tools " +
        "(xcode-select --install; macOS 15 SDK or newer required), then relaunch. " +
        (result.error?.message || result.stderr?.trim() || `swiftc exited ${result.status}`),
      );
    }
    fs.chmodSync(temporary, 0o755);
    fs.renameSync(temporary, binary);
    return binary;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { buildZoomAudio };

if (require.main === module) {
  try {
    const binary = buildZoomAudio();
    console.log(binary || "Zoom-only native capture is supported only on macOS.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
