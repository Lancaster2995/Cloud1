package io.github.lancaster2995.relevo;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Notifies when a paused account is available again; re-arms alarms after a reboot. */
public class AlarmReceiver extends BroadcastReceiver {

    public static final String ACTION_READY = "io.github.lancaster2995.relevo.READY";
    public static final String EXTRA_SLOT = "slot";

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            Data d = Store.load(context);
            long now = System.currentTimeMillis();
            for (Data.Account a : d.accounts) {
                if (a.pausedUntil > now) Slots.schedulePauseEnd(context, a.slot, a.pausedUntil);
            }
            return;
        }
        if (!ACTION_READY.equals(action)) return;
        int slot = intent.getIntExtra(EXTRA_SLOT, 0);
        Data d = Store.load(context);
        Data.Account a = d.account(slot);
        if (a == null || a.pausedUntil > System.currentTimeMillis() + 60_000) return;
        notifyReady(context, a);
    }

    private static void notifyReady(Context context, Data.Account a) {
        NotificationManager nm = context.getSystemService(NotificationManager.class);
        if (nm == null) return;
        if (nm.getNotificationChannel(RelevoApp.CHANNEL_READY) == null) {
            nm.createNotificationChannel(new NotificationChannel(RelevoApp.CHANNEL_READY,
                    context.getString(R.string.channel_ready), NotificationManager.IMPORTANCE_DEFAULT));
        }
        Intent open = new Intent(context, Slots.activity(a.slot));
        open.putExtra(Slots.EXTRA_ACTION, Slots.ACTION_OPEN);
        open.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent pi = PendingIntent.getActivity(context, 200 + a.slot, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification n = new Notification.Builder(context, RelevoApp.CHANNEL_READY)
                .setSmallIcon(R.drawable.ic_stat)
                .setColor(Ui.parseColor(a.color, 0xFFD97757))
                .setContentTitle("«" + a.name + "» vuelve a estar disponible")
                .setContentText("Toca para abrir su ventana y seguir trabajando.")
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        try {
            nm.notify(300 + a.slot, n);
        } catch (SecurityException ignored) {
            // Notification permission not granted.
        }
    }
}
