import AppKit
import Observation

/// Whether Command is held, so rows can reveal their jump shortcuts.
///
/// A local event monitor rather than key-press handling: the badges must appear while the sidebar
/// has focus and the key is merely held, before any key is pressed. The monitor is removed on stop,
/// because one left registered keeps firing after the view is gone.
@Observable
@MainActor
public final class ModifierMonitor {
    public private(set) var commandHeld = false

    private var monitor: Any?

    public init() {}

    public func start() {
        guard monitor == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.commandHeld = event.modifierFlags.contains(.command)
            return event
        }
    }

    public func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        commandHeld = false
    }
}
