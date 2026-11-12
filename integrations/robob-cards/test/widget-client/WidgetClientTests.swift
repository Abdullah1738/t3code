import Foundation

enum TestFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self {
        case .failed(let message): return message
        }
    }
}

func expect(_ condition: @autoclosure () -> Bool, _ message: String) throws {
    if !condition() { throw TestFailure.failed(message) }
}

func bytes(_ value: String) -> Data { Data(value.utf8) }

func renderJSON(id: String = "macros", title: String = "Macros left", stale: String = "") -> String {
    """
    {"id":"\(id)","title":"\(title)","asOf":"2026-11-04T15:20:00+04:00","refreshMinutes":15.5,
     "blocks":[
       {"type":"rings","items":[{"label":"kcal","value":1240,"max":2100,"unit":""},{"label":"P","value":120.5,"max":190,"unit":"g"}]},
       {"type":"stat","label":"Left","value":"860 kcal","delta":"-40 vs yesterday"},
       {"type":"progress","label":"Done","value":12.25,"max":30},
       {"type":"list","rows":[{"label":"Todo","value":"8"}]},
       {"type":"sparkline","label":"Weight","points":[81.2,81.0,80.7]},
       {"type":"future-block","arbitrary":{"nested":[1,true,null]}}
     ],
     "actions":[{"id":"refresh","label":"Refresh","symbol":"arrow.clockwise"}]\(stale)}
    """
}

