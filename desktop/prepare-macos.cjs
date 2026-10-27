"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

if (process.platform === "darwin") {
  try {
    const project = fs.realpathSync(path.join(__dirname, ".."));
    const plist = path.join(
      project,
      "node_modules",
      "electron",
      "dist",
      "Electron.app",
      "Contents",
      "Info.plist",
    );
    if (fs.realpathSync(plist) !== plist) {
      throw new Error(
        "Refusing to modify a symlinked Electron installation. Install Electron directly in this project.",
      );
    }
    const descriptions = {
      NSAudioCaptureUsageDescription:
        "Ghst captures system output audio to transcribe speech with your permission.",
      NSMicrophoneUsageDescription:
        "Ghst uses your selected audio input to transcribe speech with your permission.",
      NSScreenCaptureUsageDescription:
        "Ghst requests screen capture to access system audio through the display media API.",
    };
    const command = (instruction) => {
      const result = spawnSync(
        "/usr/libexec/PlistBuddy",
        ["-c", instruction, plist],
        {
          encoding: "utf8",
          shell: false,
        },
      );
      if (result.error) throw result.error;
      if (result.signal)
        throw new Error(`PlistBuddy stopped with signal ${result.signal}.`);
      return result;
    };
    for (const [key, description] of Object.entries(descriptions)) {
      const existing = command(`Print :${key}`);
      if (existing.status === 0 && existing.stdout.trim() === description)
        continue;
      const instruction =
        existing.status === 0
          ? `Set :${key} ${description}`
          : `Add :${key} string ${description}`;
      const updated = command(instruction);
      if (updated.status !== 0) {
        throw new Error(
          `Cannot set ${key}: ${updated.stderr.trim() || updated.stdout.trim() || "PlistBuddy failed."}`,
        );
      }
    }
    console.log(
      "Prepared permission descriptions in this project's local Electron.app only.",
    );
    console.log(
      "This does not grant recording permission. macOS may attribute a source launch to your terminal or IDE. " +
        "For normal use, build the standalone application and open it from Finder.",
    );
    console.log(
      "The local Electron bundle was modified for development only; reinstalling Electron replaces these changes.",
    );
  } catch (error) {
    console.error(`macOS desktop preparation failed: ${error.message}`);
    console.error(
      "Run npm install in this project to install its local Electron dependency. No system or user application was modified.",
    );
    process.exitCode = 1;
  }
}
