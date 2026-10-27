import AppKit
import CoreAudio
import CoreGraphics
import CoreMedia
import Darwin
import ScreenCaptureKit

// Native protocol: UInt32 little-endian payload length, then a one-byte type.
// 1 = Float64 little-endian actual sample rate; 2 = mono Float32 little-endian
// PCM (at most 2048 samples); 3 = UTF-8 error. stdout contains no other text.
// Only SCStreamOutputType.audio is registered: microphone capture is never used.
private let outputLock = NSLock()
private func packet(_ type: UInt8, _ payload: Data) {
    outputLock.lock()
    defer { outputLock.unlock() }
    var length = UInt32(payload.count + 1).littleEndian
    var data = Data(bytes: &length, count: 4)
    data.append(type)
    data.append(payload)
    FileHandle.standardOutput.write(data)
}

private func failure(_ message: String) {
    packet(3, Data(message.utf8.prefix(4096)))
}

private func zoomRoots() -> [NSRunningApplication] {
    NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == "us.zoom.xos" && !$0.isTerminated }
}

private func executablePath(_ pid: pid_t) -> String? {
    var bytes = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    let count = proc_pidpath(pid, &bytes, UInt32(bytes.count))
    return count > 0 ? String(cString: bytes) : nil
}

private enum CaptureError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let message): return message }
    }
}

@available(macOS 13.0, *)
private final class ZoomCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private var refreshTask: Task<Void, Never>?
    private var stopping = false
    private var readyRate: Double?
    private var processIDs: Set<pid_t> = []
    private let audioQueue = DispatchQueue(label: "local.ghst.zoom-audio")

    private func applications(_ content: SCShareableContent) throws -> [SCRunningApplication] {
        let roots = zoomRoots()
        guard !roots.isEmpty else {
            throw CaptureError.message("Zoom is not running. Open the Zoom desktop app, join a meeting using computer audio, then start Zoom audio capture again.")
        }
        let rootIDs = Set(roots.map { $0.processIdentifier })
        let bundles = roots.compactMap { $0.bundleURL?.resolvingSymlinksInPath().path }
        // Include Zoom's real nested helper executables, never similarly named apps
        // or arbitrary applications sharing the 'zoom' name.
        let matches = content.applications.filter { application in
            if rootIDs.contains(application.processID) { return true }
            guard let executable = executablePath(application.processID) else { return false }
            let resolved = URL(fileURLWithPath: executable).resolvingSymlinksInPath().path
            return bundles.contains { resolved.hasPrefix($0 + "/Contents/") }
        }
        guard !matches.isEmpty else {
            throw CaptureError.message("Zoom has no capturable application process. Open its meeting window, select computer audio, and try again.")
        }
        return matches
    }

    func start() async {
        do {
            guard !zoomRoots().isEmpty else {
                throw CaptureError.message("Zoom is not running. Open the Zoom desktop app and join a meeting using computer audio before starting capture.")
            }
            let content: SCShareableContent
            do {
                content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
            } catch {
                throw CaptureError.message("Cannot access macOS screen/system audio capture: \(error.localizedDescription). Enable Ghst in System Settings > Privacy & Security > Screen & System Audio Recording, then restart it. For a source launch, also check your terminal or IDE permission.")
            }
            guard !stopping else { return }
            let apps = try applications(content)
            guard let display = content.displays.first else {
                throw CaptureError.message("No display is available for Zoom audio capture. Connect a display and check Screen & System Audio Recording permission.")
            }
            processIDs = Set(apps.map { $0.processID })
            let filter = SCContentFilter(display: display, including: apps, exceptingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.capturesAudio = true
            configuration.excludesCurrentProcessAudio = true
            configuration.sampleRate = 48000
            configuration.channelCount = 1
            if #available(macOS 15.0, *) { configuration.captureMicrophone = false }
            // ScreenCaptureKit needs a display filter, but no screen output is
            // registered or sent to Electron. Minimize unused video processing.
            configuration.width = 2
            configuration.height = 2
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            configuration.showsCursor = false
            let capture = SCStream(filter: filter, configuration: configuration, delegate: self)
            stream = capture
            try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
            try await capture.startCapture()
            guard !stopping else { return }
            refreshTask = Task { @MainActor in
                while !Task.isCancelled {
                    do {
                        try await Task.sleep(nanoseconds: 2_000_000_000)
                        guard !Task.isCancelled, !self.stopping else { return }
                        let current = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false)
                        let apps = try self.applications(current)
                        let ids = Set(apps.map { $0.processID })
                        if ids != self.processIDs {
                            guard let display = current.displays.first else {
                                throw CaptureError.message("The display used for Zoom audio capture disconnected. Reconnect it and restart capture.")
                            }
                            try await capture.updateContentFilter(SCContentFilter(display: display, including: apps, exceptingWindows: []))
                            self.processIDs = ids
                        }
                    } catch is CancellationError {
                        return
                    } catch {
                        await self.stop(error: "Zoom audio capture stopped: \(error.localizedDescription)")
                        return
                    }
                }
            }
        } catch {
            await stop(error: "Zoom audio capture could not start: \(error.localizedDescription). Check Screen & System Audio Recording permission; no microphone or all-system fallback was started.")
        }
    }

    @MainActor func stop(error: String? = nil) async {
        guard !stopping else { return }
        stopping = true
        refreshTask?.cancel()
        if let error { failure(error) }
        if let stream { try? await stream.stopCapture() }
        exit(error == nil ? 0 : 1)
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Task { @MainActor in
            await self.stop(error: "Zoom audio capture ended: \(error.localizedDescription). Check recording permission and restart capture.")
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer),
              let description = CMSampleBufferGetFormatDescription(sampleBuffer),
              let format = CMAudioFormatDescriptionGetStreamBasicDescription(description) else { return }
        let asbd = format.pointee
        let channels = Int(asbd.mChannelsPerFrame)
        let frames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frames > 0 else { return }
        guard asbd.mFormatID == kAudioFormatLinearPCM,
              asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0,
              asbd.mFormatFlags & kAudioFormatFlagIsBigEndian == 0,
              asbd.mBitsPerChannel == 32,
              channels > 0, channels <= 8,
              frames <= 65536,
              asbd.mSampleRate.isFinite, (8000...192000).contains(asbd.mSampleRate) else {
            Task { @MainActor in await self.stop(error: "Zoom supplied an unsupported audio format. Restart capture or use an explicit Zoom-only virtual input.") }
            return
        }
        let list = AudioBufferList.allocate(maximumBuffers: channels)
        defer { free(list.unsafeMutablePointer) }
        var retained: CMBlockBuffer?
        let result = CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer, bufferListSizeNeededOut: nil,
            bufferListOut: list.unsafeMutablePointer,
            bufferListSize: MemoryLayout<AudioBufferList>.size + (channels - 1) * MemoryLayout<AudioBuffer>.stride,
            blockBufferAllocator: kCFAllocatorDefault, blockBufferMemoryAllocator: kCFAllocatorDefault,
            flags: UInt32(kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment), blockBufferOut: &retained)
        guard result == noErr else {
            Task { @MainActor in await self.stop(error: "macOS could not read Zoom audio samples. Stop and restart capture.") }
            return
        }
        // Retain CoreMedia's storage until every sample has been copied.
        withExtendedLifetime(retained) {
            guard list.reduce(0, { $0 + Int($1.mNumberChannels) }) == channels,
                  list.allSatisfy({ $0.mData != nil && Int($0.mDataByteSize) >= frames * Int($0.mNumberChannels) * 4 }) else {
                Task { @MainActor in await self.stop(error: "macOS returned an invalid Zoom audio buffer. Restart capture.") }
                return
            }
            if let rate = readyRate, rate != asbd.mSampleRate {
                Task { @MainActor in await self.stop(error: "Zoom audio's sample rate changed. Restart capture to use the new audio device.") }
                return
            }
            if readyRate == nil {
                readyRate = asbd.mSampleRate
                var bits = asbd.mSampleRate.bitPattern.littleEndian
                packet(1, Data(bytes: &bits, count: 8))
            }
            for start in stride(from: 0, to: frames, by: 2048) {
                let count = min(2048, frames - start)
                var mono = [Float](repeating: 0, count: count)
                for buffer in list {
                    let data = buffer.mData!.assumingMemoryBound(to: Float.self)
                    let width = Int(buffer.mNumberChannels)
                    for frame in 0..<count {
                        for channel in 0..<width {
                            mono[frame] += data[(start + frame) * width + channel] / Float(channels)
                        }
                    }
                }
                guard mono.allSatisfy({ $0.isFinite }) else {
                    Task { @MainActor in await self.stop(error: "Zoom returned invalid audio samples. Restart capture.") }
                    return
                }
                mono.withUnsafeBytes { packet(2, Data($0)) }
            }
        }
    }
}

