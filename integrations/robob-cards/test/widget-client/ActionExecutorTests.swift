import Foundation

enum ExecutorTestFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self { case .failed(let message): return message }
    }
}

func expectExecutor(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw ExecutorTestFailure.failed(message) }
}

func executorBytes(_ value: String) -> Data { Data(value.utf8) }

final class ExecutorProtocol: URLProtocol, @unchecked Sendable {
    typealias Handler = @Sendable (URLRequest) throws -> (Int, Data)
    private static let mutex = NSLock()
    nonisolated(unsafe) private static var handler: Handler?
    nonisolated(unsafe) private static var received: [URLRequest] = []

    static func reset() {
        mutex.lock()
        defer { mutex.unlock() }
        handler = nil
        received = []
    }

    static func respond(_ newHandler: @escaping Handler) {
        mutex.lock()
        defer { mutex.unlock() }
        handler = newHandler
    }

    static func requests() -> [URLRequest] {
        mutex.lock()
        defer { mutex.unlock() }
        return received
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.mutex.lock()
        Self.received.append(request)
        let handler = Self.handler
        Self.mutex.unlock()
        do {
            guard let handler else { throw ExecutorTestFailure.failed("unexpected HTTP request") }
            let (status, data) = try handler(request)
            let response = HTTPURLResponse(
                url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "application/json"]
            )!
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

final class ExecutorClock: @unchecked Sendable {
    private let mutex = NSLock()
    private var date = Date(timeIntervalSince1970: 1_800_000_000)

    func now() -> Date {
        mutex.lock()
        defer { mutex.unlock() }
        return date
    }

    func advance(_ seconds: TimeInterval) {
        mutex.lock()
        defer { mutex.unlock() }
        date = date.addingTimeInterval(seconds)
    }
}

final class ExecutorFixture: @unchecked Sendable {
    let directory: URL
    let clock = ExecutorClock()
    let session: URLSession
    let client: WidgetClient
    let journal: ActionJournal

    init() {
        ExecutorProtocol.reset()
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("action-executor-tests-\(UUID())", isDirectory: true)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [ExecutorProtocol.self]
        session = URLSession(configuration: configuration)
        client = WidgetClient(baseURL: URL(string: "https://example.test/prefix")!, session: session, cacheDirectory: nil)
        let clock = self.clock
        journal = ActionJournal(directory: directory, now: { clock.now() })
    }

    func restartedJournal() -> ActionJournal {
        ActionJournal(directory: directory, now: { [clock] in clock.now() })
    }

    func executor(journal: ActionJournal? = nil) -> ActionExecutor {
        ActionExecutor(journal: journal ?? self.journal) { [client] widgetId, actionId, key, replay in
            try await client.perform(widgetId: widgetId, actionId: actionId, idempotencyKey: key, replay: replay)
        }
    }

    deinit {
        session.invalidateAndCancel()
        try? FileManager.default.removeItem(at: directory)
    }
}

func actionRequest(_ request: URLRequest, replay: Bool) throws -> UUID {
    try expectExecutor(request.httpMethod == "POST", "action is a POST")
    try expectExecutor(request.url?.path == "/prefix/api/widgets/macros/actions/refresh", "action URL")
    try expectExecutor(request.value(forHTTPHeaderField: "Idempotency-Replay") == (replay ? "1" : nil), "replay header")
    guard let header = request.value(forHTTPHeaderField: "Idempotency-Key"),
          let key = UUID(uuidString: header), header == key.uuidString else {
        throw ExecutorTestFailure.failed("action carries an exact UUID idempotency key")
    }
    return key
}

func onlyAttempt(_ journal: ActionJournal) throws -> WidgetAttempt {
    let records = try journal.records(widgetId: "macros")
    guard records.count == 1, let attempt = records.first else {
        throw ExecutorTestFailure.failed("expected exactly one attempt, got \(records.count)")
    }
    return attempt
}

func expectStartBlocked(_ fixture: ExecutorFixture) async throws {
    let before = try fixture.restartedJournal().records(widgetId: "macros")
    let count = ExecutorProtocol.requests().count
    do {
        try await fixture.executor(journal: fixture.restartedJournal()).start(widgetId: "macros", actionId: "refresh")
        throw ExecutorTestFailure.failed("unresolved action allowed another first tap")
    } catch let failure as ExecutorTestFailure { throw failure } catch {}
    try expectExecutor(ExecutorProtocol.requests().count == count, "blocked first tap sends nothing")
    try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros") == before, "blocked first tap preserves the original attempt")
}

func completionAndFreshTaps() async throws {
    let fixture = ExecutorFixture()
    ExecutorProtocol.respond { request in
        let key = try actionRequest(request, replay: false)
        let persisted = try onlyAttempt(fixture.restartedJournal())
        try expectExecutor(persisted.key == key && persisted.widgetId == "macros" && persisted.actionId == "refresh", "exact attempt persisted before send")
        try expectExecutor(persisted.state == .uncertain, "fresh send starts uncertain")
        try expectExecutor(try fixture.restartedJournal().tryLock(key: key) == nil, "attempt lock held through HTTP")
        return (200, executorBytes("{\"ok\":true}"))
    }
    let executor = fixture.executor()
    try await executor.start(widgetId: "macros", actionId: "refresh")
    try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros").isEmpty, "200 removes the completed attempt")
    try await executor.start(widgetId: "macros", actionId: "refresh")
    try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros").isEmpty, "second completion is persisted")
    let requests = ExecutorProtocol.requests()
    try expectExecutor(requests.count == 2, "each fresh tap sends once")
    let first = try actionRequest(requests[0], replay: false)
    let second = try actionRequest(requests[1], replay: false)
    try expectExecutor(first != second, "independent taps use distinct keys")
    try await fixture.executor(journal: fixture.restartedJournal()).retry(key: first)
    try await executor.retry(key: UUID())
    try expectExecutor(ExecutorProtocol.requests().count == 2, "stale and missing retries do not send")
}

func timeoutPendingAndReplay() async throws {
    let fixture = ExecutorFixture()
    ExecutorProtocol.respond { _ in throw URLError(.timedOut) }
    do {
        try await fixture.executor().start(widgetId: "macros", actionId: "refresh")
        throw ExecutorTestFailure.failed("timeout was accepted as success")
    } catch let error as URLError {
        try expectExecutor(error.code == .timedOut, "timeout propagated")
    }
    var restarted = fixture.restartedJournal()
    let uncertain = try onlyAttempt(restarted)
    try expectExecutor(uncertain.state == .uncertain && uncertain.message == nil, "timeout remains uncertain after restart")
    try expectExecutor(ExecutorProtocol.requests().count == 1, "timeout has no automatic retry")
    let initialKey = try actionRequest(ExecutorProtocol.requests()[0], replay: false)
    try expectExecutor(initialKey == uncertain.key, "timeout retains exact initial key")
    try await expectStartBlocked(fixture)

    ExecutorProtocol.respond { _ in (202, executorBytes("{\"ok\":true,\"pending\":true}")) }
    try await fixture.executor(journal: restarted).retry(key: uncertain.key)
    restarted = fixture.restartedJournal()
    let pending = try onlyAttempt(restarted)
    try expectExecutor(pending.key == uncertain.key && pending.state == .pending && pending.message == nil, "202 without message persists pending after restart")
    try expectExecutor(ExecutorProtocol.requests().count == 2, "explicit pending retry sends once")
    try fixture.executor(journal: restarted).acknowledge(key: pending.key)
    try expectExecutor(try onlyAttempt(fixture.restartedJournal()) == pending, "pending attempt cannot be acknowledged")

    ExecutorProtocol.respond { _ in (200, executorBytes("{\"ok\":true}")) }
    try await fixture.executor(journal: fixture.restartedJournal()).retry(key: pending.key)
    try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros").isEmpty, "200 replay completes the persisted attempt")
    try await fixture.executor(journal: fixture.restartedJournal()).retry(key: pending.key)
    let requests = ExecutorProtocol.requests()
    try expectExecutor(requests.count == 3, "completed stale replay does not send")
    try expectExecutor(try actionRequest(requests[1], replay: true) == initialKey, "pending replay uses original key")
    try expectExecutor(try actionRequest(requests[2], replay: true) == initialKey, "completion replay uses original key")
}

func initialPending() async throws {
    let fixture = ExecutorFixture()
    ExecutorProtocol.respond { _ in (202, executorBytes("{\"ok\":true,\"pending\":true}")) }
    try await fixture.executor().start(widgetId: "macros", actionId: "refresh")
    let pending = try onlyAttempt(fixture.restartedJournal())
    try expectExecutor(pending.state == .pending && pending.message == nil, "initial 202 persists pending without a message")
    let requests = ExecutorProtocol.requests()
    try expectExecutor(requests.count == 1, "initial 202 does not automatically retry")
    try expectExecutor(try actionRequest(requests[0], replay: false) == pending.key, "initial 202 sends the persisted key")
}

func unknownResponse(_ message: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: [
        "ok": false, "error": "unknown_key", "replayable": false, "message": message,
    ])
}

func unknownOnStartAndRetry() async throws {
    let message = "Server cannot confirm the action.\nDo not retry — check manually."
    let body = try unknownResponse(message)
    for replay in [false, true] {
        let fixture = ExecutorFixture()
        var expectedKey: UUID?
        if replay {
            ExecutorProtocol.respond { _ in throw URLError(.timedOut) }
            do {
                try await fixture.executor().start(widgetId: "macros", actionId: "refresh")
                throw ExecutorTestFailure.failed("timeout before unknown was accepted")
            } catch let error as URLError {
                try expectExecutor(error.code == .timedOut, "setup timeout propagated")
            }
            expectedKey = try onlyAttempt(fixture.restartedJournal()).key
        }
        ExecutorProtocol.respond { _ in (409, body) }
        do {
            let executor = fixture.executor(journal: fixture.restartedJournal())
            if let key = expectedKey {
                try await executor.retry(key: key)
            } else {
                try await executor.start(widgetId: "macros", actionId: "refresh")
            }
            throw ExecutorTestFailure.failed("unknown key was accepted as success")
        } catch WidgetClientError.unknownKey(let actual) {
            try expectExecutor(actual == message, "unknown error rethrown with exact message")
        }
        let unknown = try onlyAttempt(fixture.restartedJournal())
        try expectExecutor(unknown.state == .unknown && unknown.message == message, "unknown state and exact message survive restart")
        if let expectedKey { try expectExecutor(unknown.key == expectedKey, "unknown replay keeps original key") }
        let requests = ExecutorProtocol.requests()
        try expectExecutor(requests.count == (replay ? 2 : 1), "unknown was not automatically retried")
        try expectExecutor(try actionRequest(requests.last!, replay: replay) == unknown.key, "unknown HTTP key matches persisted attempt")
        try await fixture.executor(journal: fixture.restartedJournal()).retry(key: unknown.key)
        try expectExecutor(ExecutorProtocol.requests().count == requests.count, "unknown attempt cannot be retried")
        try await expectStartBlocked(fixture)
        try fixture.executor(journal: fixture.restartedJournal()).acknowledge(key: unknown.key)
        try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros").isEmpty, "unknown attempt can be acknowledged")
        ExecutorProtocol.respond { _ in (200, executorBytes("{\"ok\":true}")) }
        try await fixture.executor(journal: fixture.restartedJournal()).start(widgetId: "macros", actionId: "refresh")
        let acknowledgedRequests = ExecutorProtocol.requests()
        try expectExecutor(acknowledgedRequests.count == requests.count + 1, "acknowledgement allows one new tap")
        try expectExecutor(try actionRequest(acknowledgedRequests.last!, replay: false) != unknown.key, "new tap after acknowledgement has a fresh key")
    }
}

func busyResponses() async throws {
    let fixture = ExecutorFixture()
    let unrelated = try fixture.journal.create(widgetId: "macros", actionId: "other")
    ExecutorProtocol.respond { request in
        let key = try actionRequest(request, replay: false)
        let records = try fixture.restartedJournal().records(widgetId: "macros")
        try expectExecutor(key != unrelated.key && records.contains { $0.key == key && $0.state == .uncertain }, "busy request was persisted separately before send")
        return (503, executorBytes("{\"error\":\"busy\"}"))
    }
    do {
        try await fixture.executor().start(widgetId: "macros", actionId: "refresh")
        throw ExecutorTestFailure.failed("busy was accepted as success")
    } catch WidgetClientError.busy {}
    let requests = ExecutorProtocol.requests()
    try expectExecutor(requests.count == 1, "busy was not automatically retried")
    let busyKey = try actionRequest(requests[0], replay: false)
    let busyAttempt = try fixture.restartedJournal().records(widgetId: "macros").first { $0.key == busyKey }
    try expectExecutor(busyAttempt?.state == .uncertain, "initial busy retains its exact attempt")
    try await expectStartBlocked(fixture)

    ExecutorProtocol.respond { _ in (503, executorBytes("{\"error\":\"busy\"}")) }
    do {
        try await fixture.executor(journal: fixture.restartedJournal()).retry(key: busyKey)
        throw ExecutorTestFailure.failed("replay busy was accepted as success")
    } catch WidgetClientError.httpStatusWithMessage(let status, let message) {
        try expectExecutor(status == 503 && message == "busy", "replay busy stays an ambiguous HTTP failure")
    }
    try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros") == [unrelated, busyAttempt!], "replay 503 retains both attempts")
    let replayRequests = ExecutorProtocol.requests()
    try expectExecutor(replayRequests.count == 2, "replay busy sends once")
    try expectExecutor(try actionRequest(replayRequests[1], replay: true) == busyKey, "busy replay sends the original key")

    let message = "No stored result. Check the effect before running again."
    ExecutorProtocol.respond { _ in (409, try unknownResponse(message)) }
    do {
        try await fixture.executor(journal: fixture.restartedJournal()).retry(key: busyKey)
        throw ExecutorTestFailure.failed("busy replay unknown was accepted as success")
    } catch WidgetClientError.unknownKey(let actual) {
        try expectExecutor(actual == message, "busy replay preserves the unknown message")
    }
    let unknown = try fixture.restartedJournal().records(widgetId: "macros").first { $0.key == busyKey }
    try expectExecutor(unknown?.state == .unknown && unknown?.message == message, "busy replay persists unknown for acknowledgement")
    try expectExecutor(try actionRequest(ExecutorProtocol.requests()[2], replay: true) == busyKey, "unknown check uses the retained busy key")
    try await expectStartBlocked(fixture)
    try fixture.executor(journal: fixture.restartedJournal()).acknowledge(key: busyKey)
    ExecutorProtocol.respond { _ in (200, executorBytes("{\"ok\":true}")) }
    try await fixture.executor(journal: fixture.restartedJournal()).start(widgetId: "macros", actionId: "refresh")
    try expectExecutor(ExecutorProtocol.requests().count == 4, "busy path requires explicit acknowledgement before a new tap")
    try expectExecutor(try actionRequest(ExecutorProtocol.requests()[3], replay: false) != busyKey, "acknowledged busy attempt permits a fresh key")
    try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros") == [unrelated], "busy recovery does not affect another action")
}

final class CreationLockProbe: @unchecked Sendable {
    private let directory: URL
    private let mutex = NSLock()
    private var observed = false
    private var observation: (UUID, Bool)?