final class StubProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = (URLRequest) throws -> (Int, Data)
    private static let lock = NSLock()
    nonisolated(unsafe) private static var storedHandler: Handler?
    nonisolated(unsafe) private static var storedRequests: [URLRequest] = []

    static func setHandler(_ handler: @escaping Handler) {
        lock.lock()
        defer { lock.unlock() }
        storedHandler = handler
    }

    static func requests() -> [URLRequest] {
        lock.lock()
        defer { lock.unlock() }
        return storedRequests
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.storedRequests.append(request)
        let handler = Self.storedHandler
        Self.lock.unlock()
        do {
            guard let handler else { throw URLError(.notConnectedToInternet) }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

func shouldThrow(_ name: String, _ action: () async throws -> Void) async throws {
    do {
        try await action()
        throw TestFailure.failed("\(name): expected failure")
    } catch let failure as TestFailure {
        throw failure
    } catch {
        // Expected.
    }
}

func testModels() throws {
    let decoder = JSONDecoder()
    let model = try decoder.decode(WidgetRender.self, from: bytes(renderJSON()))
    try expect(model.id == "macros" && model.title == "Macros left", "render identity")
    try expect(model.asOf == "2026-11-04T15:20:00+04:00", "asOf preserved")
    try expect(model.refreshMinutes == 15.5 && !model.stale, "fractional refresh and absent stale")
    try expect(model.blocks.count == 5 && model.actions.count == 1, "unknown block skipped")
    guard case .rings(let rings) = model.blocks[0], case .stat(let stat) = model.blocks[1],
          case .progress(let progress) = model.blocks[2], case .list(let rows) = model.blocks[3],
          case .sparkline(let sparkline) = model.blocks[4] else {
        throw TestFailure.failed("all five block types")
    }
    try expect(rings == [RingItem(label: "kcal", value: 1240, max: 2100, unit: ""), RingItem(label: "P", value: 120.5, max: 190, unit: "g")], "ring fields")
    try expect(stat == StatBlock(label: "Left", value: "860 kcal", delta: "-40 vs yesterday"), "stat fields")
    try expect(progress == ProgressBlock(label: "Done", value: 12.25, max: 30), "progress fields")
    try expect(rows == [ListRow(label: "Todo", value: "8")], "list fields")
    try expect(sparkline == SparklineBlock(label: "Weight", points: [81.2, 81.0, 80.7]), "sparkline fields")
    try expect(model.actions == [WidgetAction(id: "refresh", label: "Refresh", symbol: "arrow.clockwise")], "action fields")

    let noDelta = try decoder.decode(WidgetBlock.self, from: bytes("{\"type\":\"stat\",\"label\":\"A\",\"value\":\"2\"}"))
    try expect(noDelta == .stat(StatBlock(label: "A", value: "2", delta: nil)), "optional stat delta")
    let unknown = try decoder.decode(WidgetBlock.self, from: bytes("{\"type\":\"future\",\"nested\":[{}]}"))
    try expect(unknown == .unknown, "standalone unknown case")
    let allBlocks: [WidgetBlock] = model.blocks + [.unknown]
    for block in allBlocks {
        let data = try JSONEncoder().encode(block)
        let roundTrip = try decoder.decode(WidgetBlock.self, from: data)
        try expect(roundTrip == block, "block Codable round trip: \(block)")
        let object = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        try expect(object?["type"] is String, "encoded block has type tag")
    }
    let roundTrip = try decoder.decode(WidgetRender.self, from: JSONEncoder().encode(model))
    try expect(roundTrip == model, "render Codable round trip")
    let staleModel = try decoder.decode(WidgetRender.self, from: bytes(renderJSON(stale: ",\"stale\":true")))
    try expect(staleModel.stale, "server stale true")
    let explicitlyFresh = try decoder.decode(WidgetRender.self, from: bytes(renderJSON(stale: ",\"stale\":false")))
    try expect(!explicitlyFresh.stale, "server stale false")

    for bad in [
        "{\"type\":\"stat\",\"label\":\"A\",\"value\":1}",
        "{\"type\":\"rings\",\"items\":[{\"label\":\"P\",\"value\":1,\"max\":2}]}",
        "{\"label\":\"missing type\"}",
    ] {
        do {
            _ = try decoder.decode(WidgetBlock.self, from: bytes(bad))
            throw TestFailure.failed("invalid known block accepted")
        } catch let failure as TestFailure { throw failure } catch {}
    }
}

func testSchedule() throws {
    let now = Date(timeIntervalSince1970: 1_700_000_000)
    for minutes: Double? in [nil, -1, 1, .nan, .infinity] {
        let next = WidgetSchedule.next(after: now, refreshMinutes: minutes)
        try expect(next.timeIntervalSince(now) == 15 * 60, "minimum schedule for \(String(describing: minutes))")
    }
    let fractional = WidgetSchedule.next(after: now, refreshMinutes: 15.5)
    try expect(fractional.timeIntervalSince(now) == 930, "fractional refresh schedule")
    let huge = WidgetSchedule.next(after: now, refreshMinutes: Double.greatestFiniteMagnitude)
    try expect(huge == .distantFuture && huge.timeIntervalSince1970.isFinite, "huge finite schedule saturates without overflow")
}

func testActions(_ client: WidgetClient) async throws {
    let key = UUID(uuidString: "01234567-89AB-4CDE-8FAB-0123456789AB")!
    let successCases: [(Int, String, WidgetActionOutcome)] = [
        (200, "{\"ok\":true}", .completed),
        (200, "{\"ok\":true,\"message\":\"Refreshed\"}", .completed),
        (200, "{\"ok\":true,\"pending\":false}", .completed),
        (200, "{\"ok\":true,\"pending\":true}", .pending),
        (200, "{\"ok\":true,\"pending\":true,\"message\":\"Still running\"}", .pending),
        (202, "{\"ok\":true,\"pending\":true}", .pending),
        (202, "{\"ok\":true,\"pending\":true,\"message\":\"Still running\"}", .pending),
    ]
    for (status, body, expected) in successCases {
        let count = StubProtocol.requests().count
        StubProtocol.setHandler { request in
            try expect(request.httpMethod == "POST", "action POST")
            try expect(request.url?.path == "/prefix/api/widgets/macros/actions/refresh", "action URL")
            try expect(request.timeoutInterval == 10, "10 second action timeout")
            try expect(request.value(forHTTPHeaderField: "Idempotency-Key") == key.uuidString, "action sends exact caller UUID")
            try expect(request.value(forHTTPHeaderField: "Idempotency-Replay") == nil, "initial action omits replay header")
            return (status, bytes(body))
        }
        let outcome = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key)
        try expect(outcome == expected, "action outcome for HTTP \(status), \(body)")
        try expect(StubProtocol.requests().count == count + 1, "one request per successful call")
    }

    for (body, expectedMessage) in [
        ("{\"ok\":false,\"message\":\"failed\"}", "failed"),
        ("{\"ok\":false,\"error\":\"source rejected\"}", "source rejected"),
        ("{\"ok\":false}", "Widget action failed"),
    ] {
        let count = StubProtocol.requests().count
        StubProtocol.setHandler { _ in (200, bytes(body)) }
        do {
            _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key)
            throw TestFailure.failed("action ok=false accepted")
        } catch WidgetClientError.actionFailed(let message) {
            try expect(message == expectedMessage, "action failure retains server message or error")
        }
        try expect(StubProtocol.requests().count == count + 1, "failed action is not retried automatically")
    }

    for (status, body) in [
        (500, "{\"ok\":true,\"message\":\"success\"}"),
        (503, "{\"error\":\"source still running\"}"),
        (200, "{}"),
        (200, "not JSON"),
        (200, "{\"ok\":\"true\"}"),
        (200, "{\"ok\":true,\"message\":123}"),
        (202, "{\"ok\":true}"),
        (202, "{\"ok\":true,\"pending\":false}"),
        (202, "{\"ok\":true,\"pending\":\"yes\"}"),
        (204, "{\"ok\":true}"),
        (201, "{\"ok\":true}"),
        (206, "{\"ok\":true}"),
    ] {
        let count = StubProtocol.requests().count
        StubProtocol.setHandler { _ in (status, bytes(body)) }
        try await shouldThrow("invalid action response HTTP \(status): \(body)") {
            _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key)
        }
        try expect(StubProtocol.requests().count == count + 1, "invalid response is not retried automatically")
    }

    StubProtocol.setHandler { _ in (503, bytes("{\"error\":\"source still running\"}")) }
    do {
        _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key)
        throw TestFailure.failed("HTTP 503 accepted")
    } catch WidgetClientError.httpStatusWithMessage(let status, let message) {
        try expect(status == 503 && message == "source still running", "HTTP error retains server text")
    }

    let unknownMessage = "The action outcome is unknown; do not retry."
    for replay in [false, true] {
        let count = StubProtocol.requests().count
        StubProtocol.setHandler { _ in
            (409, bytes("{\"ok\":false,\"error\":\"unknown_key\",\"replayable\":false,\"message\":\"\(unknownMessage)\"}"))
        }
        do {
            _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key, replay: replay)
            throw TestFailure.failed("unknown key accepted as success")
        } catch WidgetClientError.unknownKey(let message) {
            try expect(message == unknownMessage, "unknown key carries the server message")
            try expect(WidgetClientError.unknownKey(message).errorDescription == unknownMessage, "unknown key displays the server message")
        }
        try expect(StubProtocol.requests().count == count + 1, "unknown key is never automatically retried")
    }

    for body in [
        "{\"ok\":false,\"error\":\"other\",\"replayable\":false,\"message\":\"conflict\"}",
        "{\"ok\":true,\"error\":\"unknown_key\",\"replayable\":false,\"message\":\"conflict\"}",
        "{\"ok\":false,\"error\":\"unknown_key\",\"replayable\":true,\"message\":\"conflict\"}",
        "{\"ok\":false,\"error\":\"unknown_key\",\"message\":\"conflict\"}",
        "{\"ok\":false,\"error\":\"unknown_key\",\"replayable\":false}",
        "not JSON",
    ] {
        let count = StubProtocol.requests().count
        StubProtocol.setHandler { _ in (409, bytes(body)) }
        do {
            _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key, replay: true)
            throw TestFailure.failed("other HTTP 409 accepted")
        } catch let error as WidgetClientError {
            switch error {
            case .httpStatus(409), .httpStatusWithMessage(409, _): break
            default: throw TestFailure.failed("other HTTP 409 must remain a generic HTTP error: \(error)")
            }
        }
        try expect(StubProtocol.requests().count == count + 1, "other HTTP 409 is never automatically retried")
    }

    let busyCount = StubProtocol.requests().count
    StubProtocol.setHandler { _ in (503, bytes("{\"error\":\"busy\"}")) }
    do {
        _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key)
        throw TestFailure.failed("initial busy response accepted")
    } catch WidgetClientError.busy {
        try expect(WidgetClientError.busy.errorDescription != nil, "busy has a user-facing message")
    }
    try expect(StubProtocol.requests().count == busyCount + 1, "initial busy is never automatically retried")

    do {
        _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key, replay: true)
        throw TestFailure.failed("replay busy response accepted")
    } catch WidgetClientError.httpStatusWithMessage(let status, let message) {
        try expect(status == 503 && message == "busy", "busy on replay remains an ambiguous HTTP error")
    }
    try expect(StubProtocol.requests().count == busyCount + 2, "replay busy is never automatically retried")

    for body in ["{\"error\":\"source still running\"}", "{\"message\":\"busy\"}", "{}", "not JSON"] {
        let count = StubProtocol.requests().count
        StubProtocol.setHandler { _ in (503, bytes(body)) }
        do {
            _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: key)
            throw TestFailure.failed("generic HTTP 503 accepted")
        } catch let error as WidgetClientError {
            switch error {
            case .httpStatus(503), .httpStatusWithMessage(503, _): break
            default: throw TestFailure.failed("generic HTTP 503 must not become typed busy: \(error)")
            }
        }
        try expect(StubProtocol.requests().count == count + 1, "generic HTTP 503 is never automatically retried")
    }

    // Each explicit call may replay the same logical operation, but the client must never retry on its own.
    let replayKey = UUID(uuidString: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE")!
    let nextTapKey = UUID(uuidString: "BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF")!
    let start = StubProtocol.requests().count
    StubProtocol.setHandler { _ in throw URLError(.timedOut) }
    do {
        _ = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: replayKey)
        throw TestFailure.failed("action timeout accepted")
    } catch let error as URLError {
        try expect(error.code == .timedOut, "action timeout propagated")
    }
    try expect(StubProtocol.requests().count == start + 1, "timeout sent exactly once")

    StubProtocol.setHandler { _ in (202, bytes("{\"ok\":true,\"pending\":true}")) }
    let pending = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: replayKey, replay: true)
    try expect(pending == .pending && StubProtocol.requests().count == start + 2, "explicit same-key retry after timeout reports pending once")

    StubProtocol.setHandler { _ in (200, bytes("{\"ok\":true}")) }
    let completed = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: replayKey, replay: true)
    try expect(completed == .completed && StubProtocol.requests().count == start + 3, "explicit same-key retry after 202 reports completed once")
    let replayed = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: replayKey, replay: true)
    try expect(replayed == .completed && StubProtocol.requests().count == start + 4, "explicit same-key retry after 200 is sent once")
    let nextTap = try await client.perform(widgetId: "macros", actionId: "refresh", idempotencyKey: nextTapKey, replay: false)
    try expect(nextTap == .completed && StubProtocol.requests().count == start + 5, "separate tap is sent once")

    let requests = Array(StubProtocol.requests().dropFirst(start))
    try expect(replayKey != nextTapKey, "distinct caller UUIDs for distinct taps")
    try expect(requests.map { $0.value(forHTTPHeaderField: "Idempotency-Key") } ==
        [replayKey.uuidString, replayKey.uuidString, replayKey.uuidString, replayKey.uuidString, nextTapKey.uuidString],
        "explicit retries retain key; distinct tap passes its own key")
    try expect(requests.map { $0.value(forHTTPHeaderField: "Idempotency-Replay") } ==
        [nil, "1", "1", "1", nil], "only explicit replays carry the replay header")
    try expect(requests.allSatisfy { $0.httpMethod == "POST" && $0.timeoutInterval == 10 }, "every replay preserves method and timeout")
}

