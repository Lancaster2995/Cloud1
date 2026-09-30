package com.android.tools.r8.utils;

import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * Replacement for the dex2jar-converted class used by tools/build-local.sh: the converted
 * awaitFutures() keeps an uninitialized object inside an exception range, which crashes the
 * JVM's GC. Same behavior, clean bytecode.
 */
public class ThreadUtils {
    public static final int NOT_SPECIFIED = -1;

    public static void awaitFutures(Iterable<? extends Future<?>> futures) throws ExecutionException {
        try {
            for (Future<?> f : futures) f.get();
        } catch (InterruptedException e) {
            throw new RuntimeException("Interrupted while waiting for future.", e);
        }
    }

    public static ExecutorService getExecutorService(int threads) {
        return threads == NOT_SPECIFIED
                ? getExecutorServiceForProcessors(Runtime.getRuntime().availableProcessors())
                : Executors.newWorkStealingPool(threads);
    }

    public static ExecutorService getExecutorService(InternalOptions options) {
        return getExecutorService(options.numberOfThreads);
    }

    static ExecutorService getExecutorServiceForProcessors(int processors) {
        int threads = processors <= 2 ? processors : (int) Math.ceil(Integer.min(processors, 16) / 2.0);
        return Executors.newWorkStealingPool(threads);
    }
}
