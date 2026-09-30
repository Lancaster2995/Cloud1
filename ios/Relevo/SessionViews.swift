import SwiftUI
import WebKit

/// Full-screen area with one account session, or two side by side on wide screens (iPad).
struct SessionScreen: View {
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var sessions: WebSessions

    var body: some View {
        HStack(spacing: 1) {
            ForEach(router.sessionSlots, id: \.self) { slot in
                SessionPane(slot: slot)
            }
        }
        .background(Theme.border)
        .sheet(item: $sessions.popup) { page in PopupSheet(page: page) }
    }
}

/// Sign-in pop-up (Google, Apple…) sharing the account's cookies.
struct PopupSheet: View {
    @EnvironmentObject private var sessions: WebSessions
    let page: PopupPage

    var body: some View {
        NavigationStack {
            WebViewHost(webView: page.webView)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(page.webView.url?.host ?? "Iniciar sesión")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { sessions.popup = nil } } }
        }
    }
}

/// Pending action to resume once the user picks a project for this account.
private enum AfterProject {
    case handoff, checkpoint, save, transfer, manualState
}

struct SessionPane: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var sessions: WebSessions
    @Environment(\.horizontalSizeClass) private var sizeClass
    let slot: Int

    @State private var status: String?
    @State private var statusToken = 0
    @State private var pickProjectFor: Ref<AfterProject>?
    @State private var newProjectFor: Ref<AfterProject>?
    @State private var askNewChat: Ref<(projectId: String, url: String)>?
    @State private var noBlock = false
    @State private var transferFor: Ref<(projectId: String, warn: Bool)>?
    @State private var manualState = false
    @State private var openLink = false
    @State private var pause = false
    @State private var logout = false
    @State private var splitPicker = false

    private var account: Account { store.data.account(slot) ?? Account(slot: slot) }
    private var activeProject: Project? { store.data.project(account.activeProjectId) }

    var body: some View {
        withDialogs(withSheets(content))
    }

    private var content: some View {
        let a = account
        let pending = store.data.projects.first { $0.pendingSlot == slot }
        return VStack(spacing: 0) {
            Rectangle().fill(Color(hex: a.color)).frame(height: 3)
            topBar(a)
            actionBar
            if let status {
                Text(status)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(Theme.accent)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 6)
                    .transition(.opacity)
            }
            if let pending { banner(pending) }
            Rectangle()
                .fill(sessions.loading[slot] == true ? Theme.accent : Theme.border)
                .frame(height: sessions.loading[slot] == true ? 2 : 1)
            WebViewHost(webView: sessions.webView(for: slot, startURL: a.startUrl))
                .id(slot)
                .ignoresSafeArea(edges: .bottom)
        }
        .background(Theme.surface)
        .onAppear {
            store.ensureAccount(slot)
            store.touch(slot)
        }
    }

    private func withSheets<V: View>(_ view: V) -> some View {
        view
            .sheet(item: $pickProjectFor) { ref in
                ProjectPickerSheet(onPick: { id in
                    store.setActiveProject(slot, id)
                    resume(ref.value)
                }, onNew: {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { newProjectFor = ref }
                })
            }
            .sheet(item: $newProjectFor) { ref in
                NewProjectSheet(slot: slot) { _ in resume(ref.value) }
            }
            .sheet(item: $transferFor) { ref in
                TransferSheet(projectId: ref.value.projectId, fromSlot: slot, unansweredWarning: ref.value.warn) { to in
                    router.switchPane(from: slot, to: to)
                }
            }
            .sheet(isPresented: $manualState) { ManualStateSheet(slot: slot) }
            .sheet(isPresented: $openLink) { OpenLinkSheet(slot: slot) }
            .sheet(isPresented: $pause) { PauseSheet(account: account) }
    }

    private var askNewChatShown: Binding<Bool> {
        Binding(get: { askNewChat != nil }, set: { if !$0 { askNewChat = nil } })
    }

    private func withDialogs<V: View>(_ view: V) -> some View {
        view
            .confirmationDialog("Hay una conversación abierta", isPresented: askNewChatShown,
                                titleVisibility: .visible, presenting: askNewChat) { ref in
                Button("Chat nuevo") { insertHandoff(ref.value.projectId, where: "new", newChatURL: ref.value.url) }
                Button("Aquí") { insertHandoff(ref.value.projectId, where: "here") }
            } message: { _ in
                Text("El traspaso funciona mejor en un chat nuevo. ¿Dónde lo inserto?")
            }
            .alert("No encontré el bloque de estado", isPresented: $noBlock) {
                Button("Pedir estado") { insertCheckpoint() }
                Button("Pegar a mano") { manualState = true }
                Button("Cerrar", role: .cancel) {}
            } message: {
                Text("Pulsa «Pedir estado», envía el mensaje y, cuando Claude responda con el bloque <<<ESTADO … ESTADO>>>, vuelve a pulsar «Guardar».")
            }
            .confirmationDialog("Cerrar sesión de «\(account.name)»", isPresented: $logout, titleVisibility: .visible) {
                Button("Cerrar sesión", role: .destructive) {
                    sessions.clear(slot, startURL: account.startUrl)
                    say("Sesión cerrada en esta cuenta")
                }
            } message: {
                Text("Se borrarán las cookies y datos de esta cuenta en este dispositivo. Tendrás que volver a iniciar sesión.")
            }
            .confirmationDialog("Abrir otra cuenta al lado", isPresented: $splitPicker, titleVisibility: .visible) {
                ForEach(store.data.sortedAccounts.filter { !router.sessionSlots.contains($0.slot) }) { other in
                    Button(Prompts.accountLabel(other)) { router.split(with: other.slot) }
                }
            }
    }

    // MARK: bars

    private func topBar(_ a: Account) -> some View {
        HStack(spacing: 8) {
            Button { router.close(slot) } label: {
                Image(systemName: router.sessionSlots.count > 1 ? "xmark.square" : "chevron.down")
                    .font(.body.weight(.semibold))
            }
            .accessibilityLabel(router.sessionSlots.count > 1 ? "Cerrar este panel" : "Volver al panel")

            Menu {
                ForEach(store.data.sortedAccounts) { other in
                    Button {
                        router.switchPane(from: slot, to: other.slot)
                    } label: {
                        Label(Prompts.accountLabel(other), systemImage: other.slot == slot ? "checkmark" : "person.crop.circle")
                    }
                }
            } label: {
                HStack(spacing: 5) {
                    AccountDot(color: a.color)
                    Text(a.name).font(.subheadline.weight(.semibold)).lineLimit(1)
                    Image(systemName: "chevron.up.chevron.down").font(.caption2)
                }
                .foregroundStyle(.primary)
            }

            Menu {
                Button("Sin proyecto") { store.setActiveProject(slot, "") }
                ForEach(store.data.sortedProjects) { p in
                    Button {
                        store.setActiveProject(slot, p.id)
                    } label: {
                        Label("\(p.name) · \(p.progress)%", systemImage: p.id == a.activeProjectId ? "checkmark" : "folder")
                    }
                }
                Divider()
                Button { newProjectFor = Ref(value: .handoff) } label: { Label("Nuevo proyecto…", systemImage: "plus") }
            } label: {
                Text(activeProject.map { "\($0.name) · \($0.progress)%" } ?? "Sin proyecto")
                    .font(.subheadline)
                    .lineLimit(1)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(Theme.surface2))
                    .foregroundStyle(.primary)
            }

            Spacer(minLength: 0)

            Button { sessions.back(slot) } label: { Image(systemName: "chevron.left") }
                .disabled(sessions.canGoBack[slot] != true)
            Button { sessions.reload(slot) } label: { Image(systemName: "arrow.clockwise") }
            moreMenu(a)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    private func moreMenu(_ a: Account) -> some View {
        Menu {
            Button { sessions.load(slot, Relevo.chatURL) } label: { Label("Nuevo chat", systemImage: "square.and.pencil") }
            Button { sessions.load(slot, Relevo.codeURL) } label: { Label("Claude Code", systemImage: "chevron.left.forwardslash.chevron.right") }
            Button { sessions.load(slot, a.startUrl) } label: { Label("Página de inicio de la cuenta", systemImage: "house") }
            Divider()
            if sizeClass == .regular {
                Button { splitPicker = true } label: { Label("Abrir otra cuenta al lado…", systemImage: "rectangle.split.2x1") }
            }
            Button { pause = true } label: { Label("Pausar esta cuenta…", systemImage: "pause.circle") }
            Button { withProject(.manualState) } label: { Label("Pegar estado a mano…", systemImage: "doc.text") }
            Button { openLink = true } label: { Label("Abrir un enlace aquí (inicio de sesión)…", systemImage: "link") }
            Toggle(isOn: Binding(get: { store.data.autoInsert }, set: { v in store.edit { $0.autoInsert = v } })) {
                Label("Insertar prompts en el chat", systemImage: "text.insert")
            }
            Divider()
            if let url = sessions.currentURL(slot) {
                Button { UIApplication.shared.open(url) } label: { Label("Abrir en Safari", systemImage: "safari") }
                Button { UIPasteboard.general.string = url.absoluteString } label: { Label("Copiar enlace", systemImage: "link") }
            }
            Divider()
            Button(role: .destructive) { logout = true } label: { Label("Cerrar sesión de esta cuenta…", systemImage: "rectangle.portrait.and.arrow.right") }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
    }

    private var actionBar: some View {
        HStack(spacing: 6) {
            actionButton("📨", "Traspaso") { withProject(.handoff) }
            actionButton("🧭", "Pedir estado") { withProject(.checkpoint) }
            actionButton("💾", "Guardar") { withProject(.save) }
            actionButton("⇄", "Pasar", prominent: true) { withProject(.transfer) }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 6)
    }

    private func actionButton(_ icon: String, _ title: String, prominent: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Text(icon)
                Text(title).lineLimit(1).minimumScaleFactor(0.75)
            }
            .font(.footnote.weight(prominent ? .semibold : .regular))
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(ActionButtonStyle(prominent: prominent))
    }

    private func banner(_ p: Project) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(p.hasState ? "Traspaso pendiente: «\(p.name)» (\(p.progress)%)." : "Proyecto nuevo asignado a esta cuenta: «\(p.name)».")
                + Text(" Pulsa «Insertar prompt» para continuarlo aquí.")
            HStack {
                Spacer()
                Button("Descartar") { store.dismissPending(p.id, slot: slot) }
                    .buttonStyle(.borderless)
                Button("Insertar prompt") {
                    store.setActiveProject(slot, p.id)
                    insertHandoff(p.id, where: "auto")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
            }
        }
        .font(.subheadline)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Theme.banner)
    }

    // MARK: actions

    private func say(_ message: String) {
        statusToken += 1
        let token = statusToken
        withAnimation { status = message }
        DispatchQueue.main.asyncAfter(deadline: .now() + 7) {
            if token == statusToken { withAnimation { status = nil } }
        }
    }

    private func withProject(_ action: AfterProject) {
        if activeProject == nil {
            if store.data.projects.isEmpty {
                newProjectFor = Ref(value: action)
            } else {
                pickProjectFor = Ref(value: action)
            }
            return
        }
        resume(action)
    }

    private func resume(_ action: AfterProject) {
        switch action {
        case .handoff:
            if let p = activeProject { insertHandoff(p.id, where: "auto") }
        case .checkpoint: insertCheckpoint()
        case .save: saveState(quiet: false) { _ in }
        case .transfer: startTransfer()
        case .manualState: manualState = true
        }
    }

    private static let delivered = [
        "ok": "Listo en el cuadro de mensaje: revísalo y envíalo.",
        "copied": "Copiado: mantén pulsado el cuadro de mensaje y elige Pegar.",
        "noel": "Copiado. Abre un chat y pega el texto en el cuadro de mensaje.",
        "fail": "Copiado. Mantén pulsado el cuadro de mensaje y elige Pegar."
    ]

    private func deliver(_ text: String, retries: Int = 8, done: @escaping () -> Void = {}) {
        UIPasteboard.general.string = text
        guard store.data.autoInsert else {
            say(SessionPane.delivered["copied"]!)
            done()
            return
        }
        sessions.insert(slot, text, retries: retries) { r in
            say(SessionPane.delivered[r] ?? SessionPane.delivered["fail"]!)
            done()
        }
    }

    private func insertHandoff(_ projectId: String, where place: String, newChatURL: String? = nil) {
        guard let p = store.data.project(projectId) else { return }
        let text = Prompts.next(p)
        if place == "auto", let url = sessions.newChatURLIfInConversation(slot) {
            askNewChat = Ref(value: (projectId: projectId, url: url))
            return
        }
        let finish = { store.handoffDone(projectId, slot: slot) }
        if place == "new", let url = newChatURL {
            sessions.load(slot, url)
            say("Abriendo un chat nuevo…")
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { deliver(text, retries: 14, done: finish) }
        } else {
            deliver(text, done: finish)
        }
    }

    private func insertCheckpoint() {
        deliver(Prompts.checkpoint(activeProject))
    }

    /// Saves the newest status block shown in the conversation.
    private func saveState(quiet: Bool, then: @escaping (StateBlock.Result) -> Void) {
        guard let p = activeProject else { then(StateBlock.Result(block: nil, newestIsTemplate: false)); return }
        sessions.pageText(slot) { text in
            let page = StateBlock.find(text, requireEnd: true)
            if page.newestIsTemplate {
                if !quiet { say("Claude aún no ha respondido con el estado. Espera a que termine y vuelve a pulsar Guardar.") }
                then(page)
                return
            }
            guard let block = page.block else {
                if !quiet { noBlock = true }
                then(page)
                return
            }
            let changed = store.saveCheckpoint(p.id, slot: slot, block: block)
            let progress = StateBlock.progress(block)
            if changed {
                say("Estado guardado desde la conversación" + (progress >= 0 ? " · \(progress)%" : ""))
            } else if !quiet {
                say("Ese estado ya estaba guardado.")
            }
            then(page)
        }
    }

    private func startTransfer() {
        guard let p = activeProject else { return }
        let id = p.id
        saveState(quiet: true) { page in
            transferFor = Ref(value: (projectId: id, warn: page.newestIsTemplate))
        }
    }
}

