import Foundation

struct ActionExecutor: Sendable {
    typealias Send = @Sendable (String, String, UUID, Bool) async throws -> WidgetActionOutcome

    static let shared = ActionExecutor(journal: .shared) { widgetId, actionId, key, replay in
        try await WidgetClient.shared.perform(
            widgetId: widgetId, actionId: actionId, idempotencyKey: key, replay: replay
        )
    }

    private let journal: ActionJournal
    private let send: Send

    init(journal: ActionJournal, send: @escaping Send) {
        self.journal = journal
        self.send = send
    }

    func start(widgetId: String, actionId: String) async throws {
        let (attempt, lock) = try journal.createLocked(widgetId: widgetId, actionId: actionId)
        defer { lock.release() }
        do {
            try await sendAction(attempt, replay: false)
        } catch WidgetClientError.unknownKey(let message) {
            try journal.markUnknown(key: attempt.key, message: message)
            throw WidgetClientError.unknownKey(message)
        }
    }

    func retry(key: UUID) async throws {
        guard let lock = try journal.tryLock(key: key) else { return }
        defer { lock.release() }
        guard let attempt = try journal.retryable(key: key) else { return }
        do {
            try await sendAction(attempt, replay: true)
        } catch WidgetClientError.unknownKey(let message) {
            try journal.markUnknown(key: attempt.key, message: message)
            throw WidgetClientError.unknownKey(message)
        }
    }

    func acknowledge(key: UUID) throws {
        guard let lock = try journal.tryLock(key: key) else { return }
        defer { lock.release() }
        _ = try journal.acknowledgeUnknown(key: key)
    }

    private func sendAction(_ attempt: WidgetAttempt, replay: Bool) async throws {
        switch try await send(attempt.widgetId, attempt.actionId, attempt.key, replay) {
        case .pending: try journal.markPending(key: attempt.key)
        case .completed: try journal.complete(key: attempt.key)
        }
    }
}