func testClient(cacheDirectory: URL) async throws {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [StubProtocol.self]
    let session = URLSession(configuration: config)
    defer { session.invalidateAndCancel() }
    let client = WidgetClient(baseURL: URL(string: "https://example.test/prefix")!, session: session, cacheDirectory: cacheDirectory)

    StubProtocol.setHandler { request in
        try expect(request.httpMethod == "GET", "list method")
        try expect(request.url?.path == "/prefix/api/widgets", "list URL")
        try expect(request.timeoutInterval == 10, "10 second list timeout")
        return (200, bytes("{\"widgets\":[{\"id\":\"macros\",\"title\":\"Macros left\",\"families\":[\"systemSmall\",\"accessoryInline\"],\"refreshMinutes\":15.5}]}"))
    }
    let list = try await client.list()
    try expect(list == [WidgetSummary(id: "macros", title: "Macros left", families: ["systemSmall", "accessoryInline"], refreshMinutes: 15.5)], "list decoded")
    let decodedList = try JSONDecoder().decode(WidgetList.self, from: JSONEncoder().encode(WidgetList(widgets: list)))
    try expect(decodedList.widgets == list, "list Codable round trip")

    StubProtocol.setHandler { _ in (200, bytes("{\"widgets\":[{\"id\":\"../oops\",\"title\":\"x\",\"families\":[],\"refreshMinutes\":15}]}")) }
    try await shouldThrow("invalid list ID") { _ = try await client.list() }
    StubProtocol.setHandler { _ in (200, bytes("{\"widgets\":[{\"id\":\"foo\",\"title\":\"x\",\"families\":[],\"refreshMinutes\":0}]}")) }
    try await shouldThrow("invalid list refresh") { _ = try await client.list() }
    StubProtocol.setHandler { _ in (200, bytes("{\"widgets\":[]}")) }
    let emptyList = try await client.list()
    try expect(emptyList.isEmpty, "empty list")
    StubProtocol.setHandler { _ in (503, bytes("{\"widgets\":[]}")) }
    try await shouldThrow("list HTTP error") { _ = try await client.list() }
    StubProtocol.setHandler { _ in (200, bytes("<html>not json</html>")) }
    try await shouldThrow("list malformed JSON") { _ = try await client.list() }

    StubProtocol.setHandler { _ in (503, bytes("{\"error\":\"source still running\"}")) }
    let runningWithoutCache = await client.load(id: "macros")
    try expect(runningWithoutCache.status == .unavailable && runningWithoutCache.model == nil, "source still running without cache")

    StubProtocol.setHandler { request in
        try expect(request.httpMethod == "GET" && request.url?.path == "/prefix/api/widgets/macros", "render request")
        try expect(request.timeoutInterval == 10, "10 second load timeout")
        return (200, bytes(renderJSON(stale: ",\"stale\":true")))
    }
    let live = await client.load(id: "macros")
    try expect(live.status == nil && live.model?.stale == true, "live stale distinct from offline")
    let cacheURL = cacheDirectory.appendingPathComponent("macros.json")
    let cachedData = try Data(contentsOf: cacheURL)
    try expect(cachedData == bytes(renderJSON(stale: ",\"stale\":true")), "cache raw successful JSON")

    StubProtocol.setHandler { _ in (503, bytes("{\"error\":\"source still running\"}")) }
    let runningWithCache = await client.load(id: "macros")
    try expect(runningWithCache.status == .unavailable && runningWithCache.model == live.model, "source still running uses cached snapshot")
    let stillCachedData = try Data(contentsOf: cacheURL)
    try expect(stillCachedData == cachedData, "503 does not replace cached snapshot")
    let nextRetry = WidgetSchedule.next(after: Date(timeIntervalSince1970: 1_700_000_000), refreshMinutes: nil)
    try expect(nextRetry.timeIntervalSince1970 == 1_700_000_000 + 15 * 60, "no-cache retry uses provider's 15 minute schedule")

    StubProtocol.setHandler { _ in throw URLError(.notConnectedToInternet) }
    let offline = await client.load(id: "macros")
    try expect(offline.status == .offline && offline.model == live.model && offline.model?.stale == true, "offline cache preserves stale")
    let noCache = await client.load(id: "never-cached")
    try expect(noCache.status == .offline && noCache.model == nil, "no cache offline")

    StubProtocol.setHandler { _ in (200, bytes(renderJSON(title: "Fresh"))) }
    let fresh = await client.load(id: "macros")
    try expect(fresh.status == nil && fresh.model?.stale == false && fresh.model?.title == "Fresh", "successful update replaces cache")
    StubProtocol.setHandler { _ in throw URLError(.timedOut) }
    let timedOut = await client.load(id: "macros")
    try expect(timedOut.status == .offline && timedOut.model == fresh.model && timedOut.model?.stale == false, "timeout serves new cache")

    for (status, body) in [
        (500, renderJSON(title: "Must not cache")),
        (404, "{\"error\":\"missing\"}"),
        (200, "invalid JSON"),
        (200, renderJSON(id: "different")),
        (200, renderJSON().replacingOccurrences(of: "15.5", with: "0")),
        (200, renderJSON().replacingOccurrences(of: "\"value\":\"860 kcal\"", with: "\"value\":860")),
    ] {
        StubProtocol.setHandler { _ in (status, bytes(body)) }
        let result = await client.load(id: "macros")
        try expect(result.status == .unavailable && result.model == fresh.model, "HTTP/decode/identity failure uses last cache and reports unavailable")
    }
    let originalData = try Data(contentsOf: cacheURL)
    try expect(originalData == bytes(renderJSON(title: "Fresh")), "failed responses cannot overwrite cache")

    StubProtocol.setHandler { request in
        let id = request.url!.lastPathComponent
        return (200, bytes(renderJSON(id: id, title: "Title \(id)")))
    }
    let other = await client.load(id: "other-2")
    try expect(other.model?.id == "other-2" && other.status == nil, "second widget live")
    StubProtocol.setHandler { _ in throw URLError(.notConnectedToInternet) }
    let otherOffline = await client.load(id: "other-2")
    let macrosOffline = await client.load(id: "macros")
    try expect(otherOffline.status == .offline && otherOffline.model?.id == "other-2" && otherOffline.model?.title == "Title other-2", "second widget cached separately")
    try expect(macrosOffline.model?.id == "macros" && macrosOffline.model?.title == "Fresh", "first widget cache unaffected")
    let renamed = cacheDirectory.appendingPathComponent("renamed.json")
    try Data(contentsOf: cacheURL).write(to: renamed)
    let wrongID = await client.load(id: "renamed")
    try expect(wrongID.status == .offline && wrongID.model == nil, "cached identity checked")

    let count = StubProtocol.requests().count
    let invalidIDKey = UUID()
    for invalid in ["", "..", "../macros", "/macros", "macros/../other", "%2f", "MACROS", "macros_1", "é", String(repeating: "a", count: 41)] {
        let result = await client.load(id: invalid)
        try expect(result.status == .unavailable && result.model == nil, "invalid load ID rejected: \(invalid)")
        try await shouldThrow("invalid widget ID action") { _ = try await client.perform(widgetId: invalid, actionId: "refresh", idempotencyKey: invalidIDKey) }
        try await shouldThrow("invalid action ID action") { _ = try await client.perform(widgetId: "macros", actionId: invalid, idempotencyKey: invalidIDKey) }
    }
    try expect(StubProtocol.requests().count == count, "invalid IDs never reach network")

    let longestID = String(repeating: "a", count: 40)
    StubProtocol.setHandler { _ in (200, bytes(renderJSON(id: longestID))) }
    let longest = await client.load(id: longestID)
    try expect(longest.status == nil && longest.model?.id == longestID, "40 byte ID accepted")
    try Data("{bad".utf8).write(to: cacheURL)
    StubProtocol.setHandler { _ in throw URLError(.notConnectedToInternet) }
    let corrupt = await client.load(id: "macros")
    try expect(corrupt.status == .offline && corrupt.model == nil, "corrupt cache ignored")

    try await testActions(client)

    let unwritableClient = WidgetClient(baseURL: URL(string: "https://example.test")!, session: session, cacheDirectory: cacheURL)
    StubProtocol.setHandler { _ in (200, bytes(renderJSON())) }
    let uncachedLive = await unwritableClient.load(id: "macros")
    try expect(uncachedLive.status == nil && uncachedLive.model?.id == "macros", "cache write failure retains live model")
}

let directory = FileManager.default.temporaryDirectory.appendingPathComponent("robob-widget-tests-\(UUID().uuidString)", isDirectory: true)
defer { try? FileManager.default.removeItem(at: directory) }
do {
    try testModels()
    try testSchedule()
    try await testClient(cacheDirectory: directory)
    print("Widget model and client tests passed")
} catch {
    fputs("Widget tests failed: \(error)\n", stderr)
    exit(1)
}
