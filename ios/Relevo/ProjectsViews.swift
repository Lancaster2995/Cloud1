import SwiftUI
import UniformTypeIdentifiers

let pauseOptions: [(label: String, ms: Int64)] = [
    ("No pausar", 0), ("1 hora", 3_600_000), ("2 horas", 7_200_000), ("3 horas", 10_800_000),
    ("5 horas", 18_000_000), ("8 horas", 28_800_000), ("24 horas", 86_400_000)
]

// MARK: - Projects list

struct ProjectsView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var router: Router
    @State private var showNew = false
    @State private var showImport = false
    @State private var transferFor: Ref<Project>?
    @State private var chooseFor: Ref<Project>?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if store.data.accounts.isEmpty {
                    Card {
                        Text("Empieza agregando tus cuentas").font(.headline)
                        Text("Cada cuenta abre su propia sesión con cookies separadas. Agrega al menos dos para poder pasar un proyecto de una a otra.")
                            .font(.subheadline).foregroundStyle(Theme.text2)
                        Button("Ir a Cuentas") { router.tab = .accounts }.buttonStyle(.bordered)
                    }
                }
                if store.data.projects.isEmpty {
                    Card {
                        Text("Sin proyectos todavía").font(.headline)
                        Text("Crea un proyecto con su objetivo. Relevo genera el prompt de inicio, guarda los estados (checkpoints) que te da Claude y los traspasa a la siguiente cuenta con todo el contexto.")
                            .font(.subheadline).foregroundStyle(Theme.text2)
                        Button("Nuevo proyecto") { showNew = true }.buttonStyle(.borderedProminent)
                    }
                }
                ForEach(store.data.sortedProjects) { p in
                    ProjectCard(project: p,
                                onContinue: { continueProject(p) },
                                onTransfer: { transferFor = Ref(value: p) },
                                onDetails: { router.projectPath.append(p.id) })
                }
            }
            .padding(16)
        }
        .background(Theme.bg)
        .navigationTitle("Relevo")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { showNew = true } label: { Label("Nuevo proyecto", systemImage: "plus") }
                    Button { showImport = true } label: { Label("Importar", systemImage: "square.and.arrow.down") }
                } label: {
                    Image(systemName: "plus.circle.fill").font(.title3)
                }
                .accessibilityLabel("Nuevo proyecto")
            }
        }
        .sheet(isPresented: $showNew) { NewProjectSheet(slot: 0) { _ in } }
        .sheet(isPresented: $showImport) { ImportSheet() }
        .sheet(item: $transferFor) { ref in
            TransferSheet(projectId: ref.value.id, fromSlot: ref.value.currentSlot) { to in router.open(to) }
        }
        .sheet(item: $chooseFor) { ref in
            AccountPickerSheet(title: "¿En qué cuenta continuar «\(ref.value.name)»?") { slot in
                store.transfer(ref.value.id, from: 0, to: slot, pauseMs: 0)
                router.open(slot)
            }
        }
    }

    private func continueProject(_ p: Project) {
        if p.currentSlot == 0 || store.data.account(p.currentSlot) == nil {
            chooseFor = Ref(value: p)
            return
        }
        store.prepareContinue(p.id)
        router.open(p.currentSlot)
    }
}

struct ProjectCard: View {
    @EnvironmentObject private var store: Store
    let project: Project
    let onContinue: () -> Void
    let onTransfer: () -> Void
    let onDetails: () -> Void

    var body: some View {
        let account = store.data.account(project.currentSlot)
        let summary = Prompts.summary(project).isEmpty ? project.goal : Prompts.summary(project)
        let next = Prompts.nextStep(project)
        Card {
            HStack(alignment: .firstTextBaseline) {
                Text(project.name).font(.headline).lineLimit(1)
                Spacer()
                Text("\(project.progress)%").font(.headline).foregroundStyle(Theme.accent)
            }
            ProgressView(value: Double(project.progress), total: 100).tint(Theme.accent)
            HStack(spacing: 6) {
                if let account { AccountDot(color: account.color, size: 8) }
                Text((account?.name ?? "Sin cuenta asignada") + " · actualizado " + Prompts.ago(project.updated))
                    .font(.footnote).foregroundStyle(Theme.text2)
            }
            if project.pendingSlot > 0 {
                Text("⏳ Traspaso pendiente → " + store.data.accountName(project.pendingSlot))
                    .font(.footnote.weight(.semibold)).foregroundStyle(Theme.warn)
            }
            if !summary.isEmpty { Text(summary).font(.subheadline).lineLimit(3) }
            if !next.isEmpty { Text("Siguiente: " + next).font(.footnote).foregroundStyle(Theme.text2).lineLimit(2) }
            HStack {
                Button("Continuar", action: onContinue).buttonStyle(.borderedProminent)
                Button("Pasar a…", action: onTransfer).buttonStyle(.bordered)
                Spacer(minLength: 0)
                Button("Detalles", action: onDetails).buttonStyle(.bordered)
            }
            .controlSize(.small)
            .padding(.top, 4)
        }
    }
}

