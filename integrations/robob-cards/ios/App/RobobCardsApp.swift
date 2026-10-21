import SwiftUI

@main
struct RobobCardsApp: App {
    var body: some Scene {
        WindowGroup {
            InstalledView()
        }
    }
}

/// The container exists only so iOS will install the Messages extension; this
/// screen just tells the person it worked and where the cards appear.
struct InstalledView: View {
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
            }
            .frame(maxWidth: 560, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.top, 72)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
