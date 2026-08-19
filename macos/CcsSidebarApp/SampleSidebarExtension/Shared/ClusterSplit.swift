import Foundation

/// How a cluster's rows are broken up once clusters mode has lifted them out of the list.
///
/// A fleet is one group only while it is small. event-watch runs a worker per event, so the
/// cluster arrives as thirty rows under one header — readable as a list, useless as a grouping.
/// The split names the axis to cut along; the cluster header keeps the parts together.
public enum ClusterSplit: String, CaseIterable, Sendable {
    /// The whole cluster in one group, as it was before splitting existed.
    case none
    /// One group per work item — the event an event-watch worker is on, read from its identity.
    case work
    /// Core identities by their role, and workers by the phase of work their session is doing.
    case role

    /// The band core identities land in — the coordinator, scout, designer and evaluator that run
    /// the fleet rather than any one of its work items.
    static let coreBand = "Core"

    public var title: String {
        switch self {
        case .none: return "One group"
        case .work: return "By event"
        case .role: return "By role"
        }
    }

    /// How the bands this split produces are ordered.
    ///
    /// Events are a timeline, so they read in date order rather than in whatever order sessions
    /// happened to arrive. Core leads regardless: it is the way into the cluster, and it has no
    /// date to sort by. Undated bands keep their arrival order behind the dated ones, so a split
    /// the cluster has recorded nothing about is left exactly as it was.
    func sortKey(for band: String, rows: [SidebarRow]) -> (Int, Double) {
        guard self == .work else { return (0, 0) }
        if band == ClusterSplit.coreBand { return (0, 0) }
        guard let startsAt = rows.compactMap({ $0.membership?.workStartsAt }).min() else {
            return (2, 0)
        }
        return (1, startsAt)
    }

    /// The part of the cluster this row belongs to, or nil to leave it under the bare cluster.
    ///
    /// Nil rather than an "Other" bucket: a row the split cannot place is still a member of the
    /// cluster, and inventing a group for it would claim knowledge the row does not carry.
    func part(of row: SidebarRow) -> String? {
        switch self {
        case .none:
            return nil
        case .work:
            guard let membership = row.membership else { return nil }
            // The identity's work ref is the durable answer — it survives a retitle, and two
            // sessions on the same event land together however differently they are named.
            // A core identity runs the whole cluster rather than one unit of its work, so the
            // four of them get a band instead of sitting loose above the events.
            return membership.workLabel ?? (membership.role == nil ? nil : ClusterSplit.coreBand)
        case .role:
            guard let membership = row.membership else { return nil }
            // A core identity IS its role: coordinator, scout, evaluator, designer.
            guard membership.workRef != nil else { return membership.role?.capitalized }
            // A worker's role is the same word for all of them, so the useful distinction is what
            // the session is actually doing. Only the title carries that today, so an unrecognised
            // title lands in the plain worker group rather than inventing a phase for it.
            return WorkerPhase.of(row)?.title ?? "Workers"
        }
    }
}

/// The phase of event work a worker session is on, as its own title states it.
///
/// Deliberately read from the title rather than stored: `stage` on the identity is monotonic and
/// shared by every session on that event, so writing a guess there would move the whole event's
/// state. This is a display grouping, and a display grouping may be derived.
enum WorkerPhase: String, CaseIterable {
    case operations, closeout

    var title: String {
        switch self {
        case .operations: return "Operations"
        case .closeout: return "Closeout"
        }
    }

    static func of(_ row: SidebarRow) -> WorkerPhase? {
        let name = row.name.lowercased()
        // Closeout wins a title naming both: a session that mentions closeout at all has reached it.
        if name.contains("closeout") || name.contains("settlement") { return .closeout }
        if name.contains("operations") { return .operations }
        return nil
    }
}
