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
    static func fetch(ccsPath: String, timeout: TimeInterval = 30) async throws -> UsageSnapshot {
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
        guard FileManager.default.isExecutableFile(atPath: expanded) else {
            throw UsageFetchError.launchFailed("no executable at \(expanded)")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: expanded)
        process.arguments = ["usage", "--json"]
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        let environment = ProcessInfo.processInfo.environment
        var env = environment
        env["PATH"] = "\(environment["HOME"] ?? "")/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:\(environment["PATH"] ?? "")"
        process.environment = env

        do {
            try process.run()
        } catch {
            throw UsageFetchError.launchFailed(error.localizedDescription)
        }

        let deadline = Date().addingTimeInterval(timeout)
        while process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if process.isRunning {
            process.terminate()
            throw UsageFetchError.nonZeroExit(-1, "timed out after \(Int(timeout))s")
        }

        let data = stdout.fileHandleForReading.readDataToEndOfFile()
        guard process.terminationStatus == 0 else {
            let err = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            throw UsageFetchError.nonZeroExit(process.terminationStatus, err)
        }
        return try SnapshotDecoder.decode(data)
    }
}
