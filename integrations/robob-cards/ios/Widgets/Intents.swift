import AppIntents
import WidgetKit

struct WidgetChoice: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Widget")
    static var defaultQuery = WidgetChoiceQuery()

    let id: String
    let title: String

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)")
    }
}

struct WidgetChoiceQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WidgetChoice] {
        do {
            let widgets = try await WidgetClient.shared.list()
            let byID = Dictionary(widgets.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            return identifiers.compactMap { id in
                byID[id].map { WidgetChoice(id: $0.id, title: $0.title) }
            }
        } catch {
            // Keep already-configured widget IDs resolvable when the tailnet is offline.
            var choices: [WidgetChoice] = []
            for id in identifiers {
                let cached = await WidgetClient.shared.load(id: id)
                choices.append(WidgetChoice(id: id, title: cached.model?.title ?? id))
            }
            return choices
        }
    }

    func suggestedEntities() async throws -> [WidgetChoice] {
        try await WidgetClient.shared.list().map { WidgetChoice(id: $0.id, title: $0.title) }
    }

    func defaultResult() async -> WidgetChoice? {
        guard let widgets = try? await WidgetClient.shared.list() else { return nil }
        let item = widgets.first(where: { $0.id == "macros" }) ?? widgets.first
        return item.map { WidgetChoice(id: $0.id, title: $0.title) }
    }
}

struct PickWidgetIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Choose widget"
    static var description = IntentDescription("Choose what to show from Robob Widgets.")

    @Parameter(title: "Widget")
    var widget: WidgetChoice?
}

struct RunActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Run widget action"
    static var openAppWhenRun = false
    static var isDiscoverable = false

    @Parameter(title: "Widget") var widgetId: String
    @Parameter(title: "Action") var actionId: String

    init() {
        widgetId = ""
        actionId = ""
    }

    init(widgetId: String, actionId: String) {
        self.widgetId = widgetId
        self.actionId = actionId
    }

    func perform() async throws -> some IntentResult {
        defer { WidgetCenter.shared.reloadTimelines(ofKind: "RobobWidget") }
        try await ActionExecutor.shared.start(widgetId: widgetId, actionId: actionId)
        return .result()
    }
}

struct RetryActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Check widget action"
    static var openAppWhenRun = false
    static var isDiscoverable = false

    @Parameter(title: "Attempt") var attemptKey: String

    init() { attemptKey = "" }

    init(key: UUID) { attemptKey = key.uuidString }

    func perform() async throws -> some IntentResult {
        defer { WidgetCenter.shared.reloadTimelines(ofKind: "RobobWidget") }
        guard let key = UUID(uuidString: attemptKey) else { return .result() }
        try await ActionExecutor.shared.retry(key: key)
        return .result()
    }
}

struct AcknowledgeActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Confirm widget action checked"
    static var openAppWhenRun = false
    static var isDiscoverable = false

    @Parameter(title: "Attempt") var attemptKey: String

    init() { attemptKey = "" }
    init(key: UUID) { attemptKey = key.uuidString }

    func perform() async throws -> some IntentResult {
        defer { WidgetCenter.shared.reloadTimelines(ofKind: "RobobWidget") }
        guard let key = UUID(uuidString: attemptKey) else { return .result() }
        try ActionExecutor.shared.acknowledge(key: key)
        return .result()
    }
}
