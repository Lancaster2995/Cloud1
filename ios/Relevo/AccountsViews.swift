import SwiftUI

struct AccountsView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var sessions: WebSessions
    @State private var editing: Ref<Account?>?
    @State private var pauseFor: Ref<Account>?
    @State private var logoutFor: Account?
    @State private var deleteFor: Account?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if store.data.accounts.isEmpty {
                    Card {
                        Text("Agrega tu primera cuenta").font(.headline)
                        Text("Cada cuenta tiene su propia sesión con cookies separadas: puedes tener varias cuentas de Claude abiertas y cambiar entre ellas al instante. Después de agregarla, pulsa Abrir e inicia sesión.")
                            .font(.subheadline).foregroundStyle(Theme.text2)
                        Button("Agregar cuenta") { editing = Ref(value: nil) }.buttonStyle(.borderedProminent)
                    }
                }
                ForEach(store.data.sortedAccounts) { a in card(a) }
            }
            .padding(16)
        }
        .background(Theme.bg)
        .navigationTitle("Cuentas")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { editing = Ref(value: nil) } label: { Image(systemName: "plus.circle.fill").font(.title3) }
                    .accessibilityLabel("Agregar cuenta")
            }
        }
        .sheet(item: $editing) { ref in AccountEditSheet(account: ref.value) }
        .sheet(item: $pauseFor) { ref in PauseSheet(account: ref.value) }
        .confirmationDialog("Cerrar sesión", isPresented: Binding(get: { logoutFor != nil }, set: { if !$0 { logoutFor = nil } }),
                            titleVisibility: .visible, presenting: logoutFor) { a in
            Button("Cerrar sesión de «\(a.name)»", role: .destructive) { sessions.clear(a.slot, startURL: a.startUrl) }
        } message: { _ in
            Text("Se borrarán las cookies y los datos de navegación de esta cuenta en este dispositivo.")
        }
        .confirmationDialog("Eliminar cuenta", isPresented: Binding(get: { deleteFor != nil }, set: { if !$0 { deleteFor = nil } }),
                            titleVisibility: .visible, presenting: deleteFor) { a in
            Button("Eliminar «\(a.name)»", role: .destructive) {
                router.sessionSlots.removeAll { $0 == a.slot }
                sessions.remove(a.slot)
                Notifier.cancel(slot: a.slot)
                store.deleteAccount(a.slot)
            }
        } message: { _ in
            Text("Se borrarán sus datos de sesión. Los proyectos se conservan.")
        }
    }

    private func card(_ a: Account) -> some View {
        let project = store.data.project(a.activeProjectId)
        return Card {
            HStack(alignment: .top) {
                AccountDot(color: a.color, size: 14).padding(.top, 4)
                VStack(alignment: .leading, spacing: 2) {
                    Text(a.name).font(.headline)
                    if !a.note.isEmpty { Text(a.note).font(.footnote).foregroundStyle(Theme.text2) }
                }
                Spacer()
                Text("Cuenta \(a.slot)").font(.caption).foregroundStyle(Theme.text2)
            }
            TimelineView(.periodic(from: .now, by: 30)) { _ in
                let now = Relevo.now()
                if a.isPaused(now) {
                    Text("En pausa · vuelve en \(Prompts.duration(a.pausedUntil - now)) (\(Prompts.clock(a.pausedUntil)))")
                        .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.warn)
                } else {
                    Text("Disponible").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ok)
                }
            }
            Text((project.map { "Proyecto: \($0.name) (\($0.progress)%)" } ?? "Sin proyecto activo")
                 + " · activa " + Prompts.ago(a.lastActive)
                 + (a.startUrl == Relevo.codeURL ? " · Claude Code" : ""))
                .font(.footnote).foregroundStyle(Theme.text2)
            HStack {
                Button("Abrir") { router.open(a.slot) }.buttonStyle(.borderedProminent)
                Button("Pausa") { pauseFor = Ref(value: a) }.buttonStyle(.bordered)
                Button("Editar") { editing = Ref(value: a) }.buttonStyle(.bordered)
                Spacer(minLength: 0)
                Menu {
                    Button { logoutFor = a } label: { Label("Cerrar sesión (borrar cookies)", systemImage: "rectangle.portrait.and.arrow.right") }
                    Button(role: .destructive) { deleteFor = a } label: { Label("Eliminar cuenta", systemImage: "trash") }
                } label: {
                    Image(systemName: "ellipsis.circle").font(.title3)
                }
            }
            .controlSize(.small)
            .padding(.top, 4)
        }
    }
}

