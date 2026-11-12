import SwiftUI
import WidgetKit

struct WidgetEntryView: View {
    let entry: WidgetEntry

    @Environment(\.widgetFamily) private var family

    private var widgetURL: URL? {
        let allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        guard !entry.widgetId.isEmpty,
              let id = entry.widgetId.addingPercentEncoding(withAllowedCharacters: allowed)
        else { return nil }
        return URL(string: "robobcards://widget/\(id)")
    }

    var body: some View {
        Group {
            if let render = entry.render {
                switch family {
                case .accessoryCircular:
                    CircularWidgetView(render: render, status: entry.status)
                case .accessoryRectangular:
                    RectangularWidgetView(render: render, status: entry.status)
                case .accessoryInline:
                    InlineWidgetView(render: render, status: entry.status)
                default:
                    HomeWidgetView(render: render, widgetId: entry.widgetId, status: entry.status, family: family, attempts: entry.attempts, journalUnavailable: entry.journalUnavailable)
                }
            } else {
                EmptyWidgetView(status: entry.status, family: family, attempts: entry.attempts, journalUnavailable: entry.journalUnavailable)
            }
        }
        .widgetURL(widgetURL)
        .containerBackground(for: .widget) {
            Color(uiColor: .systemBackground)
        }
    }
}

private struct EmptyWidgetView: View {
    let status: WidgetLoadStatus?
    let family: WidgetFamily
    let attempts: [WidgetAttempt]
    let journalUnavailable: Bool

    var body: some View {
        if family == .accessoryInline {
            Text(status == .offline ? "Offline · No data" : "No data available")
        } else {
            VStack(alignment: family == .accessoryCircular ? .center : .leading, spacing: 4) {
                if family != .accessoryCircular {
                    Text("Robob Cards")
                        .font(.caption.weight(.semibold))
                }
                Text(status == .offline ? "No data available offline" : "No data available")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(family == .accessoryCircular ? .center : .leading)
                    .lineLimit(3)
                if family == .systemMedium || family == .systemLarge {
                    ActionAttemptsView(attempts: attempts, journalUnavailable: journalUnavailable)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: family == .accessoryCircular ? .center : .topLeading)
        }
    }
}

private struct HomeWidgetView: View {
    let render: WidgetRender
    let widgetId: String
    let status: WidgetLoadStatus?
    let family: WidgetFamily
    let attempts: [WidgetAttempt]
    let journalUnavailable: Bool

    private var known: [WidgetBlock] { knownBlocks(render.blocks) }
    private var isInteractive: Bool { family == .systemLarge || family == .systemMedium }
    private var blocks: [WidgetBlock] {
        Array(known.prefix(family == .systemLarge ? 5 : family == .systemMedium ? 2 : 1))
    }

    private var actions: [WidgetAction] {
        isInteractive ? render.actions : []
    }

    private var hasMore: Bool {
        known.count > blocks.count || (isInteractive && render.actions.count > actions.count)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(render.title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)

            if blocks.isEmpty {
                Text("No data available")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if isInteractive && blocks.count > 1 {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(blocks.enumerated()).filter { $0.offset.isMultiple(of: 2) }, id: \.offset) { _, block in
                            HomeBlockView(block: block, family: family)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(blocks.enumerated()).filter { !$0.offset.isMultiple(of: 2) }, id: \.offset) { _, block in
                            HomeBlockView(block: block, family: family)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                }
            } else {
                VStack(alignment: .leading, spacing: 7) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                        HomeBlockView(block: block, family: family)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            Spacer(minLength: 0)

            if !actions.isEmpty || (isInteractive && (!attempts.isEmpty || journalUnavailable)) {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 70), spacing: 4)], spacing: 4) {
                    if !journalUnavailable {
                        ForEach(Array(actions.enumerated()), id: \.offset) { _, action in
                            Button(intent: RunActionIntent(widgetId: widgetId, actionId: action.id)) {
                                Label(action.label, systemImage: action.symbol.isEmpty ? "bolt" : action.symbol)
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.75)
                                    .frame(maxWidth: .infinity)
                            }
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                            .disabled(attempts.contains { $0.actionId == action.id })
                        }
                    }
                    if isInteractive {
                        ActionAttemptsView(attempts: attempts, journalUnavailable: journalUnavailable)
                    }
                }
                .font(.caption)
            }

            WidgetFooter(asOf: render.asOf, status: status, stale: render.stale, hasMore: hasMore)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
}

