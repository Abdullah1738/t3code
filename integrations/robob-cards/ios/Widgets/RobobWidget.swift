import AppIntents
import SwiftUI
import WidgetKit

struct WidgetEntry: TimelineEntry {
    let date: Date
    let widgetId: String
    let render: WidgetRender?
    let status: WidgetLoadStatus?
    let attempts: [WidgetAttempt]
    let journalUnavailable: Bool
}

struct RobobTimelineProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WidgetEntry {
        WidgetEntry(date: .now, widgetId: "macros", render: nil, status: nil, attempts: [], journalUnavailable: false)
    }

    func snapshot(for configuration: PickWidgetIntent, in context: Context) async -> WidgetEntry {
        await entry(for: configuration)
    }

    func timeline(for configuration: PickWidgetIntent, in context: Context) async -> Timeline<WidgetEntry> {
        let current = await entry(for: configuration)
        // WidgetKit determines the actual refresh time; our requested minimum is 15 minutes.
        let scheduled = WidgetSchedule.next(after: current.date, refreshMinutes: current.render?.refreshMinutes)
        // Retire archived retry buttons at their earliest expiry even if the next fetch is later.
        let nextExpiry = current.attempts.map { $0.createdAt.addingTimeInterval(600) }
            .filter { $0 > current.date }.min()
        let next = nextExpiry.map { min(scheduled, $0) } ?? scheduled
        return Timeline(entries: [current], policy: .after(next))
    }

    private func entry(for configuration: PickWidgetIntent) async -> WidgetEntry {
        let selected: String
        if let id = configuration.widget?.id {
            selected = id
        } else {
            selected = await WidgetChoiceQuery().defaultResult()?.id ?? "macros"
        }
        let result = await WidgetClient.shared.load(id: selected)
        let attempts: [WidgetAttempt]
        let journalUnavailable: Bool
        do {
            attempts = try ActionJournal.shared.records(widgetId: selected)
            journalUnavailable = false
        } catch {
            attempts = []
            journalUnavailable = true
        }
        return WidgetEntry(date: .now, widgetId: selected, render: result.model, status: result.status, attempts: attempts, journalUnavailable: journalUnavailable)
    }
}

@main
struct RobobWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "RobobWidget", intent: PickWidgetIntent.self, provider: RobobTimelineProvider()) { entry in
            WidgetEntryView(entry: entry)
        }
        .configurationDisplayName("Robob Cards")
        .description("Choose a widget from Robob.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
