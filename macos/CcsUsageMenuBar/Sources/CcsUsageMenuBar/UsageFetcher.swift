import Foundation

enum CcsLocator {
    static var candidates: [String] {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return [
            "\(home)/.bun/bin/ccs",
            "/opt/homebrew/bin/ccs",
            "/usr/local/bin/ccs",
            "ccs"
        ]
    }

    static func resolve() -> String {
        for candidate in candidates {
            if candidate == "ccs" {
                if whichCCS() != nil { return "ccs" }
            } else if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return "~/.bun/bin/ccs"
    }

    private static func whichCCS() -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/which")
        process.arguments = ["ccs"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
            process.waitUntilExit()
        } catch {
            return nil
        }
        guard process.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
        return (path?.isEmpty == false) ? path : nil
    }
}

enum UsageFetchError: LocalizedError {
    case launchFailed(String)
    case nonZeroExit(Int32, String)

    var errorDescription: String? {
        switch self {
        case .launchFailed(let detail): return "Could not run ccs: \(detail)"
        case .nonZeroExit(let code, let stderr): return "ccs exited \(code): \(stderr)"
        }
    }
}

enum UsageFetcher {
    static func fetch(ccsPath: String, timeout: TimeInterval = 60) async throws -> UsageSnapshot {
        try await withCheckedThrowingContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    let snapshot = try runBlocking(ccsPath: ccsPath, timeout: timeout)
                    continuation.resume(returning: snapshot)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    static func runBlocking(ccsPath: String, timeout: TimeInterval) throws -> UsageSnapshot {
        let expanded = (ccsPath as NSString).expandingTildeInPath
        let environment = ProcessInfo.processInfo.environment
        var env = environment
        // launchd hands the app /usr/bin:/bin; ccs resolves cswap (~/.local/bin),
        // codexbar and op (Homebrew) from PATH, so build the one it needs.
        let home = environment["HOME"] ?? NSHomeDirectory()
        env["PATH"] = "\(home)/.local/bin:\(home)/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(environment["PATH"] ?? "")"

        let result: ProcessRun.Output
        do {
            result = try ProcessRun.collect(executable: expanded, arguments: ["usage", "--json"],
                                            environment: env, timeout: timeout)
        } catch ProcessRun.Failure.launch(let detail) {
            throw UsageFetchError.launchFailed(detail)
        } catch ProcessRun.Failure.timedOut {
            throw UsageFetchError.nonZeroExit(-1, "timed out after \(Int(timeout))s")
        }
        // ccs usage can exit non-zero on partial adapter degradation while still
        // emitting the complete snapshot on stdout — parse whenever we got data.
        guard !result.stdout.isEmpty else {
            throw UsageFetchError.nonZeroExit(result.status, String(data: result.stderr, encoding: .utf8) ?? "")
        }
        return try SnapshotDecoder.decode(result.stdout)
    }
}

/// Runs a child process to completion with a deadline, collecting both pipes
/// through readability handlers. A grandchild that inherits the pipe's write end
/// would keep readDataToEndOfFile blocked on EOF long after the child exits;
/// the handlers stop on the child's exit instead.
enum ProcessRun {
    struct Output {
        let status: Int32
        let stdout: Data
        let stderr: Data
    }

    enum Failure: Error {
        case launch(String)
        case timedOut
    }

    static func collect(executable: String, arguments: [String],
                        environment: [String: String]? = nil, timeout: TimeInterval) throws -> Output {
        guard FileManager.default.isExecutableFile(atPath: executable) else {
            throw Failure.launch("no executable at \(executable)")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        if let environment { process.environment = environment }
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        var outData = Data()
        var errData = Data()
        let queue = DispatchQueue(label: "process-run-pipes")
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; return }
            queue.async { outData.append(chunk) }
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { handle.readabilityHandler = nil; return }
            queue.async { errData.append(chunk) }
        }
        defer {
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
        }

        do {
            try process.run()
        } catch {
            throw Failure.launch(error.localizedDescription)
        }

        // Reap on a side thread so isRunning flips false without leaving a zombie.
        DispatchQueue.global(qos: .default).async {
            process.waitUntilExit()
        }
        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            throw Failure.timedOut
        }
        // Grace period for the handlers to flush trailing chunks.
        Thread.sleep(forTimeInterval: 0.3)
        return queue.sync { Output(status: process.terminationStatus, stdout: outData, stderr: errData) }
    }
}
