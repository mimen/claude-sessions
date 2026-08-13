import Observation

/// What the hosting cmux says it owns.
///
/// Kept apart from the views so the extension can hand it over without them knowing anything about
/// ExtensionKit, which is also what lets the whole list render in a plain command-line harness.
@Observable
@MainActor
public final class HostIdentity {
    public var workspaceIds: Set<String> = []
    public init() {}
}
