import SwiftUI
import UIKit
import WebKit

/// A web view shown in a sheet for sign-in pop-ups (Google, Apple, SSO…).
struct PopupPage: Identifiable {
    let id = UUID()
    let webView: WKWebView
}

/// Keeps one live WKWebView per account. Each uses its own persistent WKWebsiteDataStore
/// (iOS 17+), i.e. its own cookies and storage, so every account stays signed in separately.
final class WebSessions: NSObject, ObservableObject {
    static let shared = WebSessions()

    @Published var popup: PopupPage?
    @Published private(set) var loading: [Int: Bool] = [:]
    @Published private(set) var canGoBack: [Int: Bool] = [:]

    private var views: [Int: WKWebView] = [:]
    private let signInDomains = ["claude.ai", "claude.com", "anthropic.com", "google.com", "apple.com", "github.com",
                                 "stripe.com", "microsoftonline.com", "live.com", "okta.com", "auth0.com"]

    static func storeIdentifier(_ slot: Int) -> UUID {
        UUID(uuidString: String(format: "52454C45-564F-4000-8000-%012d", slot))!
    }

    func dataStore(_ slot: Int) -> WKWebsiteDataStore {
        WKWebsiteDataStore(forIdentifier: WebSessions.storeIdentifier(slot))
    }

    /// Mobile Safari's user agent, so sign-in providers treat the view like Safari.
    private var userAgent: String {
        let v = UIDevice.current.systemVersion.replacingOccurrences(of: ".", with: "_")
        let short = UIDevice.current.systemVersion.split(separator: ".").prefix(2).joined(separator: ".")
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad; CPU OS" : "iPhone; CPU iPhone OS"
        return "Mozilla/5.0 (\(device) \(v) like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/\(short) Mobile/15E148 Safari/604.1"
    }

    func webView(for slot: Int, startURL: String) -> WKWebView {
        if let v = views[slot] { return v }
        let config = WKWebViewConfiguration()
        config.websiteDataStore = dataStore(slot)
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        let v = WKWebView(frame: .zero, configuration: config)
        configure(v)
        views[slot] = v
        if let url = URL(string: startURL) { v.load(URLRequest(url: url)) }
        return v
    }

    func existing(_ slot: Int) -> WKWebView? { views[slot] }

    private func configure(_ v: WKWebView) {
        v.navigationDelegate = self
        v.uiDelegate = self
        v.allowsBackForwardNavigationGestures = true
        v.customUserAgent = userAgent
        v.isInspectable = true
        v.scrollView.keyboardDismissMode = .interactive
    }

    private func slot(of webView: WKWebView) -> Int? {
        views.first { $0.value === webView }?.key
    }

    // MARK: navigation

    func load(_ slot: Int, _ string: String) {
        var s = string.trimmingCharacters(in: .whitespacesAndNewlines)
        if !s.lowercased().hasPrefix("http://") && !s.lowercased().hasPrefix("https://") { s = "https://" + s }
        guard let url = URL(string: s) else { return }
        views[slot]?.load(URLRequest(url: url))
    }

    func back(_ slot: Int) { views[slot]?.goBack() }
    func reload(_ slot: Int) { views[slot]?.reload() }
    func currentURL(_ slot: Int) -> URL? { views[slot]?.url }

    /// Signs the account out: wipes its cookies and storage and reloads the start page.
    func clear(_ slot: Int, startURL: String) {
        dataStore(slot).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) { [weak self] in
            self?.load(slot, startURL)
        }
    }

    /// Forgets the account's web view and deletes its data store.
    func remove(_ slot: Int) {
        if let v = views.removeValue(forKey: slot) {
            v.stopLoading()
            v.removeFromSuperview()
        }
        let id = WebSessions.storeIdentifier(slot)
        dataStore(slot).removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast) {
            WKWebsiteDataStore.remove(forIdentifier: id) { _ in }
        }
    }

    // MARK: page scripts (only when the user taps a button)

    func run(_ slot: Int, _ script: String, completion: @escaping (String) -> Void) {
        guard let v = views[slot] else { completion(""); return }
        v.evaluateJavaScript(script) { result, _ in
            completion((result as? String) ?? "")
        }
    }

    /// Places text in the chat box (never sends it), retrying while the page is still loading.
    func insert(_ slot: Int, _ text: String, retries: Int = 8, completion: @escaping (String) -> Void) {
        run(slot, PageScripts.insert(text)) { [weak self] r in
            if r == "noel" || r.isEmpty, retries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) {
                    self?.insert(slot, text, retries: retries - 1, completion: completion)
                }
                return
            }
            completion(r.isEmpty ? "fail" : r)
        }
    }

    func pageText(_ slot: Int, completion: @escaping (String) -> Void) {
        run(slot, PageScripts.pageText, completion: completion)
    }

    /// The new-chat URL when the page shows an existing conversation, else nil.
    func newChatURLIfInConversation(_ slot: Int) -> String? {
        guard let u = views[slot]?.url, let host = u.host, host.hasSuffix("claude.ai") else { return nil }
        let path = u.path
        if path.hasPrefix("/chat/") && path.count > 6 { return Relevo.chatURL }
        if path.hasPrefix("/code/") && path.count > 6 { return Relevo.codeURL }
        return nil
    }

    fileprivate func isSignIn(_ url: URL?) -> Bool {
        guard let url else { return true }
        if url.absoluteString.isEmpty || url.absoluteString == "about:blank" { return true }
        guard let host = url.host?.lowercased() else { return false }
        return signInDomains.contains { host == $0 || host.hasSuffix("." + $0) }
    }

    fileprivate func updateState(_ v: WKWebView, loading isLoading: Bool) {
        guard let s = slot(of: v) else { return }
        loading[s] = isLoading
        canGoBack[s] = v.canGoBack
    }
}