private struct ActionAttemptsView: View {
    let attempts: [WidgetAttempt]
    let journalUnavailable: Bool

    var body: some View {
        if journalUnavailable {
            Text("Actions unavailable")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        ForEach(Array(attempts.sorted {
            if ($0.state == .unknown) != ($1.state == .unknown) { return $0.state == .unknown }
            return $0.createdAt < $1.createdAt
        }.prefix(1))) { attempt in
            if attempt.isRetryable {
                Button(intent: RetryActionIntent(key: attempt.key)) {
                    VStack(alignment: .leading, spacing: 0) {
                        Label("Check \(attempt.actionId)", systemImage: "arrow.clockwise")
                            .lineLimit(1)
                        Text(attempt.createdAt, format: .dateTime.hour().minute().second())
                            .font(.caption2)
                    }
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            } else {
                VStack(alignment: .leading, spacing: 1) {
                    if let message = attempt.message {
                        Text(message)
                            .lineLimit(nil)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Text("\(attempt.actionId): Check the effect before running again")
                        .lineLimit(3)
                    Button(intent: AcknowledgeActionIntent(key: attempt.key)) {
                        Text("I checked")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityLabel("I checked the effect of \(attempt.actionId)")
                }
                .font(.caption2)
            }
        }
        if attempts.count > 1 {
            Text("\(attempts.count - 1) more actions need checking")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

private struct HomeBlockView: View {
    let block: WidgetBlock
    let family: WidgetFamily

    private var listRowLimit: Int {
        switch family {
        case .systemLarge: return 8
        case .systemSmall: return 3
        default: return 2
        }
    }

    var body: some View {
        switch block {
        case .rings(let items):
            if items.isEmpty {
                NoBlockDataView()
            } else {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(items.prefix(4).enumerated()), id: \.offset) { _, item in
                        RingRow(item: item)
                    }
                    if items.count > 4 {
                        MoreContentView()
                    }
                }
            }
        case .stat(let stat):
            VStack(alignment: .leading, spacing: 2) {
                Text(stat.label)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(stat.value)
                    .font((family == .systemSmall ? Font.title2 : Font.headline).weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if let delta = stat.delta, !delta.isEmpty {
                    Text(delta)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        case .progress(let progress):
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 4) {
                    Text(progress.label)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    Text(progressText(value: progress.value, maximum: progress.max))
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .font(.caption)
                if let fraction = progressFraction(value: progress.value, maximum: progress.max) {
                    ProgressView(value: fraction)
                        .accessibilityLabel(progress.label)
                        .accessibilityValue(progressText(value: progress.value, maximum: progress.max))
                } else {
                    Text("Goal unavailable")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
        case .list(let rows):
            if rows.isEmpty {
                NoBlockDataView()
            } else {
                VStack(alignment: .leading, spacing: 3) {
                    ForEach(Array(rows.prefix(listRowLimit).enumerated()), id: \.offset) { _, row in
                        HStack(spacing: 4) {
                            Text(row.label)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                            Spacer(minLength: 2)
                            Text(row.value)
                                .monospacedDigit()
                                .lineLimit(1)
                        }
                        .font(.caption)
                        .accessibilityElement(children: .combine)
                    }
                    if rows.count > listRowLimit {
                        MoreContentView()
                    }
                }
            }
        case .sparkline(let sparkline):
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(sparkline.label)
                        .lineLimit(1)
                    Spacer(minLength: 2)
                    Text(latestValue(sparkline.points))
                        .monospacedDigit()
                        .lineLimit(1)
                }
                .font(.caption)
                if sparkline.points.contains(where: { $0.isFinite }) {
                    SparklineShape(points: sparkline.points)
                        .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                        .frame(height: family == .systemSmall ? 28 : 20)
                        .accessibilityHidden(true)
                } else {
                    NoBlockDataView()
                }
            }
            .accessibilityElement(children: .combine)
        case .unknown:
            EmptyView()
        }
    }
}

private struct RingRow: View {
    let item: RingItem

    var body: some View {
        HStack(spacing: 4) {
            RingIndicator(value: item.value, maximum: item.max)
            Text(item.label)
                .lineLimit(1)
                .layoutPriority(1)
            Spacer(minLength: 2)
            Text(numberWithUnit(item.value, unit: item.unit))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.75)
        }
        .font(.caption)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.label), \(ringDescription(item))")
    }
}

private struct RingIndicator: View {
    let value: Double
    let maximum: Double

    var body: some View {
        ZStack {
            Circle().stroke(Color.primary.opacity(0.15), lineWidth: 2.5)
            if let fraction = progressFraction(value: value, maximum: maximum), fraction > 0 {
                Circle()
                    .trim(from: 0, to: fraction)
                    .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
            if progressFraction(value: value, maximum: maximum) == nil {
                Image(systemName: "minus")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: 16, height: 16)
        .accessibilityHidden(true)
    }
}

private struct NoBlockDataView: View {
    var body: some View {
        Text("No data")
            .font(.caption)
            .foregroundStyle(.secondary)
    }
}

private struct MoreContentView: View {
    var body: some View {
        Text("More")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .accessibilityLabel("More content not shown")
    }
}

private struct WidgetFooter: View {
    let asOf: String
    let status: WidgetLoadStatus?
    let stale: Bool
    var hasMore = false

    var body: some View {
        HStack(spacing: 4) {
            if let status = widgetStatus(status: status, stale: stale) {
                Text(status)
                    .lineLimit(1)
                    .layoutPriority(2)
            }
            Text("As of \(formattedTime(asOf))")
                .lineLimit(1)
                .layoutPriority(1)
            Spacer(minLength: 2)
            if hasMore {
                Text("More")
                    .lineLimit(1)
                    .accessibilityLabel("More content not shown")
            }
        }
        .font(.caption2)
        .foregroundStyle(.secondary)
        .accessibilityElement(children: .combine)
    }
}

private struct CircularWidgetView: View {
    let render: WidgetRender
    let status: WidgetLoadStatus?

    var body: some View {
        Group {
            if let block = knownBlocks(render.blocks).first {
                switch block {
                case .rings(let items):
                    if let item = items.first {
                        CircularMetric(label: item.label, value: numberWithUnit(item.value, unit: item.unit),
                                       fraction: progressFraction(value: item.value, maximum: item.max))
                    } else {
                        NoBlockDataView()
                    }
                case .progress(let progress):
                    CircularMetric(label: progress.label, value: displayNumber(progress.value),
                                   fraction: progressFraction(value: progress.value, maximum: progress.max))
                case .stat(let stat):
                    CircularMetric(label: stat.label, value: stat.value, fraction: nil)
                case .list(let rows):
                    if let row = rows.first {
                        CircularMetric(label: row.label, value: row.value, fraction: nil)
                    } else {
                        NoBlockDataView()
                    }
                case .sparkline(let sparkline):
                    CircularMetric(label: sparkline.label, value: latestValue(sparkline.points), fraction: nil)
                case .unknown:
                    NoBlockDataView()
                }
            } else {
                NoBlockDataView()
            }
        }
        .overlay(alignment: .topTrailing) {
            if status != nil || render.stale {
                Image(systemName: status == .offline ? "wifi.slash" : status == .unavailable ? "exclamationmark.triangle" : "clock")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(render.title), \(accessibleSummary(knownBlocks(render.blocks).first)), as of \(formattedTime(render.asOf))\(statusSuffix(status: status, stale: render.stale))")
    }
}

private struct CircularMetric: View {
    let label: String
    let value: String
    let fraction: Double?

    var body: some View {
        if let fraction {
            Gauge(value: fraction) {
                Text(label)
            } currentValueLabel: {
                Text(value)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
            .gaugeStyle(.accessoryCircularCapacity)
        } else {
            VStack(spacing: 1) {
                Text(value)
                    .font(.headline)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(label)
                    .font(.caption2)
                    .lineLimit(1)
            }
        }
    }
}

private struct RectangularWidgetView: View {
    let render: WidgetRender
    let status: WidgetLoadStatus?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(render.title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
            Text(compactSummary(knownBlocks(render.blocks).first))
                .font(.caption)
                .lineLimit(1)
            WidgetFooter(asOf: render.asOf, status: status, stale: render.stale)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }
}

private struct InlineWidgetView: View {
    let render: WidgetRender
    let status: WidgetLoadStatus?

    var body: some View {
        Text("\(widgetStatus(status: status, stale: render.stale).map { "\($0) · " } ?? "")\(render.title): \(compactSummary(knownBlocks(render.blocks).first)) · As of \(formattedTime(render.asOf))")
            .lineLimit(1)
    }
}

private func knownBlocks(_ blocks: [WidgetBlock]) -> [WidgetBlock] {
    blocks.filter {
        if case .unknown = $0 { return false }
        return true
    }
}

private func compactSummary(_ block: WidgetBlock?) -> String {
    guard let block else { return "No data" }
    switch block {
    case .rings(let items):
        guard let item = items.first else { return "No data" }
        return "\(item.label) \(numberWithUnit(item.value, unit: item.unit))"
    case .stat(let stat):
        return "\(stat.label) \(stat.value)"
    case .progress(let progress):
        return "\(progress.label) \(progressText(value: progress.value, maximum: progress.max))"
    case .list(let rows):
        guard let row = rows.first else { return "No data" }
        return "\(row.label) \(row.value)"
    case .sparkline(let sparkline):
        return "\(sparkline.label) \(latestValue(sparkline.points))"
    case .unknown:
        return "No data"
    }
}

private func accessibleSummary(_ block: WidgetBlock?) -> String {
    guard case .rings(let items) = block, let item = items.first else {
        return compactSummary(block)
    }
    return "\(item.label), \(ringDescription(item))"
}

private func ringDescription(_ item: RingItem) -> String {
    let value = numberWithUnit(item.value, unit: item.unit)
    guard item.max.isFinite, item.max > 0 else { return "\(value), goal unavailable" }
    return "\(value) of \(numberWithUnit(item.max, unit: item.unit))"
}

private func progressFraction(value: Double, maximum: Double) -> Double? {
    guard value.isFinite, maximum.isFinite, maximum > 0 else { return nil }
    return min(1, max(0, value / maximum))
}

private func displayNumber(_ value: Double) -> String {
    guard value.isFinite else { return "—" }
    return value.formatted(.number.precision(.significantDigits(1...5)))
}

private func numberWithUnit(_ value: Double, unit: String) -> String {
    let number = displayNumber(value)
    return unit.isEmpty || !value.isFinite ? number : "\(number) \(unit)"
}

private func progressText(value: Double, maximum: Double) -> String {
    guard maximum.isFinite, maximum > 0 else { return displayNumber(value) }
    return "\(displayNumber(value)) / \(displayNumber(maximum))"
}

private func latestValue(_ points: [Double]) -> String {
    guard let last = points.last else { return "—" }
    return displayNumber(last)
}

private func formattedTime(_ timestamp: String) -> String {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    let standard = ISO8601DateFormatter()
    guard let date = fractional.date(from: timestamp) ?? standard.date(from: timestamp) else { return "—" }
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = .current
    formatter.dateFormat = "HH:mm"
    return formatter.string(from: date)
}

private func widgetStatus(status: WidgetLoadStatus?, stale: Bool) -> String? {
    switch (status, stale) {
    case (.offline, true): "Offline · Stale"
    case (.offline, false): "Offline"
    case (.unavailable, true): "Unavailable · Stale"
    case (.unavailable, false): "Unavailable"
    case (nil, true): "Stale"
    case (nil, false): nil
    }
}

private func statusSuffix(status: WidgetLoadStatus?, stale: Bool) -> String {
    widgetStatus(status: status, stale: stale).map { " · \($0)" } ?? ""
}

private struct SparklineShape: Shape {
    let points: [Double]

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let finite = points.filter { $0.isFinite }
        guard let low = finite.min(), let high = finite.max(), rect.width > 2, rect.height > 2 else { return path }

        // Scaling before subtraction keeps extreme, finite values from overflowing.
        let scale = max(1, max(abs(low), abs(high)))
        let bottom = low / scale
        let range = high / scale - bottom
        let plot = rect.insetBy(dx: 1, dy: 1)
        var previousWasValid = false

        for (index, value) in points.enumerated() {
            guard value.isFinite else {
                previousWasValid = false
                continue
            }
            let x = points.count == 1 ? plot.midX : plot.minX + plot.width * CGFloat(index) / CGFloat(points.count - 1)
            let normalized = range > 0 ? min(1, max(0, (value / scale - bottom) / range)) : 0.5
            let y = plot.maxY - plot.height * CGFloat(normalized)
            let point = CGPoint(x: x, y: y)
            if previousWasValid {
                path.addLine(to: point)
            } else {
                path.move(to: point)
                let nextIsValid = index + 1 < points.count && points[index + 1].isFinite
                if !nextIsValid {
                    path.addEllipse(in: CGRect(x: x - 0.75, y: y - 0.75, width: 1.5, height: 1.5))
                }
            }
            previousWasValid = true
        }
        return path
    }
}
