package com.snippaste;

import android.app.Activity;
import android.content.ComponentName;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.text.TextUtils;
import android.view.View;
import android.widget.Button;
import android.widget.TextView;

/**
 * Setup screen: the two permissions Android will only grant by hand, and a
 * start/stop switch for the bubble.
 */
public class MainActivity extends Activity {

    private TextView statusOverlay;
    private TextView statusPaste;
    private Button buttonOverlay;
    private Button buttonPaste;
    private Button buttonToggle;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        statusOverlay = findViewById(R.id.statusOverlay);
        statusPaste = findViewById(R.id.statusPaste);
        buttonOverlay = findViewById(R.id.buttonOverlay);
        buttonPaste = findViewById(R.id.buttonPaste);
        buttonToggle = findViewById(R.id.buttonToggle);

        buttonOverlay.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + getPackageName())));
            }
        });

        buttonPaste.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            }
        });

        buttonToggle.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if (SnipService.isRunning()) {
                    startService(new Intent(MainActivity.this, SnipService.class)
                            .setAction(SnipService.ACTION_STOP));
                    buttonToggle.postDelayed(new Runnable() {
                        @Override
                        public void run() {
                            refresh();
                        }
                    }, 300);
                } else {
                    startBubble();
                }
            }
        });

        askForNotifications();
    }

    @Override
    protected void onResume() {
        super.onResume();
        refresh();
    }

    /** Android 13+ hides the foreground-service notification without this. */
    private void askForNotifications() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS)
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{android.Manifest.permission.POST_NOTIFICATIONS}, 9);
            }
        }
    }

    private void startBubble() {
        if (!canDrawOverlays()) {
            statusOverlay.setText("Grant the overlay permission first");
            return;
        }
        // Consent lives in its own activity so the bubble can re-ask later.
        startActivity(new Intent(this, ConsentActivity.class));
    }

    private boolean canDrawOverlays() {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this);
    }

    /**
     * Reads the enabled-services list rather than trusting our own static flag,
     * so the state is right even if the service was toggled off while we slept.
     */
    private boolean isPasteServiceEnabled() {
        String enabled = Settings.Secure.getString(getContentResolver(),
                Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
        if (TextUtils.isEmpty(enabled)) return false;
        String target = new ComponentName(this, PasteService.class).flattenToString();
        String targetShort = getPackageName() + "/." + PasteService.class.getSimpleName();
        for (String part : enabled.split(":")) {
            if (part.equalsIgnoreCase(target) || part.equalsIgnoreCase(targetShort)) return true;
        }
        return false;
    }

    private void refresh() {
        boolean overlay = canDrawOverlays();
        statusOverlay.setText(overlay ? "Draw over other apps — allowed" : "Draw over other apps — needed");
        buttonOverlay.setEnabled(!overlay);
        buttonOverlay.setText(overlay ? "Granted" : "Grant");

        boolean paste = isPasteServiceEnabled();
        statusPaste.setText(paste ? "Auto-paste — on" : "Auto-paste — off");
        buttonPaste.setText(paste ? "Accessibility settings" : "Open accessibility settings");

        buttonToggle.setText(SnipService.isRunning() ? "Stop bubble" : "Start bubble");
        buttonToggle.setEnabled(overlay);
    }
}
