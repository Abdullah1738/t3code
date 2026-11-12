import Foundation

struct WidgetList: Codable, Equatable {
    let widgets: [WidgetSummary]
}

struct WidgetSummary: Codable, Equatable, Identifiable {
    let id: String
    let title: String
    let families: [String]
    let refreshMinutes: Double
}

struct WidgetRender: Codable, Equatable {
    let id: String
    let title: String
    let asOf: String
    let refreshMinutes: Double
    let blocks: [WidgetBlock]
    let actions: [WidgetAction]
    let stale: Bool

    init(
        id: String,
        title: String,
        asOf: String,
        refreshMinutes: Double,
        blocks: [WidgetBlock],
        actions: [WidgetAction],
        stale: Bool = false
    ) {
        self.id = id
        self.title = title
        self.asOf = asOf
        self.refreshMinutes = refreshMinutes
        self.blocks = blocks
        self.actions = actions
        self.stale = stale
    }

    private enum CodingKeys: String, CodingKey {
        case id, title, asOf, refreshMinutes, blocks, actions, stale
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        title = try container.decode(String.self, forKey: .title)
        asOf = try container.decode(String.self, forKey: .asOf)
        refreshMinutes = try container.decode(Double.self, forKey: .refreshMinutes)
        blocks = try container.decode([WidgetBlock].self, forKey: .blocks).filter { $0 != .unknown }
        actions = try container.decode([WidgetAction].self, forKey: .actions)
        stale = try container.decodeIfPresent(Bool.self, forKey: .stale) ?? false
    }
}

struct WidgetAction: Codable, Equatable, Identifiable {
    let id: String
    let label: String
    let symbol: String
}

struct RingItem: Codable, Equatable {
    let label: String
    let value: Double
    let max: Double
    let unit: String
}

struct StatBlock: Codable, Equatable {
    let label: String
    let value: String
    let delta: String?
}

struct ProgressBlock: Codable, Equatable {
    let label: String
    let value: Double
    let max: Double
}

struct ListRow: Codable, Equatable {
    let label: String
    let value: String
}

struct SparklineBlock: Codable, Equatable {
    let label: String
    let points: [Double]
}

enum WidgetBlock: Codable, Equatable {
    case rings([RingItem])
    case stat(StatBlock)
    case progress(ProgressBlock)
    case list([ListRow])
    case sparkline(SparklineBlock)
    case unknown

    private enum CodingKeys: String, CodingKey {
        case type, items, label, value, delta, max, rows, points
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        switch try container.decode(String.self, forKey: .type) {
        case "rings":
            self = .rings(try container.decode([RingItem].self, forKey: .items))
        case "stat":
            self = .stat(try StatBlock(from: decoder))
        case "progress":
            self = .progress(try ProgressBlock(from: decoder))
        case "list":
            self = .list(try container.decode([ListRow].self, forKey: .rows))
        case "sparkline":
            self = .sparkline(try SparklineBlock(from: decoder))
        default:
            self = .unknown
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .rings(let items):
            try container.encode("rings", forKey: .type)
            try container.encode(items, forKey: .items)
        case .stat(let block):
            try container.encode("stat", forKey: .type)
            try block.encode(to: encoder)
        case .progress(let block):
            try container.encode("progress", forKey: .type)
            try block.encode(to: encoder)
        case .list(let rows):
            try container.encode("list", forKey: .type)
            try container.encode(rows, forKey: .rows)
        case .sparkline(let block):
            try container.encode("sparkline", forKey: .type)
            try block.encode(to: encoder)
        case .unknown:
            try container.encode("unknown", forKey: .type)
        }
    }
}

enum WidgetLoadStatus {
    case offline
    case unavailable
}

struct WidgetLoad {
    let model: WidgetRender?
    let status: WidgetLoadStatus?
}