struct AccountEditSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let account: Account?

    @State private var name = ""
    @State private var note = ""
    @State private var color = Relevo.colors[0]
    @State private var start = Relevo.chatURL
    @State private var customURL = ""
    @State private var error: String?

    private let other = "other"

    var body: some View {
        NavigationStack {
            Form {
                TextField("Nombre (p. ej. Personal)", text: $name)
                TextField("Nota: correo, plan… (opcional)", text: $note)
                    .textInputAutocapitalization(.never)
                Section("Color") {
                    HStack(spacing: 12) {
                        ForEach(Relevo.colors, id: \.self) { c in
                            Circle()
                                .fill(Color(hex: c))
                                .frame(width: 28, height: 28)
                                .overlay(Circle().stroke(Color.primary, lineWidth: c == color ? 3 : 0))
                                .onTapGesture { color = c }
                                .accessibilityLabel(c)
                        }
                    }
                    .padding(.vertical, 4)
                }
                Section("Página de inicio") {
                    Picker("Página de inicio", selection: $start) {
                        Text("Chat (claude.ai)").tag(Relevo.chatURL)
                        Text("Claude Code (claude.ai/code)").tag(Relevo.codeURL)
                        Text("Otra URL").tag(other)
                    }
                    .pickerStyle(.inline)
                    .labelsHidden()
                    if start == other {
                        TextField("https://…", text: $customURL)
                            .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    }
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle(account == nil ? "Nueva cuenta" : "Editar cuenta")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) { Button("Guardar", action: save) }
            }
            .onAppear {
                if let a = account {
                    name = a.name
                    note = a.note
                    color = a.color
                    if a.startUrl == Relevo.chatURL || a.startUrl == Relevo.codeURL {
                        start = a.startUrl
                    } else {
                        start = other
                        customURL = a.startUrl
                    }
                } else {
                    color = Relevo.colors[store.data.accounts.count % Relevo.colors.count]
                }
            }
        }
    }

    private func save() {
        var url = start == other ? customURL.trimmingCharacters(in: .whitespacesAndNewlines) : start
        if !url.isEmpty && !url.lowercased().hasPrefix("http") { url = "https://" + url }
        do {
            try store.saveAccount(slot: account?.slot ?? 0, name: name, note: note, color: color, startUrl: url)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

struct PauseSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let account: Account
    @State private var until = Date().addingTimeInterval(5 * 3600)

    var body: some View {
        NavigationStack {
            Form {
                Section("Pausar durante") {
                    ForEach(1..<pauseOptions.count, id: \.self) { i in
                        Button(pauseOptions[i].label) { apply(Relevo.now() + pauseOptions[i].ms) }
                    }
                }
                Section("O hasta una hora exacta") {
                    DatePicker("Hasta", selection: $until, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                    Button("Pausar hasta esa hora") { apply(Int64(until.timeIntervalSince1970 * 1000)) }
                }
                if account.isPaused() {
                    Section {
                        Button("Quitar la pausa") { apply(0) }
                    }
                }
            }
            .navigationTitle("Pausar «\(account.name)»")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func apply(_ value: Int64) {
        Notifier.pause(store, slot: account.slot, until: value)
        dismiss()
    }
}
