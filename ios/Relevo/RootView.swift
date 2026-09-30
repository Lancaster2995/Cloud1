import SwiftUI

struct RootView: View {
    @EnvironmentObject private var store: Store
    @EnvironmentObject private var router: Router
    @EnvironmentObject private var sessions: WebSessions
    @State private var appliedLaunchArguments = false

    var body: some View {
        TabView(selection: $router.tab) {
            NavigationStack(path: $router.projectPath) {
                ProjectsView()
                    .navigationDestination(for: String.self) { id in ProjectDetailView(projectId: id) }
            }
            .tabItem { Label("Proyectos", systemImage: "square.stack.3d.up") }
            .tag(Router.Tab.projects)

            NavigationStack { AccountsView() }
                .tabItem { Label("Cuentas", systemImage: "person.2") }
                .tag(Router.Tab.accounts)

            NavigationStack { GuideView() }
                .tabItem { Label("Guía", systemImage: "questionmark.circle") }
                .tag(Router.Tab.guide)
        }
        .tint(Theme.accent)
        .fullScreenCover(isPresented: $router.sessionOpen) {
            SessionScreen()
                .environmentObject(store)
                .environmentObject(router)
                .environmentObject(sessions)
        }
        .onAppear(perform: applyLaunchArguments)
    }

    /// `-RelevoScreen accounts|guide|detail|session` opens a screen directly (screenshots).
    private func applyLaunchArguments() {
        guard !appliedLaunchArguments else { return }
        appliedLaunchArguments = true
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-RelevoScreen"), i + 1 < args.count else { return }
        switch args[i + 1] {
        case "accounts": router.tab = .accounts
        case "guide": router.tab = .guide
        case "detail":
            if let p = store.data.sortedProjects.first { router.projectPath = [p.id] }
        case "session":
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { router.open(2) }
        default: break
        }
    }
}

/// Sample data for screenshots (`-RelevoDemo`).
enum DemoData {
    static let state = """
    <<<ESTADO
    PROYECTO: App de inventario
    PROGRESO: 45%
    RESUMEN: API y base de datos listas; falta la pantalla de escaneo.
    HECHO:
    - Modelo de datos
    - API REST con autenticación
    EN_PROGRESO:
    - Pantalla de escaneo (cámara ok, falta guardar)
    SIGUIENTES_PASOS:
    - Guardar lecturas del escáner
    - Reporte de stock bajo
    DECISIONES:
    - SQLite local + sincronización
    BLOQUEOS:
    - ninguno
    ARCHIVOS_CLAVE:
    - app/scan.ts: escáner
    CONTEXTO_EXTRA:
    npm run dev
    ESTADO>>>
    """

    static func make() -> AppData {
        let now = Relevo.now()
        var d = AppData()
        let names = ["Personal", "Trabajo", "Respaldo"]
        for (i, name) in names.enumerated() {
            var a = Account(slot: i + 1)
            a.name = name
            a.note = i == 0 ? "yo@icloud.com · Pro" : ""
            a.lastActive = now - Int64(i + 1) * 600_000
            d.accounts.append(a)
        }
        d.accounts[0].pausedUntil = now + 2 * 3_600_000 + 900_000

        var p = Project()
        p.id = "demo-inventario"
        p.name = "App de inventario"
        p.goal = "App móvil para controlar el inventario de la tienda"
        p.repo = "https://github.com/usuario/inventario"
        p.branch = "main"
        p.state = state
        p.progress = 45
        p.stateTime = now - 1_200_000
        p.currentSlot = 2
        p.pendingSlot = 2
        p.created = now - 86_400_000
        p.updated = now - 600_000
        p.add(HistoryEvent(time: now - 1_300_000, type: HistoryEvent.checkpoint, slot: 1, progress: 45, accountName: "Personal", text: state))
        p.add(HistoryEvent(time: now - 1_200_000, type: HistoryEvent.transfer, slot: 1, toSlot: 2, progress: 45,
                           accountName: "Personal", toAccountName: "Trabajo"))
        d.projects.append(p)
        d.accounts[1].activeProjectId = p.id

        var q = Project()
        q.id = "demo-landing"
        q.name = "Landing page"
        q.goal = "Sitio de una página para el lanzamiento"
        q.currentSlot = 3
        q.created = now - 3_600_000
        q.updated = now - 3_000_000
        d.projects.append(q)
        return d
    }
}
