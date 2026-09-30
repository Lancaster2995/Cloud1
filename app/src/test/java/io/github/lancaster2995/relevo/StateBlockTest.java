package io.github.lancaster2995.relevo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.List;

import org.junit.Test;

public class StateBlockTest {

    private static final String ANSWER = "<<<ESTADO\n"
            + "PROYECTO: Tienda\n"
            + "PROGRESO: 45%\n"
            + "RESUMEN: Backend listo, falta el frontend.\n"
            + "HECHO:\n"
            + "- API de productos\n"
            + "- Autenticación\n"
            + "EN_PROGRESO:\n"
            + "- Carrito (falta el total)\n"
            + "SIGUIENTES_PASOS:\n"
            + "- Terminar el carrito\n"
            + "- Pagos con Stripe\n"
            + "DECISIONES:\n"
            + "- PostgreSQL por las transacciones\n"
            + "BLOQUEOS:\n"
            + "- ninguno\n"
            + "ARCHIVOS_CLAVE:\n"
            + "- api/server.ts: rutas\n"
            + "CONTEXTO_EXTRA:\n"
            + "npm run dev en el puerto 3000\n"
            + "ESTADO>>>";

    @Test
    public void findsAnswerAfterTemplateInConversation() {
        String page = "Tú: " + Prompts.checkpoint(project()) + "\n\nClaude:\n```\n" + ANSWER + "\n```\nCopiar";
        StateBlock.Result r = StateBlock.find(page, true);
        assertNotNull(r.block);
        assertFalse(r.newestIsTemplate);
        assertEquals(45, StateBlock.progress(r.block));
        assertTrue(r.block.startsWith(StateBlock.START));
        assertTrue(r.block.endsWith(StateBlock.END));
    }

    @Test
    public void unansweredTemplateIsReported() {
        String page = "Claude:\n```\n" + ANSWER + "\n```\nTú: " + Prompts.checkpoint(project());
        StateBlock.Result r = StateBlock.find(page, true);
        assertTrue(r.newestIsTemplate);
        // The older, real block is still found for callers that want it.
        assertNotNull(r.block);
    }

    @Test
    public void streamingBlockNeedsEndOnPageButNotOnClipboard() {
        String partial = ANSWER.substring(0, ANSWER.indexOf("DECISIONES"));
        assertNull(StateBlock.find(partial, true).block);
        StateBlock.Result clip = StateBlock.find(partial, false);
        assertNotNull(clip.block);
        assertEquals(45, StateBlock.progress(clip.block));
    }

    @Test
    public void sectionsAndItems() {
        List<String> next = StateBlock.items(ANSWER, "SIGUIENTES_PASOS");
        assertEquals(2, next.size());
        assertEquals("Terminar el carrito", next.get(0));
        assertEquals("Backend listo, falta el frontend.", StateBlock.section(ANSWER, "RESUMEN"));
        assertEquals("npm run dev en el puerto 3000", StateBlock.section(ANSWER, "CONTEXTO_EXTRA"));
        assertEquals(2, StateBlock.items(ANSWER, "HECHO").size());
    }

    @Test
    public void toleratesMarkdownDecoration() {
        String md = "<<<ESTADO\n**PROGRESO:** 120 %\n**SIGUIENTES_PASOS:**\n* uno\n* dos\nESTADO>>>";
        assertEquals(100, StateBlock.progress(md));
        assertEquals(2, StateBlock.items(md, "SIGUIENTES_PASOS").size());
    }

    @Test
    public void missingProgressIsMinusOne() {
        assertEquals(-1, StateBlock.progress("<<<ESTADO\nRESUMEN: x\nESTADO>>>"));
        assertNull(StateBlock.find("sin bloque", false).block);
    }

    @Test
    public void normalizeDropsFencesAndTrailingSpace() {
        String n = StateBlock.normalize("```\n<<<ESTADO   \nRESUMEN: a  \n\n\n\nHECHO:\nESTADO>>>\n```");
        assertEquals("<<<ESTADO\nRESUMEN: a\n\nHECHO:\nESTADO>>>", n);
    }

    @Test
    public void promptsCarryStateAndRepo() {
        Data.Project p = project();
        String start = Prompts.start(p);
        assertTrue(start.contains("«Tienda»"));
        assertTrue(start.contains("HANDOFF.md"));
        assertTrue(StateBlock.isTemplate(start));

        p.state = StateBlock.find(ANSWER, true).block;
        p.stateTime = 1_700_000_000_000L;
        String handoff = Prompts.handoff(p, new Data());
        assertTrue(handoff.contains("SIGUIENTES_PASOS"));
        assertTrue(handoff.contains("github.com/demo/tienda"));
        assertFalse(StateBlock.isTemplate(handoff));
        // A handoff pasted into a new chat must not be mistaken for an unanswered checkpoint.
        StateBlock.Result r = StateBlock.find("Tú: " + handoff, true);
        assertFalse(r.newestIsTemplate);
        assertEquals(p.state, r.block);
        assertEquals("Terminar el carrito", Prompts.nextStep(p));
    }

    private static Data.Project project() {
        Data.Project p = new Data.Project();
        p.name = "Tienda";
        p.goal = "Tienda online";
        p.repo = "https://github.com/demo/tienda";
        p.branch = "main";
        return p;
    }
}
