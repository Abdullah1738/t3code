import Darwin
import Foundation

struct WidgetAttempt: Codable, Equatable, Identifiable, Sendable {
    enum State: String, Codable, Sendable {
        case uncertain
        case pending
        case unknown
    }

    let key: UUID
    let widgetId: String
    let actionId: String
    let createdAt: Date
    var state: State
    var message: String?

    var id: UUID { key }

    var isRetryable: Bool { state != .unknown }
}

enum ActionJournalError: LocalizedError {
    case unresolvedAction

    var errorDescription: String? {
        "Check the previous result before running this action again."
    }
}

// Keep the descriptor open through the request, including any journal update.
final class ActionLock: @unchecked Sendable {
    private let mutex = NSLock()
    private var descriptor: Int32?

    fileprivate init(descriptor: Int32) {
        self.descriptor = descriptor
    }

    func release() {
        mutex.lock()
        defer { mutex.unlock() }
        guard let descriptor else { return }
        self.descriptor = nil
        _ = flock(descriptor, LOCK_UN)
        _ = Darwin.close(descriptor)
    }

    deinit { release() }
}

final class ActionJournal: @unchecked Sendable {
    static let shared = ActionJournal(directory: {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
                .appendingPathComponent("Library/Application Support", isDirectory: true)
        return support.appendingPathComponent("RobobWidgetActionJournal", isDirectory: true)
    }())

    private static let journalName = "attempts.json"
    private static let journalLockName = "journal.lock"
    private let directory: URL
    private let now: () -> Date

    init(directory: URL, now: @escaping () -> Date = Date.init) {
        self.directory = directory
        self.now = now
    }

    func create(widgetId: String, actionId: String) throws -> WidgetAttempt {
        try insert(widgetId: widgetId, actionId: actionId, key: UUID())
    }

    func createLocked(widgetId: String, actionId: String) throws -> (WidgetAttempt, ActionLock) {
        let key = UUID()
        guard let lock = try tryLock(key: key) else {
            throw CocoaError(.fileWriteUnknown)
        }
        do {
            let attempt = try insert(widgetId: widgetId, actionId: actionId, key: key)
            return (attempt, lock)
        } catch {
            lock.release()
            throw error
        }
    }

    private func insert(widgetId: String, actionId: String, key: UUID) throws -> WidgetAttempt {
        try withJournal { directoryFD in
            var attempts = try read(directoryFD: directoryFD)
            // Check and insert under one lock so stale or concurrent intents cannot start twice.
            guard !attempts.contains(where: { $0.widgetId == widgetId && $0.actionId == actionId }) else {
                throw ActionJournalError.unresolvedAction
            }
            let attempt = WidgetAttempt(
                key: key, widgetId: widgetId, actionId: actionId,
                createdAt: now(), state: .uncertain
            )
            attempts.append(attempt)
            try write(attempts, directoryFD: directoryFD)
            return attempt
        }
    }

    func records(widgetId: String) throws -> [WidgetAttempt] {
        try withJournal { directoryFD in
            try read(directoryFD: directoryFD).filter { $0.widgetId == widgetId }
        }
    }

    func markPending(key: UUID) throws {
        try withJournal { directoryFD in
            var attempts = try read(directoryFD: directoryFD)
            guard let index = attempts.firstIndex(where: { $0.key == key }),
                  attempts[index].state != .pending else { return }
            attempts[index].state = .pending
            try write(attempts, directoryFD: directoryFD)
        }
    }

    func markUnknown(key: UUID, message: String) throws {
        try withJournal { directoryFD in
            var attempts = try read(directoryFD: directoryFD)
            guard let index = attempts.firstIndex(where: { $0.key == key }) else { return }
            attempts[index].state = .unknown
            attempts[index].message = message
            try write(attempts, directoryFD: directoryFD)
        }
    }

    func complete(key: UUID) throws {
        try withJournal { directoryFD in
            var attempts = try read(directoryFD: directoryFD)
            guard let index = attempts.firstIndex(where: { $0.key == key }) else { return }
            attempts.remove(at: index)
            try write(attempts, directoryFD: directoryFD)
        }
    }

    func retryable(key: UUID) throws -> WidgetAttempt? {
        try withJournal { directoryFD in
            guard let attempt = try read(directoryFD: directoryFD).first(where: { $0.key == key }),
                  attempt.isRetryable else { return nil }
            return attempt
        }
    }

    func acknowledgeUnknown(key: UUID) throws -> Bool {
        try withJournal { directoryFD in
            var attempts = try read(directoryFD: directoryFD)
            guard let index = attempts.firstIndex(where: { $0.key == key }),
                  attempts[index].state == .unknown else { return false }
            attempts.remove(at: index)
            try write(attempts, directoryFD: directoryFD)
            return true
        }
    }

