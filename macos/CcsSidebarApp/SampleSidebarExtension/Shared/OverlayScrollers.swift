import AppKit
import SwiftUI

/// Forces the enclosing scroll view to use overlay scrollers.
///
/// A legacy scroller reserves a track down the edge and takes that width out of the content, which
/// in a sidebar is width the titles wanted. Overlay scrollers draw a thin knob above the content
/// and fade out when idle, so nothing is reserved and there is no bar to look at.
///
/// SwiftUI has no modifier for this — `scrollIndicators` can only hide them entirely — so the
/// underlying `NSScrollView` is reached through a zero-sized companion view. It is set once the
/// view is in a window, because before that there is no scroll view above it to find.
struct OverlayScrollers: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let probe = NSView(frame: .zero)
        DispatchQueue.main.async { apply(from: probe) }
        return probe
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async { apply(from: nsView) }
    }

    private func apply(from view: NSView) {
        var candidate: NSView? = view.superview
        while let current = candidate, !(current is NSScrollView) { candidate = current.superview }
        guard let scrollView = candidate as? NSScrollView else { return }
        scrollView.scrollerStyle = .overlay
        scrollView.autohidesScrollers = true
        scrollView.verticalScroller?.controlSize = .mini
        scrollView.horizontalScroller?.controlSize = .mini
        scrollView.scrollerInsets = .init(top: 0, left: 0, bottom: 0, right: 0)
    }
}