// MARK: - Project detail

struct ProjectDetailView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var router: Router
    let projectId: String

    @State private var name = ""
    @State private var goal = ""
    @State private var repo = ""
    @State private var branch = ""
    @State private var notes = ""
    @State private var stateText = ""
    @State private var loadedStamp: Int64 = -1
    @State private var message: String?
    @State private var shownEvent: Ref<HistoryEvent>?
    @State private var transfer = false
    @State private var chooseAccount = false
    @State private var confirmDelete = false

    var body: some View {
        if let p = store.data.project(projectId) {
            decorated(form(p), p)
        } else {
            ContentUnavailableView("Este proyecto ya no existe", systemImage: "questionmark.folder")
        }
    }

    private var messageShown: Binding<Bool> {
        Binding(get: { message != nil }, set: { if !$0 { message = nil } })
    }

    private func decorated<V: View>(_ view: V, _ p: Project) -> some View {
        view
            .navigationTitle(p.name)
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { load(p, force: true) }
            .onChange(of: p.stateTime) { load(store.data.project(projectId) ?? p, force: false) }
            .sheet(item: $shownEvent) { ref in
                TextViewerSheet(title: Prompts.describe(ref.value), text: ref.value.text, action: "Restaurar") {
                    store.saveCheckpoint(projectId, slot: 0, block: ref.value.text, type: HistoryEvent.restore)
                    message = "Estado restaurado"
                }
            }
            .sheet(isPresented: $transfer) {
                TransferSheet(projectId: projectId, fromSlot: p.currentSlot) { to in router.open(to) }
            }
            .sheet(isPresented: $chooseAccount) {
                AccountPickerSheet(title: "¿En qué cuenta continuar?") { slot in
                    store.transfer(projectId, from: 0, to: slot, pauseMs: 0)
                    router.open(slot)
                }
            }
            .confirmationDialog("¿Eliminar «\(p.name)»?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Eliminar proyecto", role: .destructive) {
                    router.projectPath.removeAll()
                    store.deleteProject(projectId)
                }
            } message: {
                Text("Se borrarán su estado y su historial en este dispositivo.")
            }
            .alert(message ?? "", isPresented: messageShown) {
                Button("OK", role: .cancel) {}
            }
    }

    @ViewBuilder
    private func form(_ p: Project) -> some View {
        Form {
            Section {
                HStack {
                    Text("\(p.progress)%").font(.title2.bold()).foregroundStyle(Theme.accent)
                    ProgressView(value: Double(p.progress), total: 100).tint(Theme.accent)
                }
                LabeledContent("Cuenta actual", value: store.data.accountName(p.currentSlot))
                LabeledContent("Estado", value: p.hasState ? Prompts.stamp(p.stateTime) : "sin guardar")
                if p.pendingSlot > 0 {
                    Text("⏳ Traspaso pendiente → " + store.data.accountName(p.pendingSlot))
                        .font(.footnote.weight(.semibold)).foregroundStyle(Theme.warn)
                }
                HStack {
                    Button("Continuar") {
                        if p.currentSlot == 0 || store.data.account(p.currentSlot) == nil {
                            chooseAccount = true
                        } else {
                            store.prepareContinue(p.id)
                            router.open(p.currentSlot)
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Pasar a…") { transfer = true }.buttonStyle(.bordered)
                }
                .buttonStyle(.borderless)
            }

            Section {
                Button {
                    UIPasteboard.general.string = Prompts.next(p)
                    message = p.hasState ? "Prompt de traspaso copiado" : "Prompt de inicio copiado"
                } label: { Label(p.hasState ? "Copiar prompt de traspaso" : "Copiar prompt de inicio", systemImage: "doc.on.doc") }
                Button {
                    UIPasteboard.general.string = Prompts.checkpoint(p)
                    message = "Prompt «Pedir estado» copiado"
                } label: { Label("Copiar «Pedir estado»", systemImage: "doc.on.doc") }
                ShareLink(item: Prompts.next(p)) { Label("Compartir prompt", systemImage: "square.and.arrow.up") }
            } header: {
                Text("Prompts")
            } footer: {
                Text("Úsalos en cualquier sesión: también en Safari, en otro equipo o en la versión de Windows.")
            }

            Section {
                TextEditor(text: $stateText)
                    .font(.system(.footnote, design: .monospaced))
                    .frame(minHeight: 220)
                HStack {
                    PasteButton(payloadType: String.self) { strings in
                        let r = StateBlock.find(strings.joined(separator: "\n"), requireEnd: false)
                        DispatchQueue.main.async {
                            if let b = r.block { stateText = b } else { message = "El portapapeles no tiene un bloque <<<ESTADO" }
                        }
                    }
                    .labelStyle(.titleAndIcon)
                    Spacer()
                    Button("Guardar estado") {
                        let r = StateBlock.find(stateText, requireEnd: false)
                        let block = r.block ?? stateText.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !block.isEmpty else { message = "El estado está vacío"; return }
                        message = store.saveCheckpoint(p.id, slot: 0, block: block, type: HistoryEvent.edit) ? "Estado guardado" : "Sin cambios"
                    }
                    .buttonStyle(.borderedProminent)
                }
                .buttonStyle(.borderless)
            } header: {
                Text("Estado actual")
            } footer: {
                Text("Bloque <<<ESTADO … ESTADO>>> que se envía en el traspaso. Puedes editarlo o pegar uno nuevo.")
            }

            Section("Datos del proyecto") {
                TextField("Nombre", text: $name)
                TextField("Objetivo", text: $goal, axis: .vertical).lineLimit(2...6)
                TextField("Repositorio", text: $repo).keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Rama", text: $branch).textInputAutocapitalization(.never).autocorrectionDisabled()
                TextField("Indicaciones para cada sesión", text: $notes, axis: .vertical).lineLimit(2...8)
                Button("Guardar datos") {
                    do {
                        try store.updateProject(p.id, name: name, goal: goal, repo: repo, branch: branch, notes: notes)
                        message = "Datos guardados"
                    } catch {
                        message = error.localizedDescription
                    }
                }
            }

            Section("Historial") {
                if p.history.isEmpty { Text("Sin eventos.").foregroundStyle(Theme.text2) }
                ForEach(Array(p.history.enumerated().reversed()), id: \.offset) { item in
                    let e = item.element
                    if e.text.isEmpty {
                        Text("• " + Prompts.describe(e)).font(.footnote)
                    } else {
                        Button("▸ " + Prompts.describe(e)) { shownEvent = Ref(value: e) }.font(.footnote)
                    }
                }
            }

            Section("Exportar") {
                ShareLink(item: store.exportJSON(p.id), preview: SharePreview("\(p.name).relevo.json")) {
                    Label("Compartir JSON (para otro dispositivo)", systemImage: "square.and.arrow.up")
                }
                Button {
                    UIPasteboard.general.string = store.exportJSON(p.id)
                    message = "JSON copiado: impórtalo en Windows, Android u otro iPhone"
                } label: { Label("Copiar JSON", systemImage: "doc.on.doc") }
                ShareLink(item: Prompts.markdown(p, store.data)) { Label("Compartir resumen", systemImage: "text.alignleft") }
                Button("Eliminar proyecto", role: .destructive) { confirmDelete = true }
            }
        }
    }

    private func load(_ p: Project, force: Bool) {
        if force || loadedStamp != p.stateTime { stateText = p.state }
        if force {
            name = p.name
            goal = p.goal
            repo = p.repo
            branch = p.branch
            notes = p.notes
        }
        loadedStamp = p.stateTime
    }
}

// MARK: - Sheets

struct NewProjectSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let slot: Int
    let onCreated: (String) -> Void
    @State private var name = ""
    @State private var goal = ""
    @State private var repo = ""
    @State private var branch = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                TextField("Nombre del proyecto", text: $name)
                TextField("Objetivo: qué debe quedar terminado", text: $goal, axis: .vertical).lineLimit(2...6)
                Section("Opcional") {
                    TextField("Repositorio (https://github.com/…)", text: $repo)
                        .keyboardType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                    TextField("Rama", text: $branch).textInputAutocapitalization(.never).autocorrectionDisabled()
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Nuevo proyecto")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Crear") {
                        do {
                            let id = try store.createProject(name: name, goal: goal, repo: repo, branch: branch, slot: slot)
                            dismiss()
                            onCreated(id)
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
            }
        }
    }
}

