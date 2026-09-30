import Foundation

/// Texts that move a project between sessions (same wording as Android and Windows).
enum Prompts {
    static func template(_ projectName: String) -> String {
        [
            StateBlock.start,
            "PROYECTO: " + (blank(projectName) ? "<nombre>" : projectName),
            "PROGRESO: " + StateBlock.placeholder + "%",
            "RESUMEN: <1-3 frases: en qué punto está el proyecto>",
            "HECHO:",
            "- <tarea completada>",
            "EN_PROGRESO:",
            "- <tarea a medias y exactamente dónde quedó>",
            "SIGUIENTES_PASOS:",
            "- <paso concreto, en orden>",
            "DECISIONES:",
            "- <decisión técnica y su motivo>",
            "BLOQUEOS:",
            "- <problema pendiente, o \"ninguno\">",
            "ARCHIVOS_CLAVE:",
            "- <ruta o artefacto: para qué sirve>",
            "CONTEXTO_EXTRA:",
            "<comandos, versiones, URLs o datos imprescindibles para continuar; sin contraseñas ni claves>",
            StateBlock.end
        ].joined(separator: "\n")
    }

    static func start(_ p: Project) -> String {
        var s = "Vamos a desarrollar el proyecto «\(p.name)».\n\n"
        if !blank(p.goal) { s += "Objetivo: \(trim(p.goal))\n" }
        s += repoLines(p, handoff: false)
        if !blank(p.notes) { s += "\nContexto e indicaciones:\n\(trim(p.notes))\n" }
        s += "\nEste trabajo se hará en varias sesiones y puede continuar en otra conversación. Por eso:\n"
        s += "1. Avanza por etapas y termina cada respuesta indicando qué quedó hecho y qué sigue.\n"
        s += "2. Cuando te escriba «CHECKPOINT», responde únicamente con el bloque de estado, dentro de un bloque de código, con este formato:\n\n"
        s += "```\n" + template(p.name) + "\n```\n"
        if !blank(p.repo) {
            s += "3. Haz commit y push de cada avance y mantén ese mismo bloque actualizado en HANDOFF.md, en la raíz del repositorio.\n"
        }
        s += "\nEmpecemos: propón un plan breve por etapas y comienza con la primera."
        return s
    }

    static func handoff(_ p: Project) -> String {
        guard p.hasState else { return start(p) }
        var s = "Continúo el proyecto «\(p.name)», que se venía desarrollando en otra sesión. Este es su último estado registrado"
        if p.stateTime > 0 { s += " (\(stamp(p.stateTime)))" }
        s += ":\n\n```\n" + trim(p.state) + "\n```\n\n"
        if !blank(p.goal) { s += "Objetivo general: \(trim(p.goal))\n" }
        s += repoLines(p, handoff: true)
        if !blank(p.notes) { s += "\nContexto e indicaciones:\n\(trim(p.notes))\n" }
        s += "\nInstrucciones:\n"
        s += "- Retoma desde SIGUIENTES_PASOS sin rehacer lo que ya está HECHO.\n"
        s += "- Respeta las DECISIONES tomadas salvo que encuentres un problema; si es así, explícalo.\n"
        s += "- Si te falta información imprescindible, pregúntame antes de suponer.\n"
        s += "- Cuando te escriba «CHECKPOINT», responde solo con el bloque de estado actualizado, con el mismo formato que el de arriba y dentro de un bloque de código.\n"
        if !blank(p.repo) { s += "- Haz commit y push de cada avance y mantén HANDOFF.md actualizado.\n" }
        s += "\nPrimero confirma en 2-3 líneas lo que entiendes del estado y el siguiente paso; luego continúa."
        return s
    }

    static func checkpoint(_ p: Project?) -> String {
        var s = "CHECKPOINT. Voy a continuar este proyecto en otra sesión. Responde ÚNICAMENTE con el estado actualizado, dentro de un bloque de código, usando exactamente este formato (sin texto antes ni después):\n\n"
        s += "```\n" + template(p?.name ?? "") + "\n```\n"
        s += "\nSé concreto: el objetivo es que otra sesión sin memoria de esta conversación pueda continuar sin perder nada."
        if let p, !blank(p.repo) {
            s += " Antes de responder, haz commit y push de los cambios pendientes y guarda el bloque en HANDOFF.md."
        }
        return s
    }

