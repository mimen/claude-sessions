import Foundation

struct CswapAccount: Identifiable, Equatable {
    let number: Int
    let email: String
    let alias: String?
    let isActive: Bool

    var id: Int { number }
    var displayName: String { alias ?? String(email.split(separator: "@").first ?? "") }
}

enum CswapError: LocalizedError {
    case failed(String)

    var errorDescription: String? {
        switch self {
        case .failed(let detail): return "cswap: \(detail)"
        }
    }
}

/// Thin wrapper around the cswap CLI — it owns Claude Code credential handling
/// (macOS Keychain + ~/.claude.json); the menubar only asks it to list and switch.
enum Cswap {
    static let executable = "\(NSHomeDirectory())/.local/bin/cswap"

    static func isAvailable() -> Bool {
        FileManager.default.isExecutableFile(atPath: executable)
    }

    static func run(_ args: [String], timeout: TimeInterval = 20) throws -> Data {
        guard isAvailable() else {
            throw CswapError.failed("no executable at \(executable)")
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = args
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        try process.run()
        let group = DispatchGroup()
        var outData = Data()
        var errData = Data()
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            outData = stdout.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        group.enter()
        DispatchQueue.global(qos: .userInitiated).async {
            errData = stderr.fileHandleForReading.readDataToEndOfFile()
            group.leave()
        }
        if group.wait(timeout: .now() + timeout) == .timedOut {
            if process.isRunning { process.terminate() }
            throw CswapError.failed("timed out")
        }
        process.waitUntilExit()

        // Degraded usage fetches can exit non-zero while still emitting output —
        // judge by stdout content, not exit status.
        guard !outData.isEmpty else {
            throw CswapError.failed(String(data: errData, encoding: .utf8) ?? "unknown error")
        }
        return outData
    }

    static func accounts() throws -> [CswapAccount] {
        struct RawAccount: Decodable {
            let number: Int
            let email: String?
            let alias: String?
            let active: Bool?
        }
        struct RawList: Decodable {
            let activeAccountNumber: Int?
            let accounts: [RawAccount]
        }
        let raw = try run(["list", "--json"])
        let list = try JSONDecoder().decode(RawList.self, from: raw)
        return list.accounts.map {
            CswapAccount(
                number: $0.number,
                email: $0.email ?? "?",
                alias: $0.alias,
                isActive: $0.active ?? ($0.number == list.activeAccountNumber)
            )
        }
    }

    /// Rotates the global Claude Code credentials to the given account.
    static func switchTo(_ account: CswapAccount) throws {
        _ = try run(["switch", String(account.number)], timeout: 60)
    }
}
