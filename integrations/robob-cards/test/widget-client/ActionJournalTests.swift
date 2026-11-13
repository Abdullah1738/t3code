import Foundation

enum JournalTestFailure: Error, CustomStringConvertible {
    case failed(String)

    var description: String {
        switch self { case .failed(let message): return message }
    }
}

func expectJournal(_ condition: @autoclosure () throws -> Bool, _ message: String) throws {
    if try !condition() { throw JournalTestFailure.failed(message) }
}

func expectJournalThrows(_ message: String, _ body: () throws -> Void) throws {
    do {
        try body()
        throw JournalTestFailure.failed("\(message): expected an error")
    } catch let failure as JournalTestFailure {
        throw failure
    } catch {
        // Expected.
    }
}

final class TestClock {
    var date = Date(timeIntervalSince1970: 1_800_000_000)
}

func makeTestDirectory() throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("action-journal-tests-\(UUID())", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

func permissions(_ url: URL) throws -> Int {
    let attributes = try FileManager.default.attributesOfItem(atPath: url.path)
    return (attributes[.posixPermissions] as? NSNumber)?.intValue ?? -1
}

func lifecycleTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let clock = TestClock()
    let journal = ActionJournal(directory: directory, now: { clock.date })
    var sends: [WidgetAttempt] = []

    func send(_ attempt: WidgetAttempt, journal: ActionJournal) throws {
        guard let lock = try journal.tryLock(key: attempt.key) else {
            throw JournalTestFailure.failed("attempt already in flight")
        }
        defer { lock.release() }
        // The action sent to the network must already be persisted.
        let persisted = try journal.records(widgetId: attempt.widgetId)
        try expectJournal(persisted.contains(attempt), "persist before sending")
        sends.append(attempt)
    }

    let first = try journal.create(widgetId: "macros", actionId: "refresh")
    try expectJournal(first.state == .uncertain && first.id == first.key, "new attempt identity and state")
    try expectJournal(first.createdAt == clock.date, "creation timestamp")
    try send(first, journal: journal)
    try expectJournalThrows("unresolved action blocks another tap") {
        _ = try journal.create(widgetId: "macros", actionId: "refresh")
    }
    let second = try journal.create(widgetId: "macros", actionId: "other")
    try expectJournal(first.key != second.key, "independent taps get distinct keys")
    try send(second, journal: journal)
    let other = try journal.create(widgetId: "other", actionId: "refresh")
    let restarted = ActionJournal(directory: directory, now: { clock.date })
    let loaded = try restarted.records(widgetId: "macros")
    try expectJournal(loaded == [first, second], "unresolved actions survive a new journal instance")
    try expectJournal(try restarted.records(widgetId: "other") == [other], "records are widget scoped")

    // A manual retry after process recreation uses the recorded IDs and UUID.
    guard let retry = try restarted.retryable(key: first.key) else {
        throw JournalTestFailure.failed("uncertain attempt should be retryable")
    }
    try send(retry, journal: restarted)
    try expectJournal(sends[0] == sends[2], "retry sends exact original identity")
    try restarted.markPending(key: first.key)
    let pending = try restarted.records(widgetId: "macros")
    try expectJournal(pending[0].state == .pending && pending[1].state == .uncertain, "202 marks only its own attempt pending")
    let pendingRetry = try restarted.retryable(key: first.key)
    try expectJournal(pendingRetry?.state == .pending && pendingRetry?.key == first.key, "pending check uses the same key")
    try restarted.markPending(key: UUID())
    try restarted.complete(key: UUID())
    try expectJournal(try restarted.records(widgetId: "macros") == pending, "unknown mutations do not change other attempts")
    try restarted.complete(key: first.key)
    try expectJournal(try restarted.retryable(key: first.key) == nil, "completed attempt cannot be retried")
    try expectJournal(try restarted.records(widgetId: "macros") == [second], "completion removes only the exact key")
    try expectJournal(try restarted.records(widgetId: "other") == [other], "completion does not affect another widget")

    let json = try Data(contentsOf: directory.appendingPathComponent("attempts.json"))
    guard let object = try JSONSerialization.jsonObject(with: json) as? [[String: Any]], let item = object.first else {
        throw JournalTestFailure.failed("journal JSON shape")
    }
    try expectJournal(Set(item.keys) == Set(["key", "widgetId", "actionId", "createdAt", "state"]), "journal stores only action identity and state")
    try expectJournal(try permissions(directory) == 0o700, "journal directory is private")
    try expectJournal(try permissions(directory.appendingPathComponent("attempts.json")) == 0o600, "journal is private")
    try expectJournal(try permissions(directory.appendingPathComponent("journal.lock")) == 0o600, "journal lock is private")
    try expectJournal(try permissions(directory.appendingPathComponent("attempt-\(first.key.uuidString).lock")) == 0o600, "attempt lock is private")
}

func createLockedTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = ActionJournal(directory: directory)
    let (attempt, lock) = try journal.createLocked(widgetId: "macros", actionId: "refresh")
    let observer = ActionJournal(directory: directory)
    try expectJournal(try observer.records(widgetId: "macros") == [attempt], "attempt is persisted before it is sent")
    try expectJournal(try observer.tryLock(key: attempt.key) == nil, "retry cannot overtake initial send")
    lock.release()
    guard let retry = try observer.tryLock(key: attempt.key) else { throw JournalTestFailure.failed("retry should lock after initial send") }
    retry.release()
    try expectJournal(try observer.retryable(key: attempt.key)?.key == attempt.key, "retry uses original key")
}

func clockIndependentReplayTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let clock = TestClock()
    let journal = ActionJournal(directory: directory, now: { clock.date })
    let first = try journal.create(widgetId: "macros", actionId: "refresh")
    try expectJournal(try journal.retryable(key: first.key) == first, "retry allowed at creation")
    try expectJournal(try !journal.acknowledgeUnknown(key: UUID()), "missing attempt cannot be acknowledged")
    for offset in [-3_600.0, 599.999, 600, 601, 86_400] {
        clock.date = first.createdAt.addingTimeInterval(offset)
        let restarted = ActionJournal(directory: directory, now: { clock.date })
        try expectJournal(try restarted.retryable(key: first.key) == first, "client clock does not veto replay-only checks")
        try expectJournal(try !restarted.acknowledgeUnknown(key: first.key), "client clock does not allow clearing an uncertain attempt")
        try expectJournalThrows("client clock does not allow another first tap") {
            _ = try restarted.createLocked(widgetId: "macros", actionId: "refresh")
        }
    }
    let restarted = ActionJournal(directory: directory, now: { clock.date })
    try restarted.markPending(key: first.key)
    try expectJournal(try restarted.retryable(key: first.key)?.state == .pending, "aged pending attempt remains checkable")
    try expectJournal(try !restarted.acknowledgeUnknown(key: first.key), "aged pending attempt cannot be cleared")
}

func unknownTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = ActionJournal(directory: directory)
    let first = try journal.create(widgetId: "macros", actionId: "refresh")
    let other = try journal.create(widgetId: "macros", actionId: "other")
    try expectJournal(first.message == nil, "new attempt omits a message")
    try journal.markUnknown(key: first.key, message: "Server cannot confirm this action")
    try journal.markUnknown(key: UUID(), message: "ignored")
    let restarted = ActionJournal(directory: directory)
    let records = try restarted.records(widgetId: "macros")
    try expectJournal(records.count == 2 && records[0].key == first.key && records[0].state == .unknown && records[0].message == "Server cannot confirm this action" && records[1] == other, "unknown state and message persist without changing another attempt")
    try expectJournal(try restarted.retryable(key: first.key) == nil, "unknown action cannot be retried")
    try expectJournalThrows("unknown action blocks new first tap") {
        _ = try restarted.createLocked(widgetId: "macros", actionId: "refresh")
    }
    try expectJournal(try restarted.acknowledgeUnknown(key: first.key), "unknown action can be acknowledged")
    try expectJournal(try restarted.records(widgetId: "macros") == [other], "dismissing unknown leaves the other attempt")
    let (fresh, lock) = try restarted.createLocked(widgetId: "macros", actionId: "refresh")
    defer { lock.release() }
    try expectJournal(fresh.key != first.key, "acknowledgement permits a distinct new first tap")
}

func concurrentSameActionTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let mutex = NSLock()
    var started: [UUID] = []
    var failures: [String] = []
    DispatchQueue.concurrentPerform(iterations: 16) { _ in
        do {
            let journal = ActionJournal(directory: directory)
            let (attempt, lock) = try journal.createLocked(widgetId: "macros", actionId: "refresh")
            defer { lock.release() }
            mutex.lock()
            started.append(attempt.key)
            mutex.unlock()
        } catch ActionJournalError.unresolvedAction {
        } catch {
            mutex.lock()
            failures.append(String(describing: error))
            mutex.unlock()
        }
    }
    try expectJournal(failures.isEmpty, "same-action creation errors: \(failures)")
    try expectJournal(started.count == 1, "only one concurrent first tap is admitted")
    let records = try ActionJournal(directory: directory).records(widgetId: "macros")
    try expectJournal(records.map(\.key) == started, "concurrent first taps retain only the admitted key")
}

func failureTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("not-a-directory")
    try Data("file".utf8).write(to: file)
    let journal = ActionJournal(directory: file.appendingPathComponent("journal"))
    var dispatched = false
    try expectJournalThrows("persistence failure prevents dispatch") {
        let attempt = try journal.create(widgetId: "macros", actionId: "refresh")
        _ = attempt
        dispatched = true
    }
    try expectJournal(!dispatched, "no operation launched after persistence failure")

    let corruptDirectory = directory.appendingPathComponent("corrupt", isDirectory: true)
    let corruptJournal = ActionJournal(directory: corruptDirectory)
    let attempt = try corruptJournal.create(widgetId: "macros", actionId: "refresh")
    let journalFile = corruptDirectory.appendingPathComponent("attempts.json")
    try Data("not json".utf8).write(to: journalFile)
    try expectJournalThrows("corrupt journal blocks creation") { _ = try corruptJournal.create(widgetId: "macros", actionId: "refresh") }
    try expectJournalThrows("corrupt journal blocks retry") { _ = try corruptJournal.retryable(key: attempt.key) }
    try expectJournal(try Data(contentsOf: journalFile) == Data("not json".utf8), "corrupt data is not overwritten")
}

func concurrentFirstLockTests() throws {
    let root = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: root) }
    let stateLock = NSLock()
    var failures: [String] = []
    for round in 0..<40 {
        let directory = root.appendingPathComponent("round-\(round)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let key = UUID()
        var holders = 0
        var acquisitions = 0
        DispatchQueue.concurrentPerform(iterations: 32) { _ in
            do {
                let journal = ActionJournal(directory: directory)
                guard let lock = try journal.tryLock(key: key) else { return }
                stateLock.lock()
                holders += 1
                acquisitions += 1
                if holders != 1 { failures.append("round \(round): overlapping holders") }
                stateLock.unlock()
                stateLock.lock()
                holders -= 1
                stateLock.unlock()
                lock.release()
            } catch {
                stateLock.lock()
                failures.append("round \(round): \(error)")
                stateLock.unlock()
            }
        }
        try expectJournal(acquisitions > 0, "first lock has an owner in round \(round)")
    }
    try expectJournal(failures.isEmpty, "concurrent first lock creation: \(failures)")
}

func sameProcessTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = ActionJournal(directory: directory)
    let key = UUID()
    guard let held = try journal.tryLock(key: key) else { throw JournalTestFailure.failed("first lock") }
    try expectJournal(try journal.tryLock(key: key) == nil, "second descriptor cannot lock same attempt")
    guard let independent = try journal.tryLock(key: UUID()) else { throw JournalTestFailure.failed("independent attempt lock") }
    independent.release()
    held.release()
    held.release()
    guard let again = try journal.tryLock(key: key) else { throw JournalTestFailure.failed("released lock should be available") }
    again.release()
    do {
        guard let automatic = try journal.tryLock(key: key) else { throw JournalTestFailure.failed("lock for deinit") }
        _ = automatic
    }
    guard let afterDeinit = try journal.tryLock(key: key) else { throw JournalTestFailure.failed("deinit releases lock") }
    afterDeinit.release()

    let failuresLock = NSLock()
    var failures: [String] = []
    DispatchQueue.concurrentPerform(iterations: 60) { index in
        do {
            let instance = ActionJournal(directory: directory)
            _ = try instance.create(widgetId: "concurrent", actionId: "action-\(index)")
        } catch {
            failuresLock.lock()
            failures.append(String(describing: error))
            failuresLock.unlock()
        }
    }
    try expectJournal(failures.isEmpty, "threaded creates: \(failures)")
    let records = try journal.records(widgetId: "concurrent")
    try expectJournal(records.count == 60 && Set(records.map(\.key)).count == 60, "no same-process lost writes")
}

