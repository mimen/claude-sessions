import Foundation

/// What a row can ask for, as closures rather than a client reference.
///
/// The views take this instead of an `ActionClient` so they can be rendered headlessly with the
/// handlers stubbed out. A view that reaches for the network on its own cannot be drawn to a PNG,
/// and the render harness is the only fast way to look at any of this.
@MainActor
public struct RowActions {
    public var open: (SidebarRow) -> Void
    public var lifecycle: (SidebarRow, String) -> Void
    public var declineSuggestion: (SidebarRow) -> Void
    public var pin: (SidebarRow, Bool) -> Void
    public var closeTab: (SidebarRow) -> Void
    public var setIncognito: (SidebarRow, Bool) -> Void
    public var destroy: (SidebarRow) -> Void
    public var copySummary: (SidebarRow) -> Void

    public init(
        open: @escaping (SidebarRow) -> Void = { _ in },
        lifecycle: @escaping (SidebarRow, String) -> Void = { _, _ in },
        declineSuggestion: @escaping (SidebarRow) -> Void = { _ in },
        pin: @escaping (SidebarRow, Bool) -> Void = { _, _ in },
        closeTab: @escaping (SidebarRow) -> Void = { _ in },
        setIncognito: @escaping (SidebarRow, Bool) -> Void = { _, _ in },
        destroy: @escaping (SidebarRow) -> Void = { _ in },
        copySummary: @escaping (SidebarRow) -> Void = { _ in }
    ) {
        self.open = open
        self.lifecycle = lifecycle
        self.declineSuggestion = declineSuggestion
        self.pin = pin
        self.closeTab = closeTab
        self.setIncognito = setIncognito
        self.destroy = destroy
        self.copySummary = copySummary
    }
}

public extension SidebarRow {
    var isSaved: Bool { lifecycle == "saved" }
    var isCompleted: Bool { lifecycle == "completed" }
    var isJunk: Bool { summary?.junk == true }
    /// Only a row cmux actually has a tab for can have that tab closed.
    var hasTab: Bool { workspaceRef != nil }
}