    static func next(_ p: Project) -> String { p.hasState ? handoff(p) : start(p) }

    static func markdown(_ p: Project, _ d: AppData) -> String {
        var s = "# \(p.name)\n\n"
        if !blank(p.goal) { s += "**Objetivo:** \(trim(p.goal))\n\n" }
        if !blank(p.repo) {
            s += "**Repositorio:** \(trim(p.repo))"
            if !blank(p.branch) { s += " (rama \(trim(p.branch)))" }
            s += "\n\n"
        }
        s += "**Progreso:** \(p.progress)%  \n"
        s += "**Cuenta actual:** \(d.accountName(p.currentSlot))\n\n"
        if !blank(p.notes) { s += "## Indicaciones\n\n\(trim(p.notes))\n\n" }
        s += "## Estado actual\n\n```\n" + (p.hasState ? trim(p.state) : "(sin estado guardado todavía)") + "\n```\n\n## Historial\n\n"
        for e in p.history.reversed() { s += "- \(describe(e))\n" }
        return s
    }

    static func describe(_ e: HistoryEvent) -> String {
        func nameOr(_ n: String, _ slot: Int) -> String { blank(n) ? "Cuenta \(slot)" : n }
        var s = stamp(e.time) + " · "
        switch e.type {
        case HistoryEvent.create: s += "Proyecto creado"
        case HistoryEvent.transfer:
            s += e.slot == 0 ? "Asignado a \(nameOr(e.toAccountName, e.toSlot))"
                : "Traspaso \(nameOr(e.accountName, e.slot)) → \(nameOr(e.toAccountName, e.toSlot))"
        case HistoryEvent.edit: s += "Estado editado a mano"
        case HistoryEvent.restore: s += "Estado restaurado"
        default: s += "Checkpoint desde \(nameOr(e.accountName, e.slot))"
        }
        if e.progress >= 0 { s += " · \(e.progress)%" }
        return s
    }

    static func summary(_ p: Project) -> String { p.hasState ? (StateBlock.section(p.state, "RESUMEN") ?? "") : "" }
    static func nextStep(_ p: Project) -> String { p.hasState ? (StateBlock.items(p.state, "SIGUIENTES_PASOS").first ?? "") : "" }

    // MARK: formatting

    static func stamp(_ t: Int64) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "es")
        f.dateFormat = "d MMM HH:mm"
        return f.string(from: Date(timeIntervalSince1970: Double(t) / 1000))
    }

    static func clock(_ t: Int64) -> String {
        let date = Date(timeIntervalSince1970: Double(t) / 1000)
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        let hm = f.string(from: date)
        let cal = Calendar.current
        if cal.isDateInToday(date) { return hm }
        if cal.isDateInTomorrow(date) { return "mañana " + hm }
        let d = cal.dateComponents([.day, .month], from: date)
        return "\(d.day ?? 0)/\(d.month ?? 0) " + hm
    }

    static func ago(_ t: Int64) -> String {
        if t <= 0 { return "nunca" }
        let s = (Relevo.now() - t) / 1000
        if s < 60 { return "hace un momento" }
        let m = s / 60
        if m < 60 { return "hace \(m) min" }
        let h = m / 60
        if h < 24 { return "hace \(h) h" }
        let d = h / 24
        return d == 1 ? "hace 1 día" : "hace \(d) días"
    }

    static func duration(_ ms: Int64) -> String {
        let total = max(1, (ms + 59_999) / 60_000)
        let h = total / 60, m = total % 60
        if h == 0 { return "\(m) min" }
        if m == 0 { return "\(h) h" }
        return "\(h) h \(m) min"
    }

    static func accountLabel(_ a: Account, _ now: Int64 = Relevo.now()) -> String {
        a.isPaused(now) ? "\(a.name) — en pausa (\(duration(a.pausedUntil - now)))" : "\(a.name) — disponible"
    }

    static func blank(_ s: String?) -> Bool { (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    private static func repoLines(_ p: Project, handoff: Bool) -> String {
        guard !blank(p.repo) else { return "" }
        var s = "Repositorio: \(trim(p.repo))"
        if !blank(p.branch) { s += " (rama \(trim(p.branch)))" }
        s += "\n"
        if handoff { s += "Antes de seguir, revisa el repositorio y HANDOFF.md para confirmar el estado real del código.\n" }
        return s
    }
}
