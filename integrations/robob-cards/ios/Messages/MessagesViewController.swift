import Messages
import UIKit
import WebKit

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
    private let spinner = UIActivityIndicatorView(style: .medium)
    // Compact (the app drawer) and transcript (the live bubble in the chat) are
    // previews; a tap anywhere asks Messages for the full-height view so the
    // page can be used. From the transcript Messages opens a new expanded
    // instance, which loads the same selected message.
    private let expandOverlay = UIControl()
    private var cardURL: URL?

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

        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        view.addSubview(spinner)

        let guide = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
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
            spinner.centerXAnchor.constraint(equalTo: guide.centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: guide.centerYAnchor),
        ])
        showNote("Tap a Robob card in this chat to open it here.", canRetry: false)
    }

    override func willBecomeActive(with conversation: MSConversation) {
        super.willBecomeActive(with: conversation)
        open(conversation.selectedMessage)
        layout(for: presentationStyle)
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
        guard let message else { return }
        guard let url = message.url, Self.isCardPage(url) else {
            cardURL = nil
            showNote("This card has no secure link to open.", canRetry: false)
            return
        }
        if url == cardURL, webView.url != nil { return }
        cardURL = url
        load(url)
    }

    private func load(_ url: URL) {
        note.isHidden = true
        retry.isHidden = true
        webView.isHidden = false
        spinner.startAnimating()
        webView.load(URLRequest(url: url))
    }

    private func layout(for style: MSMessagesAppPresentationStyle) {
        let preview = (style == .compact || style == .transcript) && cardURL != nil
        expandOverlay.isHidden = !preview
        webView.scrollView.isScrollEnabled = !preview
    }

    private func showNote(_ text: String, canRetry: Bool) {
        spinner.stopAnimating()
        webView.isHidden = true
        expandOverlay.isHidden = true
        note.text = text
        note.isHidden = false
        retry.isHidden = !canRetry
    }

    @objc private func expand() {
        requestPresentationStyle(.expanded)
    }

    @objc private func reload() {
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
        spinner.stopAnimating()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failed(error)
    }

    private func failed(_ error: Error) {
        // A cancelled load is a redirect or a link handed to the system, not a failure.
        if (error as NSError).code == NSURLErrorCancelled { return spinner.stopAnimating() }
        showNote("This card didn't load. Check your connection and try again.", canRetry: true)
    }
}
