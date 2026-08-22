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
