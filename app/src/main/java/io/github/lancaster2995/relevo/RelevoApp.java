package io.github.lancaster2995.relevo;

import android.app.Application;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.webkit.WebView;

public class RelevoApp extends Application {

    public static final String CHANNEL_READY = "ready";

    @Override
    public void onCreate() {
        super.onCreate();
        // Session windows run in processes named "<package>:sN". Giving each one its own WebView
        // data directory isolates cookies, local storage and cache, i.e. one login per slot.
        String process = Application.getProcessName();
        int colon = process == null ? -1 : process.lastIndexOf(':');
        if (colon >= 0) {
            try {
                WebView.setDataDirectorySuffix(process.substring(colon + 1));
            } catch (IllegalStateException ignored) {
                // Already set or WebView already used in this process.
            }
        } else {
            createChannels();
        }
    }

    private void createChannels() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null) return;
        NotificationChannel ch = new NotificationChannel(CHANNEL_READY,
                getString(R.string.channel_ready), NotificationManager.IMPORTANCE_DEFAULT);
        ch.setDescription(getString(R.string.channel_ready_desc));
        nm.createNotificationChannel(ch);
    }
}
