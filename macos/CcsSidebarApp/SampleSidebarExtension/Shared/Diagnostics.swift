import Foundation

/// A line of evidence from inside the extension, written where it can be read from outside.
///
/// An appex has no console anyone watches and cannot be attached to easily, so a question like
/// "does cmux actually hand this extension its workspaces" is otherwise answered by guessing. The
/// file lives in the extension's own sandbox container, which it can always write to.
public enum Diagnostics {
    private static let queue = DispatchQueue(label: "ccs.sidebar.diagnostics")

    public static var path: URL? {
        FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)
            .first?
            .appendingPathComponent("ccs-sidebar.log")
    }

    public static func note(_ message: String) {
        guard let path else { return }
        let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
        queue.async {
            if let handle = try? FileHandle(forWritingTo: path) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: Data(line.utf8))
            } else {
                try? line.data(using: .utf8)?.write(to: path)
            }
        }
    }
}
