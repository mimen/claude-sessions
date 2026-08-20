import Foundation
import Observation

/// What the panel currently believes about hover, printed in the footer.
///
/// Hover here is assembled from two event sources inside a remote view that drops some of them, so
/// "the buttons did not appear" has several possible causes that look identical on screen. This
/// separates them: the counters say whether events arrived at all, and `hovered` says what the list
/// concluded. Hovering a row that misbehaves and reading the footer answers, without guessing:
///
///   - nothing moves            -> no event reached the row; the pointer never registered
///   - `in` climbs, hovered `—` -> the row was entered and something cleared it again
///   - hovered names the row    -> hover is correct and the controls are failing to draw
@Observable
@MainActor
public final class HoverProbe {
    /// The row the list is currently treating as hovered.
    public var hovered: String?
    /// Tracking-area entries, tracking-area exits, and SwiftUI hover phases, since launch.
    public private(set) var entered = 0
    public private(set) var exited = 0
    public private(set) var phased = 0

    public init() {}

    public func noteEntered() { entered += 1 }
    public func noteExited() { exited += 1 }
    public func notePhase() { phased += 1 }

    /// Short enough for the footer of a 360pt panel.
    public var line: String {
        let name = hovered.map { String($0.prefix(16)) } ?? "—"
        return "hover \(name) · in \(entered) out \(exited) ph \(phased)"
    }
}
