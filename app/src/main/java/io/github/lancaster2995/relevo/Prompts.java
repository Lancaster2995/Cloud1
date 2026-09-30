package io.github.lancaster2995.relevo;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/** Texts that move a project between sessions: start, handoff and checkpoint prompts. */
public final class Prompts {

    private Prompts() {
    }

    public static String template(String projectName) {
        return StateBlock.START + "\n"
                + "PROYECTO: " + (empty(projectName) ? "<nombre>" : projectName) + "\n"
                + "PROGRESO: " + StateBlock.PLACEHOLDER + "%\n"
                + "RESUMEN: <1-3 frases: en qué punto está el proyecto>\n"
                + "HECHO:\n"
                + "- <tarea completada>\n"
                + "EN_PROGRESO:\n"
                + "- <tarea a medias y exactamente dónde quedó>\n"
                + "SIGUIENTES_PASOS:\n"
                + "- <paso concreto, en orden>\n"
                + "DECISIONES:\n"
                + "- <decisión técnica y su motivo>\n"
                + "BLOQUEOS:\n"
                + "- <problema pendiente, o \"ninguno\">\n"
                + "ARCHIVOS_CLAVE:\n"
                + "- <ruta o artefacto: para qué sirve>\n"
                + "CONTEXTO_EXTRA:\n"
                + "<comandos, versiones, URLs o datos imprescindibles para continuar; sin contraseñas ni claves>\n"
                + StateBlock.END;
    }

    /** First message for a project that has no saved state yet. */
    public static String start(Data.Project p) {
        StringBuilder sb = new StringBuilder();
        sb.append("Vamos a desarrollar el proyecto «").append(p.name).append("».\n\n");
        if (!empty(p.goal)) sb.append("Objetivo: ").append(p.goal.trim()).append("\n");
        appendRepo(sb, p, false);
        if (!empty(p.notes)) sb.append("\nContexto e indicaciones:\n").append(p.notes.trim()).append("\n");
        sb.append("\nEste trabajo se hará en varias sesiones y puede continuar en otra conversación. Por eso:\n");
        sb.append("1. Avanza por etapas y termina cada respuesta indicando qué quedó hecho y qué sigue.\n");
        sb.append("2. Cuando te escriba «CHECKPOINT», responde únicamente con el bloque de estado, dentro de un bloque de código, con este formato:\n\n");
        sb.append("```\n").append(template(p.name)).append("\n```\n");
        if (!empty(p.repo)) {
            sb.append("3. Haz commit y push de cada avance y mantén ese mismo bloque actualizado en HANDOFF.md, en la raíz del repositorio.\n");
        }
        sb.append("\nEmpecemos: propón un plan breve por etapas y comienza con la primera.");
        return sb.toString();
    }

    /** Message that lets a fresh session (usually another account) pick the project up. */
    public static String handoff(Data.Project p, Data d) {
        if (!p.hasState()) return start(p);
        StringBuilder sb = new StringBuilder();
        sb.append("Continúo el proyecto «").append(p.name)
                .append("», que se venía desarrollando en otra sesión. Este es su último estado registrado");
        if (p.stateTime > 0) sb.append(" (").append(stamp(p.stateTime)).append(")");
        sb.append(":\n\n```\n").append(p.state.trim()).append("\n```\n\n");
        if (!empty(p.goal)) sb.append("Objetivo general: ").append(p.goal.trim()).append("\n");
        appendRepo(sb, p, true);
        if (!empty(p.notes)) sb.append("\nContexto e indicaciones:\n").append(p.notes.trim()).append("\n");
        sb.append("\nInstrucciones:\n");
        sb.append("- Retoma desde SIGUIENTES_PASOS sin rehacer lo que ya está HECHO.\n");
        sb.append("- Respeta las DECISIONES tomadas salvo que encuentres un problema; si es así, explícalo.\n");
        sb.append("- Si te falta información imprescindible, pregúntame antes de suponer.\n");
        sb.append("- Cuando te escriba «CHECKPOINT», responde solo con el bloque de estado actualizado, con el mismo formato que el de arriba y dentro de un bloque de código.\n");
        if (!empty(p.repo)) sb.append("- Haz commit y push de cada avance y mantén HANDOFF.md actualizado.\n");
        sb.append("\nPrimero confirma en 2-3 líneas lo que entiendes del estado y el siguiente paso; luego continúa.");
        return sb.toString();
    }

