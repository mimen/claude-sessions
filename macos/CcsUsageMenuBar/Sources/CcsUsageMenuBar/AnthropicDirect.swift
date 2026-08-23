import Foundation

struct AnthropicWindow: Decodable {
    let utilization: Double?
    let resets_at: String?
}

struct AnthropicUsage: Decodable {
    let five_hour: AnthropicWindow?
    let seven_day: AnthropicWindow?
    let seven_day_opus: AnthropicWindow?
    let seven_day_sonnet: AnthropicWindow?
    let nimbus_quill: AnthropicWindow?
}

enum Keychain {
    /// cswap stores each account's full Claude OAuth payload in the login
    /// keychain under service "claude-swap", account "account-<n>-<email>".
    static func claudeOauth(account: CswapAccount) -> (token: String, tier: String?)? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-s", "claude-swap",
                             "-a", "account-\(account.number)-\(account.email)", "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        do {
            try process.run()
        } catch {
            return nil
        }
        process.waitUntilExit()
        guard process.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let oauth = json["claudeAiOauth"] as? [String: Any],
              let token = oauth["accessToken"] as? String, !token.isEmpty else {
            return nil
        }
        return (token, oauth["rateLimitTier"] as? String)
    }
}

enum AnthropicDirect {
    static let planByTier: [String: PlanInfo] = [
        "default_claude_max_20x": PlanInfo(name: "Max 20x", dollars: 200),
        "default_claude_max_5x": PlanInfo(name: "Max 5x", dollars: 100),
        "default_claude_pro": PlanInfo(name: "Pro", dollars: 20),
        "claude_max_20x": PlanInfo(name: "Max 20x", dollars: 200),
        "claude_max_5x": PlanInfo(name: "Max 5x", dollars: 100),
        "claude_pro": PlanInfo(name: "Pro", dollars: 20)
    ]

    static func plan(forTier tier: String?) -> PlanInfo? {
        guard let tier else { return nil }
        let lower = tier.lowercased()
        return planByTier[lower]
            ?? (lower.contains("max_20") ? planByTier["claude_max_20x"]
            : lower.contains("max_5") ? planByTier["claude_max_5x"]
            : lower.contains("pro") ? planByTier["claude_pro"] : nil)
    }

    /// Scoped weekly windows, by API codename.
    static let scopedWindows: [(key: String, suffix: String)] = [
        ("nimbus_quill", "#Fable"),
        ("seven_day_opus", "#Opus"),
        ("seven_day_sonnet", "#Sonnet")
    ]

    static func fetchUsage(token: String, timeout: TimeInterval = 20) throws -> AnthropicUsage {
        var request = URLRequest(url: URL(string: "https://api.anthropic.com/api/oauth/usage")!)
        request.httpMethod = "GET"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("oauth-2025-04-20", forHTTPHeaderField: "anthropic-beta")
        request.timeoutInterval = timeout

        let semaphore = DispatchSemaphore(value: 0)
        var result: Result<(Data, URLResponse), Error>?
        URLSession.shared.dataTask(with: request) { data, response, error in
            if let error {
                result = .failure(error)
            } else {
                result = .success((data ?? Data(), response ?? URLResponse()))
            }
            semaphore.signal()
        }.resume()
        semaphore.wait()

        guard case .success(let (data, response))? = result else {
            throw CswapError.failed("no response")
        }
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw CswapError.failed("HTTP \(http.statusCode): \(body.prefix(160))")
        }
        return try JSONDecoder().decode(AnthropicUsage.self, from: data)
    }

    /// Live observations for one account, in the same shape `ccs usage` emits.
    static func observations(email: String, usage: AnthropicUsage) -> [UsageObservation] {
        var out: [UsageObservation] = []
        func add(_ suffix: String, _ window: String?, _ w: AnthropicWindow?) {
            guard let w, let util = w.utilization else { return }
            let resets = w.resets_at.flatMap { SnapshotDecoder.iso8601Fractional.date(from: $0) ?? SnapshotDecoder.iso8601.date(from: $0) }
            out.append(UsageObservation(
                provider: "anthropic",
                entitlement: "claude-max:\(email)\(suffix)",
                metric: "allowance",
                scope: "account",
                window: window,
                used: util,
                limit: 100,
                remaining: 100 - util,
                resetsAt: resets,
                expiresAt: nil,
                exact: true
            ))
        }
        add("", "five_hour", usage.five_hour)
        add("", "weekly", usage.seven_day)
        for (key, suffix) in scopedWindows {
            add(suffix, "weekly", usage[keyPath: dynamic(key)] as? AnthropicWindow)
        }
        return out
    }
}

private func dynamic(_ key: String) -> KeyPath<AnthropicUsage, AnthropicWindow?> {
    switch key {
    case "seven_day_opus": return \.seven_day_opus
    case "seven_day_sonnet": return \.seven_day_sonnet
    default: return \.nimbus_quill
    }
}
