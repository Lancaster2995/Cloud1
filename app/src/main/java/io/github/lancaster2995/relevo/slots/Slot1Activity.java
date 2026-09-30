package io.github.lancaster2995.relevo.slots;

import io.github.lancaster2995.relevo.SessionActivity;

/** Session window for account slot 1 (process ":s1", own task). */
public class Slot1Activity extends SessionActivity {
    @Override
    protected int slot() {
        return 1;
    }
}
