import SwiftUI

/// The row's context menu: the verdict first, then lifecycle, then the session itself.
///
/// Ordered by how often it is the reason for the right-click. An enrichment verdict is a question
/// the row is asking, so accepting or refusing it sits above the commands that are always there,
/// and the irreversible one sits alone at the bottom behind its own role.
struct RowContextMenu: View {
    let row: SidebarRow
    let actions: RowActions

    var body: some View {
        if let suggestion = row.suggestion {
            Section(suggestion.verb.capitalized + " suggested") {
                if suggestion.actionable {
                    Button {
                        actions.lifecycle(row, "complete")
                    } label: {
                        Label("Mark done", systemImage: "checkmark")
                    }
                }
                Button {
                    actions.declineSuggestion(row)
                } label: {
                    Label("Dismiss verdict", systemImage: "xmark")
                }
            }
        }

        Section("Lifecycle") {
            if !row.isCompleted {
                Button {
                    actions.lifecycle(row, row.isSaved ? "unsave" : "save")
                } label: {
                    Label(row.isSaved ? "Move to Active" : "Save for later", systemImage: "bookmark")
                }
                Button {
                    actions.lifecycle(row, "complete")
                } label: {
                    Label("Mark done", systemImage: "checkmark")
                }
            } else {
                Button {
                    actions.lifecycle(row, "uncomplete")
                } label: {
                    Label("Reopen", systemImage: "arrow.uturn.backward")
                }
            }
            Button {
                actions.pin(row, !row.pinned)
            } label: {
                Label(row.pinned ? "Unpin" : "Pin to top", systemImage: row.pinned ? "pin.slash" : "pin")
            }
            .disabled(row.workspaceId == nil)
        }

        Section("Session") {
            if let summary = row.summary {
                // The whole summary, for a row you are not hovering and for keyboard users.
                Menu {
                    if let state = summary.state { Text(state) }
                    if let next = summary.next { Text("Next: \(next)") }
                    if let remaining = summary.remaining { Text("Remaining: \(remaining)") }
                    if let drift = summary.driftLabel { Text(drift) }
                } label: {
                    Label("Full summary", systemImage: "text.alignleft")
                }
                Button {
                    actions.copySummary(row)
                } label: {
                    Label("Copy summary", systemImage: "doc.on.doc")
                }
            }
            Button {
                actions.setIncognito(row, true)
            } label: {
                Label("Make incognito", systemImage: "eye.slash")
            }
            if row.hasTab {
                Button {
                    actions.closeTab(row)
                } label: {
                    Label("Close tab", systemImage: "xmark")
                }
            }
            // Destructive role paints it red and separates it from the reversible commands above.
            Button(role: .destructive) {
                actions.destroy(row)
            } label: {
                Label("Destroy…", systemImage: "trash")
            }
        }
    }
}