struct Child {
    let process: Process
    let input: Pipe
    let output: Pipe

    func line() throws -> String {
        var data = Data()
        while let byte = try output.fileHandleForReading.read(upToCount: 1), !byte.isEmpty {
            if byte[byte.startIndex] == 10 { return String(decoding: data, as: UTF8.self) }
            data.append(byte)
        }
        throw JournalTestFailure.failed("worker ended before output: \(String(decoding: data, as: UTF8.self))")
    }

    func sendLine(_ text: String) throws {
        try input.fileHandleForWriting.write(contentsOf: Data("\(text)\n".utf8))
    }

    func finish() throws {
        try? input.fileHandleForWriting.close()
        process.waitUntilExit()
        try expectJournal(process.terminationReason == .exit && process.terminationStatus == 0, "worker exited successfully")
    }
}

func child(_ arguments: [String]) throws -> Child {
    guard let source = ProcessInfo.processInfo.environment["ACTION_JOURNAL_TEST_SOURCE"] else {
        throw JournalTestFailure.failed("missing concatenated worker source")
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/swift")
    process.arguments = [source] + arguments
    let input = Pipe()
    let output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    try process.run()
    return Child(process: process, input: input, output: output)
}

func crossProcessTests() throws {
    let directory = try makeTestDirectory()
    defer { try? FileManager.default.removeItem(at: directory) }
    let journal = ActionJournal(directory: directory)
    let key = UUID()
    let holder = try child(["--hold", directory.path, key.uuidString])
    try expectJournal(try holder.line() == "locked", "child acquired attempt lock")
    try expectJournal(try journal.tryLock(key: key) == nil, "child lock excludes parent")
    holder.process.terminate()
    holder.process.waitUntilExit()
    guard let recovered = try journal.tryLock(key: key) else { throw JournalTestFailure.failed("process death releases attempt lock") }
    recovered.release()

    let a = try child(["--create", directory.path, "a"])
    let b = try child(["--create", directory.path, "b"])
    try expectJournal(try a.line() == "ready", "first writer ready")
    try expectJournal(try b.line() == "ready", "second writer ready")
    try a.sendLine("go")
    try b.sendLine("go")
    for index in 0..<30 {
        _ = try journal.create(widgetId: "processes", actionId: "parent-\(index)")
    }
    try a.finish()
    try b.finish()
    let records = try journal.records(widgetId: "processes")
    try expectJournal(records.count == 90 && Set(records.map(\.key)).count == 90, "no cross-process lost writes")
    try expectJournal(Set(records.map(\.actionId)).count == 90, "all three writers persisted their own actions")
}

let arguments = CommandLine.arguments
if arguments.count >= 4 && arguments[1] == "--hold" {
    let journal = ActionJournal(directory: URL(fileURLWithPath: arguments[2], isDirectory: true))
    guard let key = UUID(uuidString: arguments[3]), let lock = try journal.tryLock(key: key) else {
        throw JournalTestFailure.failed("child could not acquire lock")
    }
    print("locked")
    fflush(stdout)
    _ = readLine()
    lock.release()
} else if arguments.count >= 4 && arguments[1] == "--create" {
    let journal = ActionJournal(directory: URL(fileURLWithPath: arguments[2], isDirectory: true))
    print("ready")
    fflush(stdout)
    guard readLine() == "go" else { throw JournalTestFailure.failed("worker start signal") }
    for index in 0..<30 {
        _ = try journal.create(widgetId: "processes", actionId: "\(arguments[3])-\(index)")
    }
} else if arguments.count >= 2 && arguments[1] == "--first-lock-race" {
    try concurrentFirstLockTests()
    print("Concurrent first-lock tests passed")
} else {
    try lifecycleTests()
    try createLockedTests()
    try clockIndependentReplayTests()
    try unknownTests()
    try concurrentSameActionTests()
    try failureTests()
    try concurrentFirstLockTests()
    try sameProcessTests()
    try crossProcessTests()
    print("ActionJournal lifecycle, clock, failure and concurrency tests passed")
}
