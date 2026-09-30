package io.github.lancaster2995.relevo;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.robolectric.Shadows.shadowOf;

import android.app.AlertDialog;
import android.app.Application;
import android.app.NotificationManager;
import android.content.Intent;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.TextView;

import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.shadows.ShadowAlertDialog;

import io.github.lancaster2995.relevo.slots.Slot1Activity;
import io.github.lancaster2995.relevo.slots.Slot2Activity;

/** Drives the real screens on the JVM to catch crashes and wiring mistakes. */
@RunWith(RobolectricTestRunner.class)
@Config(sdk = 34)
public class AppSmokeTest {

    private static final String ANSWER = "<<<ESTADO\nPROYECTO: Tienda\nPROGRESO: 60%\n"
            + "RESUMEN: Carrito listo.\nHECHO:\n- Carrito\nSIGUIENTES_PASOS:\n- Pagos\nESTADO>>>";

    private Application app;
    private String projectId;

    @Before
    public void seed() {
        app = RuntimeEnvironment.getApplication();
        Data d = Store.edit(app, data -> {
            data.accounts.clear();
            data.projects.clear();
            for (int slot = 1; slot <= 2; slot++) {
                Data.Account a = new Data.Account();
                a.slot = slot;
                a.name = "Cuenta " + (slot == 1 ? "A" : "B");
                a.color = Data.COLORS[slot];
                data.accounts.add(a);
            }
            Data.Project p = new Data.Project();
            p.name = "Tienda";
            p.goal = "Tienda online";
            p.currentSlot = 1;
            p.created = p.updated = System.currentTimeMillis();
            data.projects.add(p);
            data.account(1).activeProjectId = p.id;
        });
        projectId = d.projects.get(0).id;
    }

    @Test
    public void dashboardRendersEveryTab() {
        MainActivity a = Robolectric.buildActivity(MainActivity.class).setup().get();
        View root = a.getWindow().getDecorView();
        assertNotNull(find(root, "Tienda"));
        click(root, "Cuentas");
        assertNotNull(find(root, "Cuenta A"));
        assertNotNull(find(root, "Disponible"));
        click(root, "Guía y ajustes");
        assertNotNull(find(root, "Cómo funciona"));
        click(root, "Proyectos");
        click(root, "+ Nuevo proyecto");
        assertNotNull(ShadowAlertDialog.getLatestAlertDialog());
    }

    @Test
    public void checkpointsUpdateProgressOnce() {
        assertTrue(Slots.saveCheckpoint(app, projectId, 1, ANSWER, Data.Event.CHECKPOINT));
        assertFalse(Slots.saveCheckpoint(app, projectId, 1, ANSWER, Data.Event.CHECKPOINT));
        Data.Project p = Store.load(app).project(projectId);
        assertEquals(60, p.progress);
        assertEquals(1, p.history.size());
        assertEquals("Pagos", Prompts.nextStep(p));
    }

    @Test
    public void transferRecordsEventPausesSourceAndOpensTarget() {
        MainActivity a = Robolectric.buildActivity(MainActivity.class).setup().get();
        long before = System.currentTimeMillis();
        Slots.transfer(a, projectId, 1, 2, 3_600_000L, false);
        Data d = Store.load(app);
        Data.Project p = d.project(projectId);
        assertEquals(2, p.currentSlot);
        assertEquals(2, p.pendingSlot);
        assertEquals(projectId, d.account(2).activeProjectId);
        assertTrue(d.account(1).pausedUntil >= before + 3_600_000L);
        assertEquals(Data.Event.TRANSFER, p.history.get(p.history.size() - 1).type);
        Intent next = shadowOf(a).getNextStartedActivity();
        assertEquals(Slot2Activity.class.getName(), next.getComponent().getClassName());
        assertEquals(Slots.ACTION_HANDOFF, next.getStringExtra(Slots.EXTRA_ACTION));
    }

