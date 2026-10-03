import Foundation

/// Tells the hub which ccs build this Mac's menu bar runs: POST /ingest/build, once per launch,
/// on a background session with a short timeout. Any failure, including a hub without the
/// route, is dropped.
enum BuildReport {
    static let site = URL(string: "https://usable-gopher-567.convex.site/ingest/build")!

    /// make-app.sh writes the checkout's HEAD into Info.plist as CcsGitSHA.
    static var sha: String? { Bundle.main.object(forInfoDictionaryKey: "CcsGitSHA") as? String }

    static func request(home: String = NSHomeDirectory(),
                        environment: [String: String] = ProcessInfo.processInfo.environment,
                        sha: String?) -> URLRequest? {
        guard let sha, sha.count == 40,
              let host = environment["HUB_HOST"] ?? fleetHost(home: home),
              let token = ingestToken(home: home, environment: environment) else { return nil }
        var request = URLRequest(url: site, timeoutInterval: 3)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try? JSONSerialization.data(withJSONObject: [
            "host": host, "component": "ccs", "sha": sha,
            "reportedAt": Int(Date().timeIntervalSince1970 * 1000),
        ])
        return request
    }

    static func send() {
        guard let request = request(sha: sha) else { return }
        URLSession.shared.dataTask(with: request) { _, response, error in
            let outcome = (response as? HTTPURLResponse).map { "HTTP \($0.statusCode)" } ?? error?.localizedDescription ?? "no response"
            Task { @MainActor in UsageStore.log("build report \(outcome)") }
        }.resume()
    }

    /// The token file ccs's install writes, then the environment. No `op` here: under launchd it stalls.
    static func ingestToken(home: String, environment: [String: String]) -> String? {
        let file = try? String(contentsOfFile: home + "/.config/ccs/hub-ingest-token", encoding: .utf8)
        let token = file?.trimmingCharacters(in: .whitespacesAndNewlines)
        if let token, !token.isEmpty { return token }
        return environment["HUB_INGEST_TOKEN"].flatMap { $0.isEmpty ? nil : $0 }
    }

    static func fleetHost(home: String) -> String? {
        let url = URL(fileURLWithPath: home + "/Library/LaunchAgents/com.milad.fleet-check.plist")
        guard let data = try? Data(contentsOf: url),
              let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any],
              let env = plist["EnvironmentVariables"] as? [String: Any] else { return nil }
        return env["HUB_HOST"] as? String
    }
}
