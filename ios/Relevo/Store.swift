import Foundation
import Combine

enum RelevoError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self {
        case .message(let m): return m
        }
    }
}

/// The persisted document (JSON in Application Support) plus every data operation.
/// Mirrors model.js (Windows) and Store/Slots (Android).
final class Store: ObservableObject {
    @Published private(set) var data: AppData
    let url: URL

    init(url: URL? = nil) {
        let fileURL = url ?? Store.defaultURL()
        self.url = fileURL
        if let raw = try? Data(contentsOf: fileURL), let decoded = try? JSONDecoder().decode(AppData.self, from: raw) {
            data = decoded
        } else {
            if FileManager.default.fileExists(atPath: fileURL.path) {
                // Keep an unreadable file for recovery instead of overwriting it.
                try? FileManager.default.moveItem(at: fileURL, to: fileURL.appendingPathExtension("corrupt-\(Relevo.now())"))
            }
            data = AppData()
        }
    }

    static func defaultURL() -> URL {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return dir.appendingPathComponent("relevo.json")
    }

    /// Replaces everything (demo data for screenshots, tests).
    func replace(_ newData: AppData) {
        data = newData
        save()
    }

    @discardableResult
    func edit<T>(_ change: (inout AppData) throws -> T) rethrows -> T {
        var copy = data
        let result = try change(&copy)
        data = copy
        save()
        return result
    }

    func save() {
        do {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            let encoder = JSONEncoder()
            try encoder.encode(data).write(to: url, options: .atomic)
        } catch {
            NSLog("Relevo: no se pudo guardar: \(error)")
        }
    }

    // MARK: accounts

    @discardableResult
    func saveAccount(slot: Int, name: String, note: String, color: String, startUrl: String) throws -> Int {
        try edit { d in
            var s = slot
            if s == 0 || d.account(s) == nil {
                s = slot != 0 ? slot : d.freeSlot()
                guard s > 0 else { throw RelevoError.message("Máximo \(Relevo.maxSlots) cuentas") }
                d.accounts.append(Account(slot: s))
            }
            let i = d.accounts.firstIndex { $0.slot == s }!
            let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
            d.accounts[i].name = n.isEmpty ? "Cuenta \(s)" : n
            d.accounts[i].note = note.trimmingCharacters(in: .whitespacesAndNewlines)
            d.accounts[i].color = color
            let u = startUrl.trimmingCharacters(in: .whitespacesAndNewlines)
            d.accounts[i].startUrl = u.isEmpty ? Relevo.chatURL : u
            return s
        }
    }

    func deleteAccount(_ slot: Int) {
        edit { d in
            d.accounts.removeAll { $0.slot == slot }
            for i in d.projects.indices {
                if d.projects[i].pendingSlot == slot { d.projects[i].pendingSlot = 0 }
                if d.projects[i].currentSlot == slot { d.projects[i].currentSlot = 0 }
            }
        }
    }

    func setPause(_ slot: Int, until: Int64) {
        edit { d in
            if let i = d.accounts.firstIndex(where: { $0.slot == slot }) { d.accounts[i].pausedUntil = until }
        }
    }

    func setActiveProject(_ slot: Int, _ id: String) {
        edit { d in
            if let i = d.accounts.firstIndex(where: { $0.slot == slot }) { d.accounts[i].activeProjectId = id }
        }
    }

    func touch(_ slot: Int) {
        edit { d in
            if let i = d.accounts.firstIndex(where: { $0.slot == slot }) { d.accounts[i].lastActive = Relevo.now() }
        }
    }

    func ensureAccount(_ slot: Int) {
        guard data.account(slot) == nil else { return }
        edit { d in d.accounts.append(Account(slot: slot)) }
    }

    // MARK: projects

    @discardableResult
    func createProject(name: String, goal: String, repo: String, branch: String, slot: Int) throws -> String {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { throw RelevoError.message("Escribe un nombre") }
        return edit { d in
            let now = Relevo.now()
            var p = Project()
            p.name = n
            p.goal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
            p.repo = repo.trimmingCharacters(in: .whitespacesAndNewlines)
            p.branch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            p.created = now
            p.updated = now
            p.currentSlot = slot
            p.add(HistoryEvent(time: now, type: HistoryEvent.create, slot: slot, progress: 0,
                               accountName: slot > 0 ? d.accountName(slot) : ""))
            d.projects.append(p)
            if let i = d.accounts.firstIndex(where: { $0.slot == slot }) { d.accounts[i].activeProjectId = p.id }
            return p.id
        }
    }

    func updateProject(_ id: String, name: String, goal: String, repo: String, branch: String, notes: String) throws {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !n.isEmpty else { throw RelevoError.message("Escribe un nombre") }
        edit { d in
            guard let i = d.projects.firstIndex(where: { $0.id == id }) else { return }
            d.projects[i].name = n
            d.projects[i].goal = goal.trimmingCharacters(in: .whitespacesAndNewlines)
            d.projects[i].repo = repo.trimmingCharacters(in: .whitespacesAndNewlines)
            d.projects[i].branch = branch.trimmingCharacters(in: .whitespacesAndNewlines)
            d.projects[i].notes = notes.trimmingCharacters(in: .whitespacesAndNewlines)
            d.projects[i].updated = Relevo.now()
        }
    }

