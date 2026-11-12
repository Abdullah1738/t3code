import Foundation

enum WidgetSchedule {
    static func next(after now: Date, refreshMinutes: Double?) -> Date {
        let requested = refreshMinutes.flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 15
        // The server accepts any finite interval; avoid overflowing Date arithmetic.
        let remaining = max(0, Date.distantFuture.timeIntervalSince(now))
        let minutes = max(15, requested)
        if minutes >= remaining / 60 { return .distantFuture }
        return now.addingTimeInterval(minutes * 60)
    }
}
