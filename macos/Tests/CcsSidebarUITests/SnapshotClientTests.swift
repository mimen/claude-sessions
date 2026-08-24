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

private actor ControlledSnapshotLoader {
    private var requests: [URLRequest] = []
    private var continuations: [CheckedContinuation<Data, Error>] = []

    func load(_ request: URLRequest) async throws -> Data {
        requests.append(request)
        return try await withCheckedThrowingContinuation { continuation in
            continuations.append(continuation)
        }
    }

    func waitForRequestCount(_ count: Int) async {
        while requests.count < count {
            await Task.yield()
        }
    }

    func requestCount() -> Int {
        requests.count
    }

    func request(at index: Int) -> URLRequest {
        requests[index]
    }

    func resolveNext(with data: Data) {
        continuations.removeFirst().resume(returning: data)
    }
}

private func snapshotData(serverVersion: String) -> Data {
    Data("""
    {
      "rows": [],
      "livenessReadable": true,
      "hasMoreRows": false,
      "lifecycleCounts": {"active": 0},
      "serverVersion": "\(serverVersion)"
    }
    """.utf8)
}

/// The row wire contract: a field the server adds must decode, and its absence on older
/// servers must decode as nil rather than failing the whole snapshot.
final class SidebarRowDecodingTests: XCTestCase {
    func testDecodesT3AssociationAndToleratesItsAbsence() throws {
        let withT3 = Data("""
        {
          "id": "s1", "kind": "session", "name": "T3 session", "density": "full",
          "pinned": false, "focused": false, "unread": 0,
          "t3Associated": true,
          "category": {"compactLabel": "AI Systems", "hex": "#2A67E2"}
        }
        """.utf8)
        let row = try JSONDecoder().decode(SidebarRow.self, from: withT3)
        XCTAssertEqual(row.t3Associated, true)

        let withoutT3 = Data("""
        {
          "id": "s2", "kind": "session", "name": "Older server", "density": "full",
          "pinned": false, "focused": false, "unread": 0
        }
        """.utf8)
        let older = try JSONDecoder().decode(SidebarRow.self, from: withoutT3)
        XCTAssertNil(older.t3Associated)
    }
}

@MainActor
final class SnapshotClientTests: XCTestCase {
    func testAppliesTheLatestCompletedSnapshotWhileRevisionsKeepAdvancing() async {
        let queue = SnapshotQueue([
            .success(snapshotData(serverVersion: "completed")),
        ])
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await queue.load(request)
        })

        await client.receiveRevision(1)

        XCTAssertEqual(client.serverVersion, "completed")
        XCTAssertNil(client.lastError)
        let requestCount = await queue.requestCount()
        let timeout = await queue.timeout()
        XCTAssertEqual(requestCount, 1)
        XCTAssertEqual(timeout, 5)
    }

    func testRevisionRefreshQueuesBehindForcedLivenessWithoutDiscardingIt() async {
        let loader = ControlledSnapshotLoader()
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await loader.load(request)
        })

        let forced = Task { await client.refreshNow() }
        await loader.waitForRequestCount(1)
        let revision = Task { await client.receiveRevision(1) }
        for _ in 0..<20 { await Task.yield() }

        let initialRequestCount = await loader.requestCount()
        let forcedRequest = await loader.request(at: 0)
        XCTAssertEqual(initialRequestCount, 1)
        XCTAssertEqual(forcedRequest.value(forHTTPHeaderField: "x-ccs-refresh-liveness"), "1")

        await loader.resolveNext(with: snapshotData(serverVersion: "forced"))
        await loader.waitForRequestCount(2)
        let followUpRequest = await loader.request(at: 1)
        XCTAssertNil(followUpRequest.value(forHTTPHeaderField: "x-ccs-refresh-liveness"))
        await loader.resolveNext(with: snapshotData(serverVersion: "follow-up"))

        _ = await forced.value
        _ = await revision.value
        XCTAssertEqual(client.serverVersion, "follow-up")
        XCTAssertNil(client.lastError)
    }

    func testForcedRefreshRetriesOnceAfterTransportFailure() async {
        let queue = SnapshotQueue([
            .failure(LoaderFailure.unavailable),
            .success(snapshotData(serverVersion: "recovered")),
        ])
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await queue.load(request)
        })

        await client.refreshNow()

        XCTAssertEqual(client.serverVersion, "recovered")
        XCTAssertNil(client.lastError)
        let requestCount = await queue.requestCount()
        XCTAssertEqual(requestCount, 2)
    }

    func testPlainRefreshAlreadyInFlightQueuesForcedLiveness() async {
        let loader = ControlledSnapshotLoader()
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await loader.load(request)
        })

        let plain = Task { await client.refreshLatest() }
        await loader.waitForRequestCount(1)
        let forced = Task { await client.refreshNow() }
        for _ in 0..<20 { await Task.yield() }
        let initialCount = await loader.requestCount()
        XCTAssertEqual(initialCount, 1)

        await loader.resolveNext(with: snapshotData(serverVersion: "plain"))
        await loader.waitForRequestCount(2)
        let forcedRequest = await loader.request(at: 1)
        XCTAssertEqual(forcedRequest.value(forHTTPHeaderField: "x-ccs-refresh-liveness"), "1")
        XCTAssertNil(client.serverVersion)

        await loader.resolveNext(with: snapshotData(serverVersion: "forced"))
        _ = await plain.value
        _ = await forced.value
        XCTAssertEqual(client.serverVersion, "forced")
    }

    func testScopeChangeQueuesAReplacementWithoutPaintingThePreviousQuery() async {
        let loader = ControlledSnapshotLoader()
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await loader.load(request)
        })

        let active = Task { await client.refreshLatest() }
        await loader.waitForRequestCount(1)
        client.scope = .saved
        for _ in 0..<20 { await Task.yield() }
        let initialRequestCount = await loader.requestCount()
        XCTAssertEqual(initialRequestCount, 1)

        await loader.resolveNext(with: snapshotData(serverVersion: "active"))
        await loader.waitForRequestCount(2)
        let savedRequest = await loader.request(at: 1)
        XCTAssertTrue(savedRequest.url?.query?.contains("scope=saved") == true)
        XCTAssertNil(client.serverVersion)

        await loader.resolveNext(with: snapshotData(serverVersion: "saved"))
        _ = await active.value
        XCTAssertEqual(client.serverVersion, "saved")
    }

    func testSearchRequestsEveryLifecycleAndT3FromAnyView() async {
        let loader = ControlledSnapshotLoader()
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await loader.load(request)
        })
        client.scope = .completed
        client.searchIncludesAll = true
        await loader.waitForRequestCount(1)
        let request = await loader.request(at: 0)
        XCTAssertTrue(request.url?.query?.contains("scope=completed") == true)
        XCTAssertTrue(request.url?.query?.contains("include=active,saved,completed,t3") == true)
        await loader.resolveNext(with: snapshotData(serverVersion: "search"))
        for _ in 0..<20 { await Task.yield() }
    }

    func testBackstopPollRecoversAfterARevisionRefreshFails() async {
        let queue = SnapshotQueue([
            .failure(LoaderFailure.unavailable),
            .success(snapshotData(serverVersion: "recovered")),
        ])
        let client = SnapshotClient(port: 8787, snapshotData: { request in
            try await queue.load(request)
        })

        await client.receiveRevision(4)
        XCTAssertNotNil(client.lastError)

        await client.refreshLatest()

        XCTAssertEqual(client.serverVersion, "recovered")
        XCTAssertNil(client.lastError)
        let requestCount = await queue.requestCount()
        XCTAssertEqual(requestCount, 2)
    }
}
