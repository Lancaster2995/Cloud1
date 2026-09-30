import SwiftUI
import UserNotifications

@main
struct RelevoApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var store: Store
    @StateObject private var router = Router.shared

    init() {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-RelevoDemo") {
            // Screenshot mode: sample data in a throwaway file.
            let s = Store(url: FileManager.default.temporaryDirectory.appendingPathComponent("relevo-demo.json"))
            s.replace(DemoData.make())
            _store = StateObject(wrappedValue: s)
        } else {
            _store = StateObject(wrappedValue: Store())
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(store)
                .environmentObject(router)
                .environmentObject(WebSessions.shared)
        }
    }
}

/// Which screen is showing: tabs, project path and the open account sessions.
final class Router: ObservableObject {
    static let shared = Router()

    enum Tab: Hashable { case projects, accounts, guide }

    @Published var tab: Tab = .projects
    @Published var projectPath: [String] = []
    @Published var sessionOpen = false
    /// Accounts shown in the session screen: one, or two side by side on wide screens.
    @Published var sessionSlots: [Int] = []

    func open(_ slot: Int) {
        if sessionSlots.contains(slot) {
            // Already visible.
        } else if sessionSlots.isEmpty || !sessionOpen {
            sessionSlots = [slot]
        } else {
            sessionSlots[sessionSlots.count - 1] = slot
        }
        sessionOpen = true
    }

    func switchPane(from: Int, to: Int) {
        guard from != to else { return }
        if sessionSlots.contains(to) {
            sessionSlots.removeAll { $0 == from }
        } else if let i = sessionSlots.firstIndex(of: from) {
            sessionSlots[i] = to
        } else {
            sessionSlots = [to]
        }
    }

    func split(with slot: Int) {
        guard !sessionSlots.contains(slot) else { return }
        if sessionSlots.count >= 2 { sessionSlots[1] = slot } else { sessionSlots.append(slot) }
    }

    func close(_ slot: Int) {
        if sessionSlots.count > 1 {
            sessionSlots.removeAll { $0 == slot }
        } else {
            sessionOpen = false
        }
    }
}

/// Local notification when a paused account is available again.
enum Notifier {
    static func schedule(slot: Int, name: String, until: Int64) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            let content = UNMutableNotificationContent()
            content.title = "«\(name)» vuelve a estar disponible"
            content.body = "Toca para abrir su sesión y seguir trabajando."
            content.sound = .default
            content.userInfo = ["slot": slot]
            let seconds = max(1, Double(until - Relevo.now()) / 1000)
            let trigger = UNTimeIntervalNotificationTrigger(timeInterval: seconds, repeats: false)
            center.add(UNNotificationRequest(identifier: "pause-\(slot)", content: content, trigger: trigger))
        }
    }

    static func cancel(slot: Int) {
        UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: ["pause-\(slot)"])
    }

    /// Pauses (until > now) or resumes (until = 0) an account and keeps the reminder in sync.
    static func pause(_ store: Store, slot: Int, until: Int64) {
        store.setPause(slot, until: until)
        if until > Relevo.now() {
            schedule(slot: slot, name: store.data.accountName(slot), until: until)
        } else {
            cancel(slot: slot)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        if let slot = response.notification.request.content.userInfo["slot"] as? Int {
            DispatchQueue.main.async { Router.shared.open(slot) }
        }
        completionHandler()
    }
}
