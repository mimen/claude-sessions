import Foundation
import XCTest
@testable import CcsSidebarUI

private enum LoaderFailure: Error {
    case unavailable
}

private actor SnapshotQueue {
    private var responses: [Result<Data, Error>]
    private var requests = 0
    private var lastTimeout: TimeInterval?

    init(_ responses: [Result<Data, Error>]) {
        self.responses = responses
    }

    func load(_ request: URLRequest) throws -> Data {
        requests += 1
        lastTimeout = request.timeoutInterval
        guard !responses.isEmpty else { throw LoaderFailure.unavailable }
        return try responses.removeFirst().get()
    }

    func requestCount() -> Int {
        requests
    }

    func timeout() -> TimeInterval? {
        lastTimeout
    }
}

private func snapshotData(revision: Int, serverVersion: String) -> Data {
    Data("""
    {
      "rows": [],
      "livenessReadable": true,
      "hasMoreRows": false,
      "lifecycleCounts": {"active": 0},
      "serverVersion": "\(serverVersion)",
      "snapshotRevision": \(revision)
    }
    """.utf8)
}

@MainActor
final class SnapshotClientTests: XCTestCase {
    func testRetriesWhenTheFirstSnapshotPredatesTheAnnouncedRevision() async {
        let queue = SnapshotQueue([
            .success(snapshotData(revision: 0, serverVersion: "stale")),
            .success(snapshotData(revision: 1, serverVersion: "fresh")),
        ])
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await queue.load(request)
        })

        await client.receiveRevision(1)

        XCTAssertEqual(client.serverVersion, "fresh")
        XCTAssertNil(client.lastError)
        let requestCount = await queue.requestCount()
        let timeout = await queue.timeout()
        XCTAssertEqual(requestCount, 2)
        XCTAssertEqual(timeout, 5)
    }

    func testFailedRefreshLeavesTheRevisionPendingForTheBackstopPoll() async {
        let queue = SnapshotQueue([
            .failure(LoaderFailure.unavailable),
            .success(snapshotData(revision: 4, serverVersion: "recovered")),
        ])
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await queue.load(request)
        })

        await client.receiveRevision(4)
        XCTAssertNotNil(client.lastError)

        await client.refreshPending()

        XCTAssertEqual(client.serverVersion, "recovered")
        XCTAssertNil(client.lastError)
        let requestCount = await queue.requestCount()
        XCTAssertEqual(requestCount, 2)
    }
}
