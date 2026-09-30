package io.github.lancaster2995.relevo;

import static org.robolectric.Shadows.shadowOf;

import android.app.Activity;
import android.app.Application;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.Robolectric;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import org.robolectric.annotation.GraphicsMode;
import org.robolectric.shadows.ShadowDialog;

import java.io.File;
import java.io.FileOutputStream;

import io.github.lancaster2995.relevo.slots.Slot2Activity;

/**
 * Renders the main screens to PNG (build/screens) so the UI can be reviewed without a device.
 * CI publishes them under docs/screens.
 */
@RunWith(RobolectricTestRunner.class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = 34, qualifiers = "w393dp-h851dp-xxhdpi")
public class ScreenshotTest {

    private static final String STATE = "<<<ESTADO\nPROYECTO: App de inventario\nPROGRESO: 45%\n"
            + "RESUMEN: API y base de datos listas; falta la pantalla de escaneo.\n"
            + "HECHO:\n- Modelo de datos\n- API REST con autenticación\n"
            + "EN_PROGRESO:\n- Pantalla de escaneo (cámara ok, falta guardar)\n"
            + "SIGUIENTES_PASOS:\n- Guardar lecturas del escáner\n- Reporte de stock bajo\n"
            + "DECISIONES:\n- SQLite local + sincronización\nBLOQUEOS:\n- ninguno\n"
            + "ARCHIVOS_CLAVE:\n- app/scan.ts: escáner\nCONTEXTO_EXTRA:\nnpm run dev\nESTADO>>>";

    private String seed() {
        Application app = RuntimeEnvironment.getApplication();
        final long now = System.currentTimeMillis();
        Data d = Store.edit(app, data -> {
            data.accounts.clear();
            data.projects.clear();
            String[] names = {"Personal", "Trabajo", "Respaldo"};
            for (int i = 0; i < names.length; i++) {
                Data.Account a = new Data.Account();
                a.slot = i + 1;
                a.name = names[i];
                a.color = Data.COLORS[i];
                a.note = i == 0 ? "yo@gmail.com · Pro" : "";
                a.lastActive = now - (i + 1) * 600_000L;
                data.accounts.add(a);
            }
            data.account(1).pausedUntil = now + 2 * 3_600_000L + 900_000L;

            Data.Project p = new Data.Project();
            p.name = "App de inventario";
            p.goal = "App móvil para controlar el inventario de la tienda";
            p.repo = "https://github.com/usuario/inventario";
            p.branch = "main";
            p.state = STATE;
            p.progress = 45;
            p.stateTime = now - 1_200_000L;
            p.currentSlot = 2;
            p.created = now - 86_400_000L;
            p.updated = now - 600_000L;
            Data.Event c = new Data.Event();
            c.time = now - 1_300_000L;
            c.type = Data.Event.CHECKPOINT;
            c.slot = 1;
            c.accountName = "Personal";
            c.progress = 45;
            c.text = STATE;
            p.addEvent(c);
            Data.Event t = new Data.Event();
            t.time = now - 1_200_000L;
            t.type = Data.Event.TRANSFER;
            t.slot = 1;
            t.toSlot = 2;
            t.accountName = "Personal";
            t.toAccountName = "Trabajo";
            t.progress = 45;
            p.addEvent(t);
            p.pendingSlot = 2;
            data.projects.add(p);
            data.account(2).activeProjectId = p.id;

            Data.Project q = new Data.Project();
            q.name = "Landing page";
            q.goal = "Sitio de una página para el lanzamiento";
            q.currentSlot = 3;
            q.created = now - 3_600_000L;
            q.updated = now - 3_000_000L;
            data.projects.add(q);
        });
        return d.projects.get(0).id;
    }

    @Test
    public void captureScreens() throws Exception {
        String id = seed();
        MainActivity main = Robolectric.buildActivity(MainActivity.class).setup().get();
        save(main.getWindow().getDecorView(), "1-proyectos");
        click(main, "Cuentas");
        save(main.getWindow().getDecorView(), "2-cuentas");
        click(main, "Guía y ajustes");
        save(main.getWindow().getDecorView(), "3-guia");

        Slot2Activity session = Robolectric.buildActivity(Slot2Activity.class,
                new Intent(main, Slot2Activity.class)).setup().get();
        save(session.getWindow().getDecorView(), "4-ventana-sesion");

        Dialogs.transfer(session, id, 2);
        Dialog dlg = ShadowDialog.getLatestDialog();
        idle();
        save(dlg.getWindow().getDecorView(), "5-pasar-a-otra-cuenta");

        Intent i = new Intent(main, ProjectActivity.class).putExtra(ProjectActivity.EXTRA_ID, id);
        ProjectActivity project = Robolectric.buildActivity(ProjectActivity.class, i).setup().get();
        save(project.getWindow().getDecorView(), "6-proyecto");
    }

    @Test
    @Config(qualifiers = "+night")
    public void captureDarkScreens() throws Exception {
        seed();
        MainActivity main = Robolectric.buildActivity(MainActivity.class).setup().get();
        save(main.getWindow().getDecorView(), "7-proyectos-oscuro");
        Slot2Activity session = Robolectric.buildActivity(Slot2Activity.class,
                new Intent(main, Slot2Activity.class)).setup().get();
        save(session.getWindow().getDecorView(), "8-ventana-sesion-oscuro");
    }

    // ------------------------------------------------------------------ helpers

    private static void idle() {
        shadowOf(Looper.getMainLooper()).idle();
    }

    private static void click(Activity a, String text) {
        TextView t = find(a.getWindow().getDecorView(), text);
        if (t != null) t.performClick();
        idle();
    }

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

    private static void save(View root, String name) throws Exception {
        idle();
        int w = root.getWidth(), h = root.getHeight();
        if (w == 0 || h == 0) {
            w = root.getResources().getDisplayMetrics().widthPixels;
            h = root.getResources().getDisplayMetrics().heightPixels;
            root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY),
                    View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.AT_MOST));
            root.layout(0, 0, root.getMeasuredWidth(), root.getMeasuredHeight());
            w = root.getMeasuredWidth();
            h = root.getMeasuredHeight();
        }
        Bitmap bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        root.draw(new Canvas(bitmap));
        File dir = new File("build/screens");
        dir.mkdirs();
        try (FileOutputStream out = new FileOutputStream(new File(dir, name + ".png"))) {
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
        }
    }
}
