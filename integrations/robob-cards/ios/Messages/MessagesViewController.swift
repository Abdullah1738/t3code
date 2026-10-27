import Messages
import UIKit
import WebKit
import os

/// Opens the page a Robob card points at. The card's MSMessage.url is the whole
/// payload, so the extension needs no storage, entitlements or network code of
/// its own beyond the web view loading that page.
final class MessagesViewController: MSMessagesAppViewController, WKNavigationDelegate, WKUIDelegate {
    private let webView: WKWebView = {
        let configuration = WKWebViewConfiguration()
        configuration.allowsInlineMediaPlayback = true
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.isOpaque = false
        view.backgroundColor = .systemBackground
        view.scrollView.contentInsetAdjustmentBehavior = .always
        return view
    }()
    private let note = UILabel()
    private let retry = UIButton(type: .system)
    private let safari = UIButton(type: .system)
    private let spinner = UIActivityIndicatorView(style: .medium)
    // Expanded view only: a bar under the page that always offers Safari, so a
    // page the web view can't draw never leaves an empty sheet.
    private let bar = UIView()
    private let barSafari = UIButton(type: .system)
    private let versionLabel = UILabel()
    // Bundle.main is the extension's own bundle here, so this is the installed build.
    private static let versionText: String = {
        let info = Bundle.main.infoDictionary
        let version = info?["CFBundleShortVersionString"] as? String ?? "?"
        let build = info?["CFBundleVersion"] as? String ?? "?"
        return "Robob Cards \(version) (\(build))"
    }()
    private var loadTimer: Timer?
    // Only callbacks from the newest navigation may change the sheet. A load
    // that was replaced (another card, Try again) reports -999 late.
    private var currentNavigation: WKNavigation?
    private var crashReloads = 0
    private static let loadTimeout: TimeInterval = 15
    private static let log = Logger(subsystem: "com.abdullah.robob.cards", category: "card")
    // Compact (the app drawer) and transcript (the live bubble in the chat) are
    // previews; a tap anywhere asks Messages for the full-height view so the
    // page can be used. From the transcript Messages opens a new expanded
    // instance, which loads the same selected message.
    private let expandOverlay = UIControl()
    private var cardURL: URL?
    private var barShown: NSLayoutConstraint!

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemBackground

        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(webView)