    init(directory: URL) { self.directory = directory }

    func now() -> Date {
        mutex.lock()
        defer { mutex.unlock() }
        if !observed {
            observed = true
            let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
            let keys = names.compactMap { name -> UUID? in
                guard name.hasPrefix("attempt-"), name.hasSuffix(".lock") else { return nil }
                return UUID(uuidString: String(name.dropFirst("attempt-".count).dropLast(".lock".count)))
            }
            if keys.count == 1, let key = keys.first {
                do {
                    let competingLock = try ActionJournal(directory: directory).tryLock(key: key)
                    observation = (key, competingLock == nil)
                    competingLock?.release()
                } catch {
                    observation = (key, false)
                }
            }
        }
        return Date(timeIntervalSince1970: 1_800_000_000)
    }

    func result() -> (UUID, Bool)? {
        mutex.lock()
        defer { mutex.unlock() }
        return observation
    }
}

func initialLockPrecedesPublication() async throws {
    let fixture = ExecutorFixture()
    let probe = CreationLockProbe(directory: fixture.directory)
    let journal = ActionJournal(directory: fixture.directory, now: { probe.now() })
    ExecutorProtocol.respond { _ in (202, executorBytes("{\"ok\":true,\"pending\":true}")) }
    try await fixture.executor(journal: journal).start(widgetId: "macros", actionId: "refresh")
    guard let (key, locked) = probe.result() else {
        throw ExecutorTestFailure.failed("fresh attempt lock must exist before its journal record is constructed")
    }
    try expectExecutor(locked, "fresh attempt is locked before the journal record is published")
    let pending = try onlyAttempt(journal)
    try expectExecutor(key == pending.key && pending.state == .pending, "the pre-publication lock belongs to the actual attempt")
    let requests = ExecutorProtocol.requests()
    try expectExecutor(requests.count == 1, "fresh attempt sends once")
    try expectExecutor(try actionRequest(requests[0], replay: false) == key, "pre-publication lock protects the HTTP key")
}

func persistenceFailure() async throws {
    let fixture = ExecutorFixture()
    let parentFile = fixture.directory.appendingPathComponent("file")
    try FileManager.default.createDirectory(at: fixture.directory, withIntermediateDirectories: true)
    try executorBytes("not a directory").write(to: parentFile)
    let failedJournal = ActionJournal(directory: parentFile.appendingPathComponent("journal"))
    do {
        try await fixture.executor(journal: failedJournal).start(widgetId: "macros", actionId: "refresh")
        throw ExecutorTestFailure.failed("journal creation failure was accepted")
    } catch let failure as ExecutorTestFailure { throw failure } catch {}
    try expectExecutor(ExecutorProtocol.requests().isEmpty, "failed creation never sends")
}

func agedAndClockChangedReplays() async throws {
    for offset in [601.0, 86_400.0, -3_600.0] {
        let fixture = ExecutorFixture()
        ExecutorProtocol.respond { _ in (202, executorBytes("{\"ok\":true,\"pending\":true}")) }
        try await fixture.executor().start(widgetId: "macros", actionId: "refresh")
        let pending = try onlyAttempt(fixture.restartedJournal())
        fixture.clock.advance(offset)
        try fixture.executor(journal: fixture.restartedJournal()).acknowledge(key: pending.key)
        try expectExecutor(try onlyAttempt(fixture.restartedJournal()) == pending, "age and clock changes never permit acknowledgement of a pending action")
        try await expectStartBlocked(fixture)
        try await fixture.executor(journal: fixture.restartedJournal()).retry(key: pending.key)
        try expectExecutor(try onlyAttempt(fixture.restartedJournal()) == pending, "server can still report pending regardless of client age")
        try expectExecutor(ExecutorProtocol.requests().count == 2, "aged pending check reaches server once")

        if offset == 86_400 {
            let message = "Result unknown. Check the effect."
            ExecutorProtocol.respond { _ in (409, try unknownResponse(message)) }
            do {
                try await fixture.executor(journal: fixture.restartedJournal()).retry(key: pending.key)
                throw ExecutorTestFailure.failed("aged unknown was accepted")
            } catch WidgetClientError.unknownKey(let actual) {
                try expectExecutor(actual == message, "aged check shows server unknown message")
            }
            try expectExecutor(try onlyAttempt(fixture.restartedJournal()).state == .unknown, "server alone makes aged attempt unknown")
            try await expectStartBlocked(fixture)
        } else {
            ExecutorProtocol.respond { _ in (200, executorBytes("{\"ok\":true}")) }
            try await fixture.executor(journal: fixture.restartedJournal()).retry(key: pending.key)
            try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros").isEmpty, "stored completion resolves aged or clock-shifted attempt")
        }
        let requests = ExecutorProtocol.requests()
        try expectExecutor(requests.count == 3, "only manual checks send after the original tap")
        for request in requests.dropFirst() {
            try expectExecutor(try actionRequest(request, replay: true) == pending.key, "every clock-independent check uses the original key and replay header")
        }
    }
}

actor ExecutorGate {
    private var entered = false
    private var enterWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func waitInsideRequest() async {
        entered = true
        for waiter in enterWaiters { waiter.resume() }
        enterWaiters = []
        await withCheckedContinuation { releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
        if entered { return }
        await withCheckedContinuation { enterWaiters.append($0) }
    }

    func release() {
        releaseWaiter?.resume()
        releaseWaiter = nil
    }
}

func concurrentRetryAndDismiss() async throws {
    let fixture = ExecutorFixture()
    let attempt = try fixture.journal.create(widgetId: "macros", actionId: "refresh")
    let gate = ExecutorGate()
    ExecutorProtocol.respond { _ in (200, executorBytes("{\"ok\":true}")) }
    let executor = ActionExecutor(journal: fixture.journal) { [client = fixture.client] widgetId, actionId, key, replay in
        await gate.waitInsideRequest()
        return try await client.perform(widgetId: widgetId, actionId: actionId, idempotencyKey: key, replay: replay)
    }
    let first = Task { try await executor.retry(key: attempt.key) }
    await gate.waitUntilEntered()
    do {
        try await fixture.executor(journal: fixture.restartedJournal()).retry(key: attempt.key)
        try await expectStartBlocked(fixture)
        fixture.clock.advance(600)
        try fixture.executor(journal: fixture.restartedJournal()).acknowledge(key: attempt.key)
        try expectExecutor(try onlyAttempt(fixture.restartedJournal()) == attempt, "locked attempt cannot be acknowledged, regardless of age")
        try expectExecutor(ExecutorProtocol.requests().isEmpty, "concurrent retry does not send while the key is locked")
    } catch {
        await gate.release()
        _ = try? await first.value
        throw error
    }
    await gate.release()
    try await first.value
    let requests = ExecutorProtocol.requests()
    try expectExecutor(requests.count == 1, "only the lock holder sends")
    try expectExecutor(try actionRequest(requests[0], replay: true) == attempt.key, "lock holder replays the exact original key")
    try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros").isEmpty, "completion removes the record while holding its lock")
    try await fixture.executor(journal: fixture.restartedJournal()).retry(key: attempt.key)
    try expectExecutor(ExecutorProtocol.requests().count == 1, "stale concurrent retry cannot send after completion")
}

func retryCannotOvertakeInitialSend() async throws {
    let fixture = ExecutorFixture()
    let gate = ExecutorGate()
    ExecutorProtocol.respond { request in
        if request.value(forHTTPHeaderField: "Idempotency-Replay") != nil {
            return (409, try unknownResponse("Replay must not overtake the initial send"))
        }
        return (200, executorBytes("{\"ok\":true}"))
    }
    let executor = ActionExecutor(journal: fixture.journal) { [client = fixture.client] widgetId, actionId, key, replay in
        await gate.waitInsideRequest()
        return try await client.perform(widgetId: widgetId, actionId: actionId, idempotencyKey: key, replay: replay)
    }
    let first = Task { try await executor.start(widgetId: "macros", actionId: "refresh") }
    await gate.waitUntilEntered()
    do {
        let attempt = try onlyAttempt(fixture.restartedJournal())
        try expectExecutor(attempt.state == .uncertain, "first tap is published before the initial send")
        try await fixture.executor(journal: fixture.restartedJournal()).retry(key: attempt.key)
        try expectExecutor(ExecutorProtocol.requests().isEmpty, "concurrent replay cannot overtake the first send")
        try expectExecutor(try onlyAttempt(fixture.restartedJournal()) == attempt, "blocked replay cannot mark the first tap unknown")
        await gate.release()
        try await first.value
        let requests = ExecutorProtocol.requests()
        try expectExecutor(requests.count == 1, "only the initial send reached HTTP")
        try expectExecutor(try actionRequest(requests[0], replay: false) == attempt.key, "initial send uses the published key")
        try expectExecutor(try fixture.restartedJournal().records(widgetId: "macros").isEmpty, "initial completion removes the attempt")
        try await fixture.executor(journal: fixture.restartedJournal()).retry(key: attempt.key)
        try expectExecutor(ExecutorProtocol.requests().count == 1, "stale replay after completion sends nothing")
    } catch {
        await gate.release()
        _ = try? await first.value
        throw error
    }
}

do {
    try await completionAndFreshTaps()
    try await timeoutPendingAndReplay()
    try await initialPending()
    try await unknownOnStartAndRetry()
    try await busyResponses()
    try await initialLockPrecedesPublication()
    try await persistenceFailure()
    try await agedAndClockChangedReplays()
    try await concurrentRetryAndDismiss()
    try await retryCannotOvertakeInitialSend()
    print("ActionExecutor journal and HTTP integration tests passed")
} catch {
    fputs("ActionExecutor tests failed: \(error)\n", stderr)
    exit(1)
}