if CommandLine.arguments.dropFirst().contains("--check") {
    let roots = zoomRoots()
    let report: [String: Any] = [
        "supported": ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 13, minorVersion: 0, patchVersion: 0)),
        "zoomRunning": !roots.isEmpty,
        "zoomProcesses": roots.map { ["pid": $0.processIdentifier, "bundleIdentifier": $0.bundleIdentifier ?? ""] as [String: Any] },
        "screenCapturePermission": CGPreflightScreenCaptureAccess(),
        "microphoneCapture": false
    ]
    if let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([10]))
    }
    exit(0)
}

signal(SIGPIPE, SIG_IGN)
if #available(macOS 13.0, *) {
    let capture = ZoomCapture()
    // stdin belongs to Electron. EOF means its window or parent process exited.
    FileHandle.standardInput.readabilityHandler = { input in
        _ = input.availableData
        input.readabilityHandler = nil
        Task { @MainActor in await capture.stop() }
    }
    signal(SIGTERM, SIG_IGN)
    signal(SIGINT, SIG_IGN)
    let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
    let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
    terminate.setEventHandler { Task { @MainActor in await capture.stop() } }
    interrupt.setEventHandler { Task { @MainActor in await capture.stop() } }
    terminate.resume()
    interrupt.resume()
    Task { @MainActor in await capture.start() }
    withExtendedLifetime((capture, terminate, interrupt)) { dispatchMain() }
} else {
    failure("Zoom-only native audio requires macOS 13 or later. Use an explicit Zoom-only virtual audio input on this system.")
    exit(1)
}