extension WebSessions: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        if ["http", "https", "about", "data", "blob"].contains(scheme) {
            decisionHandler(.allow)
        } else {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        updateState(webView, loading: true)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        updateState(webView, loading: false)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        updateState(webView, loading: false)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        updateState(webView, loading: false)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

extension WebSessions: WKUIDelegate {
    /// window.open / target=_blank: sign-in pop-ups stay in the account's data store (the
    /// configuration WebKit passes in); any other link opens in Safari.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        let url = navigationAction.request.url
        if isSignIn(url) {
            let popupView = WKWebView(frame: .zero, configuration: configuration)
            popupView.navigationDelegate = self
            popupView.uiDelegate = self
            popupView.customUserAgent = webView.customUserAgent
            popup = PopupPage(webView: popupView)
            return popupView
        }
        if let url { UIApplication.shared.open(url) }
        return nil
    }

    func webViewDidClose(_ webView: WKWebView) {
        if popup?.webView === webView { popup = nil }
    }

    /// Microphone/camera (voice mode) only for Claude's own pages.
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        let host = origin.host.lowercased()
        let claude = ["claude.ai", "claude.com", "anthropic.com"].contains { host == $0 || host.hasSuffix("." + $0) }
        decisionHandler(claude ? .prompt : .deny)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        presentAlert(message, confirm: false) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        presentAlert(message, confirm: true, completion: completionHandler)
    }

    private func presentAlert(_ message: String, confirm: Bool, completion: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        if confirm { alert.addAction(UIAlertAction(title: "Cancelar", style: .cancel) { _ in completion(false) }) }
        alert.addAction(UIAlertAction(title: "Aceptar", style: .default) { _ in completion(true) })
        guard let root = UIApplication.shared.connectedScenes.compactMap({ ($0 as? UIWindowScene)?.keyWindow }).first?.rootViewController else {
            completion(false)
            return
        }
        var top = root
        while let presented = top.presentedViewController { top = presented }
        top.present(alert, animated: true)
    }
}

/// SwiftUI host for an existing WKWebView.
struct WebViewHost: UIViewRepresentable {
    let webView: WKWebView

    func makeUIView(context: Context) -> WKWebView { webView }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}

/// Scripts evaluated in a Claude page when the user taps a button.
enum PageScripts {
    static func insert(_ text: String) -> String {
        let literal = jsString(text)
        return """
        (function(t){
          function vis(e){return !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length);}
          function find(){var s=['div.ProseMirror[contenteditable="true"]','[contenteditable="true"][role="textbox"]','div[contenteditable="true"]','textarea'];
            for(var i=0;i<s.length;i++){var l=document.querySelectorAll(s[i]);for(var j=l.length-1;j>=0;j--){if(vis(l[j]))return l[j];}}return null;}
          var el=find(); if(!el) return 'noel'; el.focus();
          if(el.tagName==='TEXTAREA'){var d=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value');
            d.set.call(el,(el.value?el.value+'\\n':'')+t); el.dispatchEvent(new Event('input',{bubbles:true})); return 'ok';}
          var before=(el.innerText||'').length, handled=false;
          try{var dt=new DataTransfer(); dt.setData('text/plain',t);
            handled=!el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));}catch(e){}
          if(handled||(el.innerText||'').length>before) return 'ok';
          try{if(document.execCommand('insertText',false,t)) return 'ok';}catch(e){}
          return 'fail';
        })(\(literal))
        """
    }

    static let pageText = "(function(){try{return document.body?document.body.innerText:'';}catch(e){return '';}})()"

    /// JSON-encodes a string into a JavaScript string literal.
    static func jsString(_ s: String) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed]),
              let array = String(data: data, encoding: .utf8) else { return "\"\"" }
        // "[\"...\"]" -> "\"...\""
        return String(array.dropFirst().dropLast())
    }
}