    /** Asks the current session to summarize itself in the parseable format. */
    public static String checkpoint(Data.Project p) {
        String name = p != null ? p.name : "";
        StringBuilder sb = new StringBuilder();
        sb.append("CHECKPOINT. Voy a continuar este proyecto en otra sesión. Responde ÚNICAMENTE con el estado actualizado, dentro de un bloque de código, usando exactamente este formato (sin texto antes ni después):\n\n");
        sb.append("```\n").append(template(name)).append("\n```\n");
        sb.append("\nSé concreto: el objetivo es que otra sesión sin memoria de esta conversación pueda continuar sin perder nada.");
        if (p != null && !empty(p.repo)) {
            sb.append(" Antes de responder, haz commit y push de los cambios pendientes y guarda el bloque en HANDOFF.md.");
        }
        return sb.toString();
    }

    /** The prompt a session window should offer for this project right now. */
    public static String next(Data.Project p, Data d) {
        return p.hasState() ? handoff(p, d) : start(p);
    }

    public static String markdown(Data.Project p, Data d) {
        StringBuilder sb = new StringBuilder();
        sb.append("# ").append(p.name).append("\n\n");
        if (!empty(p.goal)) sb.append("**Objetivo:** ").append(p.goal.trim()).append("\n\n");
        if (!empty(p.repo)) {
            sb.append("**Repositorio:** ").append(p.repo.trim());
            if (!empty(p.branch)) sb.append(" (rama ").append(p.branch.trim()).append(")");
            sb.append("\n\n");
        }
        sb.append("**Progreso:** ").append(p.progress).append("%  \n");
        sb.append("**Cuenta actual:** ").append(d.accountName(p.currentSlot)).append("\n\n");
        if (!empty(p.notes)) sb.append("## Indicaciones\n\n").append(p.notes.trim()).append("\n\n");
        sb.append("## Estado actual\n\n```\n")
                .append(p.hasState() ? p.state.trim() : "(sin estado guardado todavía)")
                .append("\n```\n\n## Historial\n\n");
        for (int i = p.history.size() - 1; i >= 0; i--) {
            sb.append("- ").append(describe(p.history.get(i))).append("\n");
        }
        return sb.toString();
    }

    public static String describe(Data.Event e) {
        StringBuilder sb = new StringBuilder(stamp(e.time)).append(" · ");
        switch (e.type) {
            case Data.Event.CREATE:
                sb.append("Proyecto creado");
                break;
            case Data.Event.TRANSFER:
                if (e.slot == 0) {
                    sb.append("Asignado a ").append(nameOr(e.toAccountName, e.toSlot));
                } else {
                    sb.append("Traspaso ").append(nameOr(e.accountName, e.slot)).append(" → ")
                            .append(nameOr(e.toAccountName, e.toSlot));
                }
                break;
            case Data.Event.EDIT:
                sb.append("Estado editado a mano");
                break;
            case Data.Event.RESTORE:
                sb.append("Estado restaurado");
                break;
            default:
                sb.append("Checkpoint desde ").append(nameOr(e.accountName, e.slot));
        }
        if (e.progress >= 0) sb.append(" · ").append(e.progress).append("%");
        return sb.toString();
    }

    public static String summary(Data.Project p) {
        if (!p.hasState()) return "";
        String s = StateBlock.section(p.state, "RESUMEN");
        return s == null ? "" : s;
    }

    public static String nextStep(Data.Project p) {
        if (!p.hasState()) return "";
        List<String> steps = StateBlock.items(p.state, "SIGUIENTES_PASOS");
        return steps.isEmpty() ? "" : steps.get(0);
    }

    public static String stamp(long t) {
        return new SimpleDateFormat("d MMM HH:mm", new Locale("es")).format(new Date(t));
    }

    private static void appendRepo(StringBuilder sb, Data.Project p, boolean handoff) {
        if (empty(p.repo)) return;
        sb.append("Repositorio: ").append(p.repo.trim());
        if (!empty(p.branch)) sb.append(" (rama ").append(p.branch.trim()).append(")");
        sb.append("\n");
        if (handoff) {
            sb.append("Antes de seguir, revisa el repositorio y HANDOFF.md para confirmar el estado real del código.\n");
        }
    }

    private static String nameOr(String name, int slot) {
        return empty(name) ? "Cuenta " + slot : name;
    }

    static boolean empty(String s) {
        return s == null || s.trim().isEmpty();
    }
}
