package com.snippaste;

import android.accessibilityservice.AccessibilityService;
import android.os.Handler;
import android.os.Looper;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

/**
 * Performs the paste.
 *
 * Android has no way for one app to put text or an image into another app's
 * text field; the accessibility API is the only route. This service does
 * exactly one thing: find the field the user is typing in and fire ACTION_PASTE
 * on it. It never reads text content.
 */
public class PasteService extends AccessibilityService {

    private static PasteService instance;

    /** Null when the user has not enabled the service in Settings. */
    public static PasteService get() {
        return instance;
    }

    public static boolean isRunning() {
        return instance != null;
    }

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        instance = this;
    }

    @Override
    public void onDestroy() {
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        // Nothing to do; we only act when the snip service asks us to.
    }

    @Override
    public void onInterrupt() {
    }

    /**
     * Pastes into whatever editable field currently has input focus.
     *
     * Called shortly after the crop overlay closes, so the previous app has a
     * moment to take focus back before we look for the field.
     *
     * @return true if a field accepted the paste action.
     */
    public boolean pasteIntoFocusedField() {
        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return false;

        AccessibilityNodeInfo focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT);
        if (focused == null) focused = findEditable(root);
        if (focused == null) return false;

        // A field that cannot take focus cannot take a paste either.
        if (!focused.isFocused()) {
            focused.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_PASTE);
    }

    /** Depth-first search for the first editable node, used when nothing is focused. */
    private AccessibilityNodeInfo findEditable(AccessibilityNodeInfo node) {
        if (node == null) return null;
        if (node.isEditable() && node.isVisibleToUser()) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = findEditable(node.getChild(i));
            if (found != null) return found;
        }
        return null;
    }

    /** Retries briefly, because focus returns to the previous app asynchronously. */
    public static void pasteWhenReady(final Runnable onFailure) {
        final Handler handler = new Handler(Looper.getMainLooper());
        handler.postDelayed(new Runnable() {
            int attempt = 0;

            @Override
            public void run() {
                PasteService service = get();
                if (service != null && service.pasteIntoFocusedField()) return;
                if (++attempt < 6) {
                    handler.postDelayed(this, 250);
                } else if (onFailure != null) {
                    onFailure.run();
                }
            }
        }, 350);
    }
}
