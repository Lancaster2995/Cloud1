import Foundation

/// URLs and constants shared by the whole app.
enum Relevo {
    static let chatURL = "https://claude.ai/new"
    static let codeURL = "https://claude.ai/code"
    static let colors = ["#D97757", "#4F7DF3", "#2DA44E", "#A259FF", "#E5A50A", "#E5484D", "#12A4B5", "#8B6E4E"]
    static let maxSlots = 8
    static let maxHistory = 120

    static func now() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
}

private extension KeyedDecodingContainer {
    /// Missing or mistyped keys fall back to a default, so exports from any version import cleanly.
    func value<T: Decodable>(_ key: Key, _ fallback: T) -> T {
        let decoded: T? = (try? decodeIfPresent(T.self, forKey: key)) ?? nil
        return decoded ?? fallback
    }
}

/// One entry of a project's history. Same JSON fields as Android and Windows.
struct HistoryEvent: Codable, Equatable {
    static let create = "create", checkpoint = "checkpoint", transfer = "transfer", edit = "edit", restore = "restore"

    var time: Int64 = 0
    var type: String = HistoryEvent.checkpoint
    var slot: Int = 0
    var toSlot: Int = 0
    var progress: Int = -1
    var accountName: String = ""
    var toAccountName: String = ""
    var text: String = ""

    init(time: Int64, type: String, slot: Int = 0, toSlot: Int = 0, progress: Int = -1,
         accountName: String = "", toAccountName: String = "", text: String = "") {
        self.time = time
        self.type = type
        self.slot = slot
        self.toSlot = toSlot
        self.progress = progress
        self.accountName = accountName
        self.toAccountName = toAccountName
        self.text = text
    }

    enum CodingKeys: String, CodingKey { case time, type, slot, toSlot, progress, accountName, toAccountName, text }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        time = c.value(.time, 0)
        type = c.value(.type, HistoryEvent.checkpoint)
        slot = c.value(.slot, 0)
        toSlot = c.value(.toSlot, 0)
        progress = c.value(.progress, -1)
        accountName = c.value(.accountName, "")
        toAccountName = c.value(.toAccountName, "")
        text = c.value(.text, "")
    }
}

/// A Claude account. Its `slot` names the isolated website data store used by its web view.
struct Account: Codable, Identifiable, Equatable {
    var slot: Int
    var name: String = ""
    var note: String = ""
    var color: String = Relevo.colors[0]
    var startUrl: String = Relevo.chatURL
    var desktopMode: Bool = false
    var pausedUntil: Int64 = 0
    var lastActive: Int64 = 0
    var activeProjectId: String = ""

    var id: Int { slot }

    init(slot: Int) {
        self.slot = slot
        name = "Cuenta \(slot)"
        color = Relevo.colors[(slot - 1) % Relevo.colors.count]
    }

    func isPaused(_ now: Int64 = Relevo.now()) -> Bool { pausedUntil > now }

    enum CodingKeys: String, CodingKey {
        case slot, name, note, color, startUrl, desktopMode, pausedUntil, lastActive, activeProjectId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        slot = c.value(.slot, 0)
        name = c.value(.name, "Cuenta \(slot)")
        note = c.value(.note, "")
        color = c.value(.color, Relevo.colors[max(0, slot - 1) % Relevo.colors.count])
        startUrl = c.value(.startUrl, Relevo.chatURL)
        desktopMode = c.value(.desktopMode, false)
        pausedUntil = c.value(.pausedUntil, 0)
        lastActive = c.value(.lastActive, 0)
        activeProjectId = c.value(.activeProjectId, "")
    }
}

/// A project that moves between accounts, with its latest status block and history.
struct Project: Codable, Identifiable, Equatable {
    var id: String = UUID().uuidString.lowercased()
    var name: String = ""
    var goal: String = ""
    var repo: String = ""
    var branch: String = ""
    var notes: String = ""
    var state: String = ""
    var progress: Int = 0
    var currentSlot: Int = 0
    var pendingSlot: Int = 0
    var stateTime: Int64 = 0
    var created: Int64 = 0
    var updated: Int64 = 0
    var history: [HistoryEvent] = []

    init() {}

    var hasState: Bool { !state.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    mutating func add(_ event: HistoryEvent) {
        history.append(event)
        if history.count > Relevo.maxHistory { history.removeFirst(history.count - Relevo.maxHistory) }
    }

    enum CodingKeys: String, CodingKey {
        case id, name, goal, repo, branch, notes, state, progress, currentSlot, pendingSlot, stateTime, created, updated, history
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = c.value(.id, UUID().uuidString.lowercased())
        name = c.value(.name, "")
        goal = c.value(.goal, "")
        repo = c.value(.repo, "")
        branch = c.value(.branch, "")
        notes = c.value(.notes, "")
        state = c.value(.state, "")
        progress = c.value(.progress, 0)
        currentSlot = c.value(.currentSlot, 0)
        pendingSlot = c.value(.pendingSlot, 0)
        stateTime = c.value(.stateTime, 0)
        created = c.value(.created, 0)
        updated = c.value(.updated, 0)
        history = c.value(.history, [])
    }
}

/// The whole persisted document.
struct AppData: Codable, Equatable {
    var version: Int = 1
    var accounts: [Account] = []
    var projects: [Project] = []
    var autoInsert: Bool = true

    init() {}

    enum CodingKeys: String, CodingKey { case version, accounts, projects, autoInsert }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = c.value(.version, 1)
        accounts = c.value(.accounts, [])
        projects = c.value(.projects, [])
        autoInsert = c.value(.autoInsert, true)
    }

    func account(_ slot: Int) -> Account? { accounts.first { $0.slot == slot } }
    func project(_ id: String) -> Project? { id.isEmpty ? nil : projects.first { $0.id == id } }
    func accountName(_ slot: Int) -> String { account(slot)?.name ?? (slot > 0 ? "Cuenta \(slot)" : "—") }
    var sortedAccounts: [Account] { accounts.sorted { $0.slot < $1.slot } }
    var sortedProjects: [Project] { projects.sorted { $0.updated > $1.updated } }

    func freeSlot() -> Int {
        for s in 1...Relevo.maxSlots where account(s) == nil { return s }
        return 0
    }
}