struct ImportSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var error: String?
    @State private var pickFile = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $text)
                        .font(.system(.footnote, design: .monospaced))
                        .frame(minHeight: 200)
                    HStack {
                        PasteButton(payloadType: String.self) { strings in
                            DispatchQueue.main.async { text = strings.joined(separator: "\n") }
                        }
                        Spacer()
                        Button("Elegir archivo…") { pickFile = true }
                    }
                    .buttonStyle(.borderless)
                } footer: {
                    Text("Pega el JSON exportado desde Relevo (iPhone, Windows o Android) o un bloque <<<ESTADO … ESTADO>>> para crear un proyecto con él.")
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Importar proyecto")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Importar") { importText(text) }
                }
            }
            .fileImporter(isPresented: $pickFile, allowedContentTypes: [.json, .plainText, .text]) { result in
                guard case .success(let url) = result else { return }
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                if let content = try? String(contentsOf: url, encoding: .utf8) { importText(content) }
            }
        }
    }

    private func importText(_ content: String) {
        do {
            try store.importText(content)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
    }
}

/// Destination account, optional pause for the source account.
struct TransferSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let projectId: String
    let fromSlot: Int
    var unansweredWarning = false
    let onDone: (Int) -> Void
    @State private var target = 0
    @State private var pauseIndex = 0

    var body: some View {
        let now = Relevo.now()
        let targets = store.data.sortedAccounts.filter { $0.slot != fromSlot }
        NavigationStack {
            Form {
                if let p = store.data.project(projectId) {
                    Section {
                        Text("«\(p.name)» · \(p.progress)%" + (p.hasState ? " · estado guardado " + Prompts.ago(p.stateTime)
                                                                  : " · aún no hay estado guardado: se enviará el prompt de inicio."))
                            .font(.subheadline)
                        if unansweredWarning {
                            Text("Ojo: Claude aún no respondió al último «Pedir estado»; se pasará el estado guardado anterior.")
                                .font(.footnote).foregroundStyle(Theme.warn)
                        }
                    }
                }
                if targets.isEmpty {
                    Text("Agrega otra cuenta para poder pasar el proyecto.").foregroundStyle(Theme.text2)
                } else {
                    Picker("Pasar a", selection: $target) {
                        ForEach(targets) { a in Text(Prompts.accountLabel(a, now)).tag(a.slot) }
                    }
                    if let from = store.data.account(fromSlot) {
                        Picker("Pausar «\(from.name)»", selection: $pauseIndex) {
                            ForEach(pauseOptions.indices, id: \.self) { i in Text(pauseOptions[i].label).tag(i) }
                        }
                    }
                }
            }
            .navigationTitle("Pasar a otra cuenta")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Pasar") {
                        guard target > 0 else { return }
                        let until = store.transfer(projectId, from: fromSlot, to: target, pauseMs: pauseOptions[pauseIndex].ms)
                        if until > 0 { Notifier.schedule(slot: fromSlot, name: store.data.accountName(fromSlot), until: until) }
                        dismiss()
                        onDone(target)
                    }
                    .disabled(target == 0)
                }
            }
            .onAppear {
                if target == 0 {
                    target = (targets.first { !$0.isPaused(now) } ?? targets.first)?.slot ?? 0
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

struct AccountPickerSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let title: String
    var excluding: Int = 0
    let onPick: (Int) -> Void

    var body: some View {
        let now = Relevo.now()
        NavigationStack {
            List {
                if store.data.accounts.isEmpty { Text("Primero agrega una cuenta en la pestaña Cuentas.") }
                ForEach(store.data.sortedAccounts.filter { $0.slot != excluding }) { a in
                    Button {
                        dismiss()
                        onPick(a.slot)
                    } label: {
                        HStack { AccountDot(color: a.color); Text(Prompts.accountLabel(a, now)).foregroundStyle(.primary) }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

struct ProjectPickerSheet: View {
    @EnvironmentObject private var store: Store
    @Environment(\.dismiss) private var dismiss
    let onPick: (String) -> Void
    let onNew: () -> Void

    var body: some View {
        NavigationStack {
            List {
                ForEach(store.data.sortedProjects) { p in
                    Button {
                        dismiss()
                        onPick(p.id)
                    } label: {
                        Text("\(p.name) · \(p.progress)%").foregroundStyle(.primary)
                    }
                }
                Button {
                    dismiss()
                    onNew()
                } label: { Label("Nuevo proyecto…", systemImage: "plus") }
            }
            .navigationTitle("¿En qué proyecto trabaja esta cuenta?")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancelar") { dismiss() } } }
        }
        .presentationDetents([.medium, .large])
    }
}

struct TextViewerSheet: View {
    @Environment(\.dismiss) private var dismiss
    let title: String
    let text: String
    var action: String?
    var onAction: (() -> Void)?

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cerrar") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Menu {
                        Button { UIPasteboard.general.string = text } label: { Label("Copiar", systemImage: "doc.on.doc") }
                        if let action, let onAction {
                            Button {
                                onAction()
                                dismiss()
                            } label: { Label(action, systemImage: "arrow.uturn.backward") }
                        }
                    } label: { Image(systemName: "ellipsis.circle") }
                }
            }
        }
    }
}