    func tryLock(key: UUID) throws -> ActionLock? {
        let directoryFD = try openDirectory()
        defer { _ = Darwin.close(directoryFD) }
        let descriptor = try openLock(directoryFD: directoryFD, name: "attempt-\(key.uuidString).lock")
        var ownsDescriptor = true
        defer { if ownsDescriptor { _ = Darwin.close(descriptor) } }

        while flock(descriptor, LOCK_EX | LOCK_NB) != 0 {
            let code = errno
            if code == EINTR { continue }
            if code == EWOULDBLOCK || code == EAGAIN { return nil }
            throw Self.posixError("Lock attempt", code: code)
        }
        ownsDescriptor = false
        return ActionLock(descriptor: descriptor)
    }

    private func withJournal<T>(_ body: (Int32) throws -> T) throws -> T {
        let directoryFD = try openDirectory()
        defer { _ = Darwin.close(directoryFD) }
        let descriptor = try openLock(directoryFD: directoryFD, name: Self.journalLockName)
        defer { _ = Darwin.close(descriptor) }
        while flock(descriptor, LOCK_EX) != 0 {
            let code = errno
            if code == EINTR { continue }
            throw Self.posixError("Lock journal", code: code)
        }
        defer { _ = flock(descriptor, LOCK_UN) }
        return try body(directoryFD)
    }

    private func openDirectory() throws -> Int32 {
        guard directory.isFileURL else {
            throw NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnsupportedSchemeError)
        }
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        let descriptor = Darwin.open(directory.path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW)
        guard descriptor >= 0 else { throw Self.posixError("Open journal directory") }
        guard Darwin.fchmod(descriptor, mode_t(0o700)) == 0 else {
            let error = Self.posixError("Protect journal directory")
            _ = Darwin.close(descriptor)
            throw error
        }
        return descriptor
    }

    private func openLock(directoryFD: Int32, name: String) throws -> Int32 {
        var descriptor: Int32 = -1
        // Darwin can return ENOENT while another process creates this same lock.
        for attempt in 0..<5 {
            descriptor = Darwin.openat(directoryFD, name, O_RDWR | O_CREAT | O_CLOEXEC | O_NOFOLLOW, mode_t(0o600))
            if descriptor >= 0 { break }
            let code = errno
            guard code == ENOENT && attempt < 4 else { throw Self.posixError("Open lock", code: code) }
        }
        guard Darwin.fchmod(descriptor, mode_t(0o600)) == 0 else {
            let error = Self.posixError("Protect lock")
            _ = Darwin.close(descriptor)
            throw error
        }
        return descriptor
    }

    private func read(directoryFD: Int32) throws -> [WidgetAttempt] {
        let descriptor = Darwin.openat(directoryFD, Self.journalName, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        if descriptor < 0 {
            let code = errno
            if code == ENOENT { return [] }
            throw Self.posixError("Open journal", code: code)
        }
        let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        defer { try? handle.close() }
        let attempts = try JSONDecoder().decode([WidgetAttempt].self, from: handle.readToEnd() ?? Data())
        guard Set(attempts.map(\.key)).count == attempts.count,
              attempts.allSatisfy({ $0.createdAt.timeIntervalSinceReferenceDate.isFinite }) else {
            throw CocoaError(.fileReadCorruptFile)
        }
        return attempts
    }

    private func write(_ attempts: [WidgetAttempt], directoryFD: Int32) throws {
        let data = try JSONEncoder().encode(attempts)
        let temporaryName = ".attempts-\(UUID().uuidString).tmp"
        let descriptor = Darwin.openat(
            directoryFD, temporaryName, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC | O_NOFOLLOW, mode_t(0o600)
        )
        guard descriptor >= 0 else { throw Self.posixError("Create journal temporary file") }
        defer {
            _ = Darwin.close(descriptor)
            _ = Darwin.unlinkat(directoryFD, temporaryName, 0)
        }

        try data.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var offset = 0
            while offset < bytes.count {
                let count = Darwin.write(descriptor, base.advanced(by: offset), bytes.count - offset)
                if count < 0 {
                    let code = errno
                    if code == EINTR { continue }
                    throw Self.posixError("Write journal", code: code)
                }
                guard count > 0 else { throw Self.posixError("Write journal", code: EIO) }
                offset += count
            }
        }
        guard Darwin.fsync(descriptor) == 0 else { throw Self.posixError("Sync journal") }
        guard Darwin.renameat(directoryFD, temporaryName, directoryFD, Self.journalName) == 0 else {
            throw Self.posixError("Replace journal")
        }
        guard Darwin.fsync(directoryFD) == 0 else { throw Self.posixError("Sync journal directory") }
    }

    private static func posixError(_ operation: String, code: Int32 = errno) -> NSError {
        NSError(
            domain: NSPOSIXErrorDomain, code: Int(code),
            userInfo: [NSLocalizedDescriptionKey: "\(operation): \(String(cString: strerror(code)))"]
        )
    }
}
