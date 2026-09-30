package io.github.lancaster2995.relevo;

import android.content.Context;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.channels.FileLock;
import java.nio.charset.StandardCharsets;

/**
 * JSON file persistence shared by all of the app's processes. Every session window runs in its
 * own process (so each one gets an isolated cookie jar), therefore reads and writes are guarded
 * by an OS-level file lock in addition to an in-process monitor.
 */
public final class Store {

    public interface Edit {
        void apply(Data data) throws Exception;
    }

    private static final Object MONITOR = new Object();
    private static final String FILE = "relevo.json";
    private static final String LOCK = "relevo.lock";

    private Store() {
    }

    public static Data load(Context context) {
        synchronized (MONITOR) {
            try (RandomAccessFile raf = new RandomAccessFile(new File(context.getFilesDir(), LOCK), "rw");
                 FileChannel channel = raf.getChannel();
                 FileLock ignored = channel.lock()) {
                return readUnlocked(context);
            } catch (IOException e) {
                return readUnlocked(context);
            }
        }
    }

    /** Read-modify-write under the lock. Returns the data as saved. */
    public static Data edit(Context context, Edit edit) {
        synchronized (MONITOR) {
            try (RandomAccessFile raf = new RandomAccessFile(new File(context.getFilesDir(), LOCK), "rw");
                 FileChannel channel = raf.getChannel();
                 FileLock ignored = channel.lock()) {
                Data data = readUnlocked(context);
                edit.apply(data);
                writeUnlocked(context, data);
                return data;
            } catch (Exception e) {
                throw new RuntimeException("No se pudo guardar: " + e.getMessage(), e);
            }
        }
    }

    private static Data readUnlocked(Context context) {
        File f = new File(context.getFilesDir(), FILE);
        if (!f.exists()) return new Data();
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            String json = new String(out.toByteArray(), StandardCharsets.UTF_8);
            return Data.fromJson(new JSONObject(json));
        } catch (Exception e) {
            // Keep the unreadable file for recovery and start fresh rather than crash.
            f.renameTo(new File(context.getFilesDir(), FILE + ".corrupt-" + System.currentTimeMillis()));
            return new Data();
        }
    }

    private static void writeUnlocked(Context context, Data data) throws Exception {
        File dir = context.getFilesDir();
        File tmp = new File(dir, FILE + ".tmp");
        byte[] bytes = data.toJson().toString().getBytes(StandardCharsets.UTF_8);
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(bytes);
            out.getFD().sync();
        }
        if (!tmp.renameTo(new File(dir, FILE))) {
            throw new IOException("rename failed");
        }
    }
}
