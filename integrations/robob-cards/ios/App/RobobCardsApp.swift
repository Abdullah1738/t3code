import SwiftUI
import UIKit

@main
struct RobobCardsApp: App {
    var body: some Scene {
        WindowGroup {
            InstalledView()
                .onOpenURL { url in
                    // robobcards://open?url=<https page> from the Messages extension's
                    // Open in Safari button. Only card pages are opened.
                    guard url.scheme == "robobcards", url.host == "open",
                          let target = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                              .queryItems?.first(where: { $0.name == "url" })?.value,
                          let page = URL(string: target), page.scheme?.lowercased() == "https",
                          page.host?.isEmpty == false
                    else { return }
                    UIApplication.shared.open(page)
                }
        }
    }
}

/// The container exists only so iOS will install the Messages extension; this
/// screen just tells the person it worked and where the cards appear.
struct InstalledView: View {
    // Shows which build is installed, so opening the app confirms the version.
    static let versionText: String = {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Robob Cards \(version) (\(build))"
    }()

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Image("Mark")
                    .resizable()
                    .interpolation(.high)
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .accessibilityHidden(true)
                Text("Robob Cards is installed")
                    .font(.largeTitle.weight(.bold))
                    .fixedSize(horizontal: false, vertical: true)
                Text("Cards from Robob now open right inside Messages. Tap a card in your chat to see it.")
                    .font(.title3)
                    .fixedSize(horizontal: false, vertical: true)
                Text("You can close this app. Nothing else to set up.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                Text(Self.versionText)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 72)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