struct ActionButtonStyle: ButtonStyle {
    let prominent: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .padding(.vertical, 7)
            .padding(.horizontal, 4)
            .foregroundStyle(prominent ? Color.white : Color.primary)
            .background(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(prominent ? Theme.accent : Theme.surface2)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .stroke(prominent ? Color.clear : Theme.border, lineWidth: 1)
            )
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

/// Paste or edit the status block by hand.
struct ManualStateSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let slot: Int
    @State private var text = ""
    @State private var info: String?

    var body: some View {
        let project = store.data.project(store.data.account(slot)?.activeProjectId ?? "")
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(minHeight: 260)
                    PasteButton(payloadType: String.self) { strings in
                        DispatchQueue.main.async { text = strings.joined(separator: "\n") }
                    }
                    .buttonStyle(.borderless)
                } footer: {
                    Text("Pega aquí el bloque <<<ESTADO … ESTADO>>> que te dio Claude.")
                }
                if let info { Text(info).foregroundStyle(Theme.warn) }
            }
            .navigationTitle(project.map { "Estado de «\($0.name)»" } ?? "Estado")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Guardar") {
                        guard let p = project else { dismiss(); return }
                        let r = StateBlock.find(text, requireEnd: false)
                        let block = r.block ?? text.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !block.isEmpty else { info = "El estado está vacío"; return }
                        store.saveCheckpoint(p.id, slot: slot, block: block, type: HistoryEvent.edit)
                        dismiss()
                    }
                }
            }
            .onAppear { text = project?.state ?? "" }
        }
    }
}

/// Loads a pasted link (e.g. the e-mail sign-in link) inside this account's session.
struct OpenLinkSheet: View {
    @EnvironmentObject private var sessions: WebSessions
    @Environment(\.dismiss) private var dismiss
    let slot: Int
    @State private var url = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("https://claude.ai/…", text: $url)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    PasteButton(payloadType: String.self) { strings in
                        DispatchQueue.main.async { url = (strings.first ?? "").trimmingCharacters(in: .whitespacesAndNewlines) }
                    }
                    .buttonStyle(.borderless)
                } footer: {
                    Text("Útil para el enlace de inicio de sesión que llega por correo: mantén pulsado el enlace en Mail, cópialo y pégalo aquí para que la sesión se abra en esta cuenta y no en Safari.")
                }
            }
            .navigationTitle("Abrir enlace aquí")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Abrir") {
                        if !url.isEmpty { sessions.load(slot, url) }
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
    }
}
