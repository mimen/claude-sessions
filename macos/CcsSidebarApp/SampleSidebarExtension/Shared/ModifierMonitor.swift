import AppKit
import Observation

/// Whether Command is held right now, so rows can reveal their jump shortcuts.
///
/// Polls `NSEvent.modifierFlags`, which reports the current hardware state, rather than watching
/// for `.flagsChanged`. A local event monitor only sees events delivered to this process while it
/// has key focus: press Command over the sidebar, release it over the terminal, and the release
/// never arrives, so the badges latch on and stay on. Reading the state cannot get stuck, because
/// it never depends on having observed the transition.
///
/// A local monitor still runs alongside it, so the badges appear on the keystroke rather than up
/// to a poll later while the sidebar does have focus.
@Observable
@MainActor
public final class ModifierMonitor {
    public private(set) var commandHeld = false

    private var monitor: Any?
    private var poll: Task<Void, Never>?

    public init() {}

    public func start() {
        guard poll == nil else { return }
        monitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
            self?.apply(event.modifierFlags)
            return event
        }
        poll = Task { [weak self] in
            while !Task.isCancelled {
                self?.apply(NSEvent.modifierFlags)
                try? await Task.sleep(for: .milliseconds(90))
            }
        }
    }

    public func stop() {
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        poll?.cancel()
        poll = nil
        commandHeld = false
    }

    /// Assigned only on a change, so an unchanged poll does not invalidate every row nine times a
    /// second.
    private func apply(_ flags: NSEvent.ModifierFlags) {
        let held = flags.contains(.command)
        if held != commandHeld { commandHeld = held }
    }
}