        expandOverlay.translatesAutoresizingMaskIntoConstraints = false
        expandOverlay.accessibilityLabel = "Open card"
        expandOverlay.addTarget(self, action: #selector(expand), for: .touchUpInside)
        view.addSubview(expandOverlay)

        note.translatesAutoresizingMaskIntoConstraints = false
        note.numberOfLines = 0
        note.font = .preferredFont(forTextStyle: .body)
        note.adjustsFontForContentSizeCategory = true
        note.textColor = .label
        view.addSubview(note)

        retry.translatesAutoresizingMaskIntoConstraints = false
        retry.setTitle("Try again", for: .normal)
        retry.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        retry.addTarget(self, action: #selector(reload), for: .touchUpInside)
        view.addSubview(retry)

        safari.translatesAutoresizingMaskIntoConstraints = false
        safari.setTitle("Open in Safari", for: .normal)
        safari.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        safari.addTarget(self, action: #selector(openInSafari), for: .touchUpInside)
        view.addSubview(safari)

        bar.translatesAutoresizingMaskIntoConstraints = false
        bar.backgroundColor = .secondarySystemBackground
        view.addSubview(bar)
        barSafari.translatesAutoresizingMaskIntoConstraints = false
        barSafari.setTitle("Open in Safari", for: .normal)
        barSafari.titleLabel?.font = .preferredFont(forTextStyle: .subheadline)
        barSafari.addTarget(self, action: #selector(openInSafari), for: .touchUpInside)
        bar.addSubview(barSafari)
        versionLabel.translatesAutoresizingMaskIntoConstraints = false
        versionLabel.font = .preferredFont(forTextStyle: .caption2)
        versionLabel.textColor = .secondaryLabel
        versionLabel.text = Self.versionText
        versionLabel.accessibilityIdentifier = "robob-cards-version"
        bar.addSubview(versionLabel)

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)

        let guide = view.safeAreaLayoutGuide
        let pageBottom = webView.bottomAnchor.constraint(equalTo: view.bottomAnchor)
        pageBottom.priority = .defaultLow
        barShown = webView.bottomAnchor.constraint(equalTo: bar.topAnchor)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            pageBottom,
            bar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bar.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            versionLabel.topAnchor.constraint(equalTo: bar.topAnchor, constant: 6),
            versionLabel.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            barSafari.topAnchor.constraint(equalTo: versionLabel.bottomAnchor, constant: 2),
            barSafari.centerXAnchor.constraint(equalTo: bar.centerXAnchor),
            barSafari.bottomAnchor.constraint(equalTo: guide.bottomAnchor, constant: -6),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            expandOverlay.topAnchor.constraint(equalTo: view.topAnchor),
            expandOverlay.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            expandOverlay.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            expandOverlay.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            note.leadingAnchor.constraint(equalTo: guide.leadingAnchor, constant: 24),
            note.trailingAnchor.constraint(equalTo: guide.trailingAnchor, constant: -24),
            note.topAnchor.constraint(equalTo: guide.topAnchor, constant: 24),
            retry.leadingAnchor.constraint(equalTo: note.leadingAnchor),
            retry.topAnchor.constraint(equalTo: note.bottomAnchor, constant: 12),
            safari.leadingAnchor.constraint(equalTo: retry.trailingAnchor, constant: 24),
            safari.centerYAnchor.constraint(equalTo: retry.centerYAnchor),
            spinner.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: guide.centerYAnchor),
        ])
        bar.isHidden = true
        showNote("Tap a Robob card in this chat to open it here.", canRetry: false)
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        open(conversation.selectedMessage)
    }

    override func didSelect(_ message: MSMessage, conversation: MSConversation) {
        super.didSelect(message, conversation: conversation)
        open(message)
    }

    override func didTransition(to presentationStyle: MSMessagesAppPresentationStyle) {
        super.didTransition(to: presentationStyle)
        layout(for: presentationStyle)
    }

    private func open(_ message: MSMessage?) {
        defer { layout(for: presentationStyle) }
        guard let message else {
            Self.log.info("opened without a selected message")
            return
        }
        guard let url = message.url, Self.isCardPage(url) else {
            cardURL = nil
            showNote("This card has no secure link to open.", canRetry: false)
            return
        }
        // Only a page on screen counts as already open. After a timeout or
        // crash note the web view is hidden, so selecting the card again reloads.
        if url == cardURL, !webView.isHidden { return }
        cardURL = url
        crashReloads = 0
        load(url)
    }

    private func load(_ url: URL) {
        Self.log.info("loading \(url.host ?? "-", privacy: .public)")
        note.isHidden = true
        retry.isHidden = true
        safari.isHidden = true
        webView.isHidden = false
        spinner.startAnimating()
        currentNavigation = webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Self.loadTimeout))
    }

    // Every main-frame navigation (the card, an https link tapped in the page, a
    // client-side redirect) arms the timer and becomes the one callbacks are
    // checked against. Arming only in load(_:) left those later navigations
    // unguarded, and a cancelled predecessor could clear the timer for nothing.
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        currentNavigation = navigation
        spinner.startAnimating()
        armLoadTimer()
    }

    private func armLoadTimer() {
        loadTimer?.invalidate()
        loadTimer = Timer.scheduledTimer(withTimeInterval: Self.loadTimeout, repeats: false) { [weak self] _ in
            Self.log.error("load timed out")
            self?.showNote("This card is taking too long to load.", canRetry: true)
        }
    }

    private func layout(for style: MSMessagesAppPresentationStyle) {
        let preview = (style == .compact || style == .transcript) && cardURL != nil
        expandOverlay.isHidden = !preview
        webView.scrollView.isScrollEnabled = !preview
        // The bar is always shown when expanded, so an empty sheet still shows
        // which build drew it; only its Safari button waits for a card URL.
        let showBar = style == .expanded
        bar.isHidden = !showBar
        barShown.isActive = showBar
        barSafari.isEnabled = cardURL != nil
    }

    private func showNote(_ text: String, canRetry: Bool) {
        loadTimer?.invalidate()
        loadTimer = nil
        spinner.stopAnimating()
        webView.isHidden = true
        expandOverlay.isHidden = true
        note.text = text
        note.isHidden = false
        retry.isHidden = !canRetry
        safari.isHidden = cardURL == nil
    }

    // An iMessage extension may only open its parent app (and only when that
    // app is on the Home Screen), so Safari is reached through the container
    // app: it receives the page URL and opens it with UIApplication.open.
    @objc private func openInSafari() {
        guard let url = webView.url ?? cardURL, Self.isCardPage(url) else { return }
        var handoff = URLComponents()
        handoff.scheme = "robobcards"
        handoff.host = "open"
        handoff.queryItems = [URLQueryItem(name: "url", value: url.absoluteString)]
        guard let link = handoff.url else { return }
        extensionContext?.open(link) { opened in
            if !opened { Self.log.error("handoff to the container app failed") }
        }
    }

    @objc private func expand() {
        requestPresentationStyle(.expanded)
    }

    @objc private func reload() {
        crashReloads = 0
        if let cardURL { load(cardURL) }
    }

    private static func isCardPage(_ url: URL) -> Bool {
        url.scheme?.lowercased() == "https" && url.host?.isEmpty == false
    }

    // Card pages stay on https inside the chat. Anything else (tel:, maps,
    // plain http, app links) belongs to the system, not this web view.
    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "https" || scheme == "about" || scheme == "blob" || scheme == "data" {
            return decisionHandler(.allow)
        }
        decisionHandler(.cancel)
        extensionContext?.open(url)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url { extensionContext?.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard navigation === currentNavigation else { return }
        Self.log.info("loaded")
        loadTimer?.invalidate()
        loadTimer = nil
        spinner.stopAnimating()
        // A page that finishes after the timeout note replaces the note.
        note.isHidden = true
        retry.isHidden = true
        safari.isHidden = true
        webView.isHidden = false
        layout(for: presentationStyle)
    }

    // The page's web process can be killed (memory pressure in the Messages
    // sheet), which leaves an empty white view and calls no failure method.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Self.log.error("web content process ended")
        guard let cardURL, crashReloads < 1 else {
            return showNote("This card stopped loading. Try again or open it in Safari.", canRetry: true)
        }
        crashReloads += 1
        load(cardURL)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard navigation === currentNavigation else { return }
        failed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard navigation === currentNavigation else { return }
        failed(error)
    }

    // A superseded navigation's cancellation (a redirect replaced it, or the
    // user picked another card) must not touch the timer or spinner of the
    // navigation that replaced it.
    private func failed(_ error: Error) {
        if (error as NSError).code == NSURLErrorCancelled {
            // Cancelled and still current: a redirect or a link handed to the
            // system with nothing shown. Show the note rather than a blank sheet.
            if !webView.isLoading, webView.url == nil {
                showNote("This card didn't load. Check your connection and try again.", canRetry: true)
            }
            return
        }
        Self.log.error("load failed: \((error as NSError).code)")
        showNote("This card didn't load. Check your connection and try again.", canRetry: true)
    }

}
