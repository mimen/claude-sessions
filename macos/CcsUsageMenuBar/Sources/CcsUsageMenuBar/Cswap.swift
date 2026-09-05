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
        let result: ProcessRun.Output
        do {
            result = try ProcessRun.collect(executable: executable, arguments: args, timeout: timeout)
        } catch ProcessRun.Failure.launch(let detail) {
            throw CswapError.failed(detail)
        } catch ProcessRun.Failure.timedOut {
            throw CswapError.failed("timed out after \(Int(timeout))s")
        }
        // Degraded fetches can exit non-zero while still emitting output —
        // judge by stdout content, not exit status.
        guard !result.stdout.isEmpty else {
            throw CswapError.failed(String(data: result.stderr, encoding: .utf8) ?? "unknown error")
        }
        return result.stdout
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