    @Test
    public void transferDialogPassesProject() {
        MainActivity a = Robolectric.buildActivity(MainActivity.class).setup().get();
        Dialogs.transfer(a, projectId, 1);
        AlertDialog dlg = (AlertDialog) ShadowAlertDialog.getLatestDialog();
        assertNotNull(dlg);
        dlg.getButton(AlertDialog.BUTTON_POSITIVE).performClick();
        // AlertDialog delivers button clicks through the main looper.
        shadowOf(Looper.getMainLooper()).idle();
        assertEquals(2, Store.load(app).project(projectId).pendingSlot);
    }

    @Test
    public void sessionWindowLoadsStartPageAndOffersPendingHandoff() {
        Store.edit(app, d -> d.project(projectId).pendingSlot = 2);
        Slot2Activity s = Robolectric.buildActivity(Slot2Activity.class, new Intent(app, Slot2Activity.class))
                .setup().get();
        View root = s.getWindow().getDecorView();
        WebView web = findWebView(root);
        assertNotNull(web);
        assertEquals(Data.URL_CHAT, shadowOf(web).getLastLoadedUrl());
        TextView insert = find(root, "Insertar prompt");
        assertNotNull(insert);
        assertTrue(insert.isShown());
        insert.performClick();
        assertNotNull(shadowOf(web).getLastEvaluatedJavascript());
        // Toolbar actions must not crash even before the page answers.
        click(root, "🧭 Pedir estado");
        click(root, "💾 Guardar");
        click(root, "⇄ Pasar");
        s.onBackPressed();
    }

    @Test
    public void sessionWindowForUnknownSlotCreatesAccount() {
        Store.edit(app, d -> d.accounts.clear());
        Robolectric.buildActivity(Slot1Activity.class, new Intent(app, Slot1Activity.class)).setup();
        assertNotNull(Store.load(app).account(1));
    }

    @Test
    public void projectScreenRenders() {
        Slots.saveCheckpoint(app, projectId, 1, ANSWER, Data.Event.CHECKPOINT);
        Intent i = new Intent(app, ProjectActivity.class).putExtra(ProjectActivity.EXTRA_ID, projectId);
        ProjectActivity a = Robolectric.buildActivity(ProjectActivity.class, i).setup().get();
        View root = a.getWindow().getDecorView();
        assertNotNull(find(root, "Historial"));
        click(root, "Guardar datos");
        click(root, "Exportar JSON");
    }

    @Test
    public void importJsonAndStateBlock() throws Exception {
        String json = Store.load(app).project(projectId).toJson().toString();
        Dialogs.importText(app, json);
        Dialogs.importText(app, "hola\n" + ANSWER);
        Data d = Store.load(app);
        assertEquals(3, d.projects.size());
        boolean fromBlock = false;
        for (Data.Project p : d.projects) if (p.progress == 60 && p.hasState()) fromBlock = true;
        assertTrue(fromBlock);
    }

    @Test
    public void pauseEndNotifies() {
        Store.edit(app, d -> d.account(1).pausedUntil = System.currentTimeMillis() - 1000);
        Intent i = new Intent(AlarmReceiver.ACTION_READY).putExtra(AlarmReceiver.EXTRA_SLOT, 1);
        new AlarmReceiver().onReceive(app, i);
        NotificationManager nm = app.getSystemService(NotificationManager.class);
        assertEquals(1, shadowOf(nm).getAllNotifications().size());
    }

    // ------------------------------------------------------------------ helpers

    private static TextView find(View v, String text) {
        if (v instanceof TextView && text.equals(((TextView) v).getText().toString())) return (TextView) v;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                TextView t = find(g.getChildAt(i), text);
                if (t != null) return t;
            }
        }
        return null;
    }

    private static void click(View root, String text) {
        TextView t = find(root, text);
        assertNotNull("no view with text " + text, t);
        t.performClick();
    }

    private static WebView findWebView(View v) {
        if (v instanceof WebView) return (WebView) v;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) {
                WebView w = findWebView(g.getChildAt(i));
                if (w != null) return w;
            }
        }
        return null;
    }
}
