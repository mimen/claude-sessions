import Foundation

/// Finds the CCS server that describes the cmux hosting this extension.
///
/// There is one server per cmux, because each is bound to one cmux socket, and more than one cmux
/// can be running — a released build and a fork, say. A hardcoded port therefore shows whichever
/// cmux that server was bound to, not the one whose sidebar you are looking at, which is how this
/// extension came to report another window's sessions.
///
/// Nothing in the extension API names the host, so identity is established by agreement instead:
/// cmux tells the extension which workspaces it has, each candidate server says which workspaces
/// it can see, and the server that recognises the host's workspaces is the host's server. That
/// needs no configuration and cannot be wrong in the way a written-down port can.
public enum ServerLocator {
    /// Ports to consider, most likely first. Cheap to probe and stable across restarts.
    public static let candidates = [8788, 8787]

    public static func locate(hostWorkspaceIds: Set<String>) async -> Int? {
        guard !hostWorkspaceIds.isEmpty else { return nil }
        for port in candidates {
            guard let ids = await workspaceIds(port: port) else { continue }
            if !ids.isDisjoint(with: hostWorkspaceIds) { return port }
        }
        return nil
    }

    private static func workspaceIds(port: Int) async -> Set<String>? {
        guard let url = URL(string: "http://127.0.0.1:\(port)/api/snapshot?limit=200") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, _) = try? await URLSession.shared.data(for: request),
              let snapshot = try? JSONDecoder().decode(SidebarSnapshot.self, from: data)
        else { return nil }
        // Compared case-insensitively: cmux hands out UUIDs and the two sides do not agree on case.
        return Set(snapshot.rows.compactMap { $0.workspaceId?.uppercased() })
    }
}
