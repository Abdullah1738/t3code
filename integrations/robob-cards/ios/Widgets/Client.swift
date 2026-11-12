import Foundation

enum WidgetClientError: LocalizedError {
    case invalidID
    case invalidResponse
    case httpStatus(Int)
    case httpStatusWithMessage(Int, String)
    case actionFailed(String)
    case unknownKey(String)
    case busy

    var errorDescription: String? {
        switch self {
        case .invalidID: return "Invalid widget or action ID"
        case .invalidResponse: return "Invalid widget response"
        case .httpStatus(let status): return "Widget server returned HTTP \(status)"
        case .httpStatusWithMessage(let status, let message): return "Widget server returned HTTP \(status): \(message)"
        case .actionFailed(let message): return message
        case .unknownKey(let message): return message
        case .busy: return "Widget server is busy. Use Check to confirm the result."
        }
    }
}

enum WidgetActionOutcome: Equatable, Sendable {
    case pending
    case completed
}

final class WidgetClient: Sendable {
    static let shared = WidgetClient()

    private let baseURL: URL
    private let session: URLSession
    private let cacheDirectory: URL?

    init(
        baseURL: URL = URL(string: "https://widgets.tail")!,
        session: URLSession = .shared,
        cacheDirectory: URL? = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)
            .first?.appendingPathComponent("RobobWidgets", isDirectory: true)
    ) {
        self.baseURL = baseURL
        self.session = session
        self.cacheDirectory = cacheDirectory
    }

    func list() async throws -> [WidgetSummary] {
        let data = try await get(path: ["api", "widgets"])
        let result = try JSONDecoder().decode(WidgetList.self, from: data)
        var ids = Set<String>()
        guard result.widgets.allSatisfy({
            Self.validID($0.id) && $0.refreshMinutes.isFinite && $0.refreshMinutes > 0 && ids.insert($0.id).inserted
        }) else {
            throw WidgetClientError.invalidResponse
        }
        return result.widgets
    }

    func load(id: String) async -> WidgetLoad {
        guard Self.validID(id) else { return WidgetLoad(model: nil, status: .unavailable) }
        do {
            let data = try await get(path: ["api", "widgets", id])
            let model = try decodeRender(data, id: id)
            cache(data, id: id)
            return WidgetLoad(model: model, status: nil)
        } catch {
            let status: WidgetLoadStatus = error is URLError ? .offline : .unavailable
            return WidgetLoad(model: cachedRender(id: id), status: status)
        }
    }

    func perform(widgetId: String, actionId: String, idempotencyKey: UUID, replay: Bool = false) async throws -> WidgetActionOutcome {
        guard Self.validID(widgetId), Self.validID(actionId) else { throw WidgetClientError.invalidID }
        let (data, response) = try await request(
            path: ["api", "widgets", widgetId, "actions", actionId], actionKey: idempotencyKey, replay: replay
        )
        guard (200...299).contains(response.statusCode) else {
            if response.statusCode == 409,
               let body = try? JSONDecoder().decode(UnknownKeyResponse.self, from: data),
               !body.ok, body.error == "unknown_key", !body.replayable {
                throw WidgetClientError.unknownKey(body.message)
            }
            if response.statusCode == 503, !replay,
               let body = try? JSONDecoder().decode(BusyResponse.self, from: data), body.error == "busy" {
                throw WidgetClientError.busy
            }
            if let body = try? JSONDecoder().decode(ActionErrorResponse.self, from: data),
               let message = body.error ?? body.message {
                throw WidgetClientError.httpStatusWithMessage(response.statusCode, message)
            }
            throw WidgetClientError.httpStatus(response.statusCode)
        }
        guard response.statusCode == 200 || response.statusCode == 202 else { throw WidgetClientError.invalidResponse }
        let result = try JSONDecoder().decode(ActionResponse.self, from: data)
        guard result.ok else { throw WidgetClientError.actionFailed(result.error ?? result.message ?? "Widget action failed") }
        if response.statusCode == 202 {
            guard result.pending == true else { throw WidgetClientError.invalidResponse }
            return .pending
        }
        // An explicit pending flag never proves the action completed, even on 200.
        return result.pending == true ? .pending : .completed
    }

    private struct ActionResponse: Decodable {
        let ok: Bool
        let message: String?
        let error: String?
        let pending: Bool?
    }

    private struct ActionErrorResponse: Decodable {
        let message: String?
        let error: String?
    }

    private struct UnknownKeyResponse: Decodable {
        let ok: Bool
        let error: String
        let replayable: Bool
        let message: String
    }

    private struct BusyResponse: Decodable {
        let error: String
    }

    private static func validID(_ id: String) -> Bool {
        let bytes = id.utf8
        return (1...40).contains(bytes.count) && bytes.allSatisfy {
            (97...122).contains($0) || (48...57).contains($0) || $0 == 45
        }
    }

    private func get(path: [String]) async throws -> Data {
        let (data, response) = try await request(path: path)
        guard (200...299).contains(response.statusCode) else { throw WidgetClientError.httpStatus(response.statusCode) }
        return data
    }

    private func request(path: [String], actionKey: UUID? = nil, replay: Bool = false) async throws -> (Data, HTTPURLResponse) {
        let url = path.reduce(baseURL) { $0.appendingPathComponent($1) }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10)
        if let actionKey {
            request.httpMethod = "POST"
            request.setValue(actionKey.uuidString, forHTTPHeaderField: "Idempotency-Key")
            if replay { request.setValue("1", forHTTPHeaderField: "Idempotency-Replay") }
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw WidgetClientError.invalidResponse }
        return (data, response)
    }

    private func decodeRender(_ data: Data, id: String) throws -> WidgetRender {
        let model = try JSONDecoder().decode(WidgetRender.self, from: data)
        var actionIDs = Set<String>()
        guard model.id == id, model.refreshMinutes.isFinite, model.refreshMinutes > 0,
              model.actions.allSatisfy({ Self.validID($0.id) && actionIDs.insert($0.id).inserted }) else {
            throw WidgetClientError.invalidResponse
        }
        return model
    }

    private func cacheURL(id: String) -> URL? {
        cacheDirectory?.appendingPathComponent(id, isDirectory: false).appendingPathExtension("json")
    }

    private func cache(_ data: Data, id: String) {
        guard let cacheDirectory, let url = cacheURL(id: id) else { return }
        do {
            try FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
        } catch {
            // A cache write failure must not hide a successful live response.
        }
    }

    private func cachedRender(id: String) -> WidgetRender? {
        guard let url = cacheURL(id: id), let data = try? Data(contentsOf: url) else { return nil }
        return try? decodeRender(data, id: id)
    }
}
