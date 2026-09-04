package com.snippaste;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Bundle;
import android.widget.Toast;

/**
 * Invisible shim that asks for screen-capture consent and hands the token to
 * the service.
 *
 * Kept apart from the main screen so the bubble can re-acquire consent later
 * without dragging the whole app to the foreground.
 */
public class ConsentActivity extends Activity {

    private static final int REQUEST_CAPTURE = 7;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        MediaProjectionManager manager =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        try {
            startActivityForResult(manager.createScreenCaptureIntent(), REQUEST_CAPTURE);
        } catch (Exception e) {
            Toast.makeText(this, "Screen capture is unavailable on this device",
                    Toast.LENGTH_LONG).show();
            finish();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_CAPTURE) {
            finish();
            return;
        }

        if (resultCode == RESULT_OK && data != null) {
            Intent service = new Intent(this, SnipService.class)
                    .setAction(SnipService.ACTION_START)
                    .putExtra(SnipService.EXTRA_RESULT_CODE, resultCode)
                    .putExtra(SnipService.EXTRA_RESULT_DATA, data);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(service);
            } else {
                startService(service);
            }
        } else {
            Toast.makeText(this, "Screen capture not allowed", Toast.LENGTH_SHORT).show();
        }
        finish();
        overridePendingTransition(0, 0);
    }
}