    func deleteProject(_ id: String) {
        edit { d in
            d.projects.removeAll { $0.id == id }
            for i in d.accounts.indices where d.accounts[i].activeProjectId == id { d.accounts[i].activeProjectId = "" }
        }
    }

    /// Stores a new state block; false when it equals the current one.
    @discardableResult
    func saveCheckpoint(_ id: String, slot: Int, block: String, type: String = HistoryEvent.checkpoint) -> Bool {
        edit { d in
            guard let i = d.projects.firstIndex(where: { $0.id == id }) else { return false }
            let normalized = StateBlock.normalize(block)
            if normalized == StateBlock.normalize(d.projects[i].state) { return false }
            let now = Relevo.now()
            let progress = StateBlock.progress(normalized)
            d.projects[i].state = normalized
            if progress >= 0 { d.projects[i].progress = progress }
            d.projects[i].stateTime = now
            d.projects[i].updated = now
            if slot > 0 { d.projects[i].currentSlot = slot }
            d.projects[i].add(HistoryEvent(time: now, type: type, slot: slot,
                                           progress: progress >= 0 ? progress : d.projects[i].progress,
                                           accountName: d.accountName(slot), text: normalized))
            return true
        }
    }

    /// Hands a project to another account; returns the source's new pausedUntil (or 0).
    @discardableResult
    func transfer(_ id: String, from: Int, to: Int, pauseMs: Int64) -> Int64 {
        edit { d in
            guard let i = d.projects.firstIndex(where: { $0.id == id }) else { return 0 }
            let now = Relevo.now()
            d.projects[i].add(HistoryEvent(time: now, type: HistoryEvent.transfer, slot: from, toSlot: to,
                                           progress: d.projects[i].progress, accountName: d.accountName(from),
                                           toAccountName: d.accountName(to)))
            d.projects[i].currentSlot = to
            d.projects[i].pendingSlot = to
            d.projects[i].updated = now
            if let t = d.accounts.firstIndex(where: { $0.slot == to }) { d.accounts[t].activeProjectId = id }
            if pauseMs > 0, from != to, let f = d.accounts.firstIndex(where: { $0.slot == from }) {
                d.accounts[f].pausedUntil = now + pauseMs
                return d.accounts[f].pausedUntil
            }
            return 0
        }
    }

    /// The handoff prompt was placed in `slot`'s window.
    func handoffDone(_ id: String, slot: Int) {
        edit { d in
            guard let i = d.projects.firstIndex(where: { $0.id == id }) else { return }
            if d.projects[i].pendingSlot == slot { d.projects[i].pendingSlot = 0 }
            d.projects[i].currentSlot = slot
            if let a = d.accounts.firstIndex(where: { $0.slot == slot }) { d.accounts[a].activeProjectId = id }
        }
    }

    func dismissPending(_ id: String, slot: Int) {
        edit { d in
            if let i = d.projects.firstIndex(where: { $0.id == id }), d.projects[i].pendingSlot == slot {
                d.projects[i].pendingSlot = 0
            }
        }
    }

    /// Marks a project to be continued in its current account (start prompt offered if new).
    func prepareContinue(_ id: String) {
        edit { d in
            guard let i = d.projects.firstIndex(where: { $0.id == id }) else { return }
            let slot = d.projects[i].currentSlot
            if let a = d.accounts.firstIndex(where: { $0.slot == slot }) { d.accounts[a].activeProjectId = id }
            if !d.projects[i].hasState { d.projects[i].pendingSlot = slot }
        }
    }

    /// Imports an exported project (JSON from any device) or creates one from a state block.
    @discardableResult
    func importText(_ text: String) throws -> Project {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let now = Relevo.now()
        if t.hasPrefix("{") {
            guard let raw = t.data(using: .utf8), var p = try? JSONDecoder().decode(Project.self, from: raw),
                  !Prompts.blank(p.name) else {
                throw RelevoError.message("El JSON no parece un proyecto de Relevo")
            }
            return edit { d in
                if d.project(p.id) != nil { p.id = UUID().uuidString.lowercased() }
                if d.account(p.currentSlot) == nil { p.currentSlot = 0 }
                p.pendingSlot = 0
                p.updated = now
                d.projects.append(p)
                return p
            }
        }
        let r = StateBlock.find(t, requireEnd: false)
        guard let block = r.block else { throw RelevoError.message("No encontré JSON ni un bloque <<<ESTADO") }
        let name = (StateBlock.section(block, "PROYECTO") ?? "").components(separatedBy: "\n").first ?? ""
        var p = Project()
        p.name = Prompts.blank(name) ? "Proyecto importado" : name
        p.state = block
        p.progress = max(0, StateBlock.progress(block))
        p.stateTime = now
        p.created = now
        p.updated = now
        p.add(HistoryEvent(time: now, type: HistoryEvent.checkpoint, progress: p.progress, accountName: "importación", text: block))
        let created = p
        edit { d in d.projects.append(created) }
        return created
    }

    func exportJSON(_ id: String) -> String {
        guard let p = data.project(id) else { return "{}" }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? String(data: encoder.encode(p), encoding: .utf8)) ?? "{}"
    }
}
