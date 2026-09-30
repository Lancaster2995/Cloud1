package io.github.lancaster2995.relevo;

import android.app.ActivityOptions;
import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Rect;
import android.util.DisplayMetrics;

import io.github.lancaster2995.relevo.slots.Slot1Activity;
import io.github.lancaster2995.relevo.slots.Slot2Activity;
import io.github.lancaster2995.relevo.slots.Slot3Activity;
import io.github.lancaster2995.relevo.slots.Slot4Activity;
import io.github.lancaster2995.relevo.slots.Slot5Activity;
import io.github.lancaster2995.relevo.slots.Slot6Activity;
import io.github.lancaster2995.relevo.slots.Slot7Activity;
import io.github.lancaster2995.relevo.slots.Slot8Activity;

/**
 * Each account lives in a numbered slot. A slot is an activity declared in its own process with
 * its own WebView data directory, so its cookies/login never mix with the other accounts, and in
 * its own task, so it shows up as a separate window (Recents, split screen, DeX / desktop mode).
 */
public final class Slots {

    public static final String EXTRA_ACTION = "relevo.action";
    public static final String ACTION_OPEN = "open";
    public static final String ACTION_CLEAR = "clear";
    public static final String ACTION_CLEAR_AND_CLOSE = "clear_close";
    public static final String ACTION_HANDOFF = "handoff";

    private static final Class<?>[] ACTIVITIES = {
            Slot1Activity.class, Slot2Activity.class, Slot3Activity.class, Slot4Activity.class,
            Slot5Activity.class, Slot6Activity.class, Slot7Activity.class, Slot8Activity.class
    };

    private Slots() {
    }

    public static Class<?> activity(int slot) {
        return ACTIVITIES[slot - 1];
    }

    public static void open(Context c, int slot, boolean adjacent) {
        launch(c, slot, ACTION_OPEN, adjacent);
    }

    public static void launch(Context c, int slot, String action, boolean adjacent) {
        if (slot < 1 || slot > Data.MAX_SLOTS) return;
        Intent i = new Intent(c, activity(slot));
        i.putExtra(EXTRA_ACTION, action);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        if (adjacent) i.addFlags(Intent.FLAG_ACTIVITY_LAUNCH_ADJACENT);
        if (!c.getPackageManager().hasSystemFeature(PackageManager.FEATURE_FREEFORM_WINDOW_MANAGEMENT)) {
            c.startActivity(i);
            return;
        }
        // Free-form windowing (DeX, desktop mode, some tablets): cascade the windows.
        ActivityOptions options = ActivityOptions.makeBasic();
        DisplayMetrics dm = c.getResources().getDisplayMetrics();
        int w = (int) (dm.widthPixels * 0.62f), h = (int) (dm.heightPixels * 0.72f);
        int step = Ui.dp(c, 36) * (slot - 1);
        int left = Math.min(step, Math.max(0, dm.widthPixels - w));
        int top = Math.min(step, Math.max(0, dm.heightPixels - h));
        options.setLaunchBounds(new Rect(left, top, left + w, top + h));
        c.startActivity(i, options.toBundle());
    }

    // ------------------------------------------------------------ pause alarms

    public static void schedulePauseEnd(Context c, int slot, long when) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = alarmIntent(c, slot);
        am.cancel(pi);
        if (when > System.currentTimeMillis()) {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, when, pi);
        }
    }

    public static void cancelPauseEnd(Context c, int slot) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(alarmIntent(c, slot));
    }

    private static PendingIntent alarmIntent(Context c, int slot) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(AlarmReceiver.ACTION_READY);
        i.putExtra(AlarmReceiver.EXTRA_SLOT, slot);
        return PendingIntent.getBroadcast(c, 100 + slot, i,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    // ------------------------------------------------------------ transfers

    /**
     * Records a handoff of {@code projectId} from one slot to another, optionally pausing the
     * source account, and opens the destination window, which then offers the handoff prompt.
     */
    public static void transfer(Context c, String projectId, int fromSlot, int toSlot, long pauseMs,
                                boolean adjacent) {
        final long now = System.currentTimeMillis();
        final long[] pausedUntil = {0};
        Store.edit(c, d -> {
            Data.Project p = d.project(projectId);
            if (p == null) return;
            Data.Event e = new Data.Event();
            e.time = now;
            e.type = Data.Event.TRANSFER;
            e.slot = fromSlot;
            e.toSlot = toSlot;
            e.accountName = d.accountName(fromSlot);
            e.toAccountName = d.accountName(toSlot);
            e.progress = p.progress;
            p.addEvent(e);
            p.currentSlot = toSlot;
            p.pendingSlot = toSlot;
            p.updated = now;
            Data.Account to = d.account(toSlot);
            if (to != null) to.activeProjectId = p.id;
            Data.Account from = d.account(fromSlot);
            if (from != null && pauseMs > 0 && fromSlot != toSlot) {
                from.pausedUntil = now + pauseMs;
                pausedUntil[0] = from.pausedUntil;
            }
        });
        if (pausedUntil[0] > 0) schedulePauseEnd(c, fromSlot, pausedUntil[0]);
        launch(c, toSlot, ACTION_HANDOFF, adjacent);
    }

    /** Saves a new checkpoint state for a project. Returns false if it equals the current one. */
    public static boolean saveCheckpoint(Context c, String projectId, int slot, String block,
                                         String type) {
        final boolean[] changed = {false};
        final long now = System.currentTimeMillis();
        Store.edit(c, d -> {
            Data.Project p = d.project(projectId);
            if (p == null) return;
            String normalized = StateBlock.normalize(block);
            if (normalized.equals(StateBlock.normalize(p.state == null ? "" : p.state))) return;
            changed[0] = true;
            p.state = normalized;
            int progress = StateBlock.progress(normalized);
            if (progress >= 0) p.progress = progress;
            p.stateTime = now;
            p.updated = now;
            if (slot > 0) p.currentSlot = slot;
            Data.Event e = new Data.Event();
            e.time = now;
            e.type = type;
            e.slot = slot;
            e.accountName = d.accountName(slot);
            e.progress = progress >= 0 ? progress : p.progress;
            e.text = normalized;
            p.addEvent(e);
        });
        return changed[0];
    }
}
