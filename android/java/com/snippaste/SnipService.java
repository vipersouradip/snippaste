package com.snippaste;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.Icon;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.ImageView;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;

/**
 * The whole snip flow: a floating bubble, one screen capture per tap, a crop
 * overlay, and delivery to the app the user is typing in.
 *
 * Screen-capture consent is taken once when the bubble starts and the
 * MediaProjection is kept alive, so snipping afterwards is a single tap.
 */
public class SnipService extends Service {

    public static final String ACTION_START = "com.snippaste.START";
    public static final String ACTION_STOP = "com.snippaste.STOP";
    public static final String EXTRA_RESULT_CODE = "resultCode";
    public static final String EXTRA_RESULT_DATA = "resultData";

    private static final String CHANNEL_ID = "snippaste";
    private static final int NOTIFICATION_ID = 41;
    private static final long SNIP_TTL_MS = 60 * 60 * 1000L;

    private static boolean running = false;

    public static boolean isRunning() {
        return running;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private WindowManager windowManager;
    private ClipboardManager clipboard;
    private MediaProjection projection;
    private View bubble;
    private CropView cropView;
    private boolean busy = false;
    private boolean stopping = false;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        windowManager = (WindowManager) getSystemService(WINDOW_SERVICE);
        clipboard = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopEverything();
            return START_NOT_STICKY;
        }

        // Foreground first: Android 10+ refuses to project from a background service.
        startForeground(NOTIFICATION_ID, buildNotification());

        if (projection == null) {
            int resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, 0);
            Intent resultData = intent.getParcelableExtra(EXTRA_RESULT_DATA);
            if (resultData == null) {
                toast("Screen capture was not granted");
                stopEverything();
                return START_NOT_STICKY;
            }
            MediaProjectionManager manager =
                    (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            projection = manager.getMediaProjection(resultCode, resultData);
            if (projection == null) {
                toast("Could not start screen capture");
                stopEverything();
                return START_NOT_STICKY;
            }
            // Android 14 requires a callback to be registered before any capture.
            projection.registerCallback(new MediaProjection.Callback() {
                @Override
                public void onStop() {
                    // Fires both when the user revokes sharing and as an echo of
                    // our own stop; only the first case is worth reporting.
                    if (stopping) return;
                    projection = null;
                    toast("Screen capture ended");
                    stopEverything();
                }
            }, handler);
        }

        running = true;
        showBubble();
        return START_NOT_STICKY;
    }

    // ------------------------------------------------------------- notification

    private Notification buildNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "SnipPaste bubble", NotificationManager.IMPORTANCE_LOW);
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }

        Intent stop = new Intent(this, SnipService.class).setAction(ACTION_STOP);
        PendingIntent stopIntent = PendingIntent.getService(this, 0, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

        return builder
                .setContentTitle("SnipPaste is ready")
                .setContentText("Tap the bubble to snip anything on screen")
                .setSmallIcon(R.drawable.ic_snip)
                .setOngoing(true)
                .addAction(new Notification.Action.Builder(
                        Icon.createWithResource(this, R.drawable.ic_snip), "Stop", stopIntent).build())
                .build();
    }

    // ------------------------------------------------------------------ bubble

    private void showBubble() {
        if (bubble != null) return;

        ImageView view = new ImageView(this);
        view.setImageResource(R.drawable.ic_snip);
        view.setBackgroundResource(R.drawable.bubble_bg);
        int pad = dp(12);
        view.setPadding(pad, pad, pad, pad);

        final WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                dp(52), dp(52),
                overlayType(),
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.x = dp(16);
        params.y = dp(220);

        view.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY;
            int startX, startY;
            long downTime;

            @Override
            public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX();
                        downY = event.getRawY();
                        startX = params.x;
                        startY = params.y;
                        downTime = System.currentTimeMillis();
                        return true;
                    case MotionEvent.ACTION_MOVE:
                        params.x = startX + (int) (event.getRawX() - downX);
                        params.y = startY + (int) (event.getRawY() - downY);
                        windowManager.updateViewLayout(bubble, params);
                        return true;
                    case MotionEvent.ACTION_UP:
                        boolean moved = Math.hypot(event.getRawX() - downX, event.getRawY() - downY) > dp(10);
                        boolean quick = System.currentTimeMillis() - downTime < 500;
                        if (!moved && quick) startSnip();
                        return true;
                }
                return false;
            }
        });

        bubble = view;
        windowManager.addView(bubble, params);
    }

    private int overlayType() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                : WindowManager.LayoutParams.TYPE_PHONE;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ------------------------------------------------------------------- snip

    private void startSnip() {
        if (busy) return;
        if (projection == null) {
            toast("Screen capture ended — open SnipPaste to restart");
            return;
        }
        busy = true;
        // The bubble would otherwise appear in its own screenshot.
        if (bubble != null) bubble.setVisibility(View.GONE);
        handler.postDelayed(new Runnable() {
            @Override
            public void run() {
                captureFrame();
            }
        }, 160);
    }

    private interface FrameCallback {
        void onFrame(Bitmap bitmap);
    }

    private void captureFrame() {
        final DisplayMetrics metrics = new DisplayMetrics();
        windowManager.getDefaultDisplay().getRealMetrics(metrics);
        final int width = metrics.widthPixels;
        final int height = metrics.heightPixels;

        final ImageReader reader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2);
        final VirtualDisplay[] display = new VirtualDisplay[1];

        final FrameCallback done = new FrameCallback() {
            @Override
            public void onFrame(Bitmap bitmap) {
                if (display[0] != null) display[0].release();
                reader.close();
                if (bitmap == null) {
                    finishSnip();
                    toast("Could not capture the screen");
                } else {
                    showCrop(bitmap);
                }
            }
        };

        reader.setOnImageAvailableListener(new ImageReader.OnImageAvailableListener() {
            private boolean handled = false;

            @Override
            public void onImageAvailable(ImageReader r) {
                if (handled) return;
                Image image = null;
                try {
                    image = r.acquireLatestImage();
                    if (image == null) return;
                    handled = true;
                    final Bitmap bitmap = toBitmap(image, width, height);
                    handler.post(new Runnable() {
                        @Override
                        public void run() {
                            done.onFrame(bitmap);
                        }
                    });
                } catch (Exception e) {
                    handled = true;
                    handler.post(new Runnable() {
                        @Override
                        public void run() {
                            done.onFrame(null);
                        }
                    });
                } finally {
                    if (image != null) image.close();
                }
            }
        }, handler);

        try {
            display[0] = projection.createVirtualDisplay("SnipPaste",
                    width, height, metrics.densityDpi,
                    DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                    reader.getSurface(), null, handler);
        } catch (Exception e) {
            reader.close();
            finishSnip();
            toast("Screen capture unavailable: " + e.getMessage());
        }
    }

    /** ImageReader rows are padded, so the raw buffer is wider than the screen. */
    private static Bitmap toBitmap(Image image, int width, int height) {
        Image.Plane plane = image.getPlanes()[0];
        ByteBuffer buffer = plane.getBuffer();
        int pixelStride = plane.getPixelStride();
        int rowStride = plane.getRowStride();
        int rowPadding = rowStride - pixelStride * width;

        Bitmap padded = Bitmap.createBitmap(
                width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888);
        padded.copyPixelsFromBuffer(buffer);
        if (rowPadding == 0) return padded;

        Bitmap exact = Bitmap.createBitmap(padded, 0, 0, width, height);
        padded.recycle();
        return exact;
    }

    // ------------------------------------------------------------------- crop

    private void showCrop(final Bitmap shot) {
        cropView = new CropView(this, shot, new CropView.Listener() {
            @Override
            public void onCropped(Rect rect) {
                removeCrop();
                deliver(Bitmap.createBitmap(shot, rect.left, rect.top,
                        Math.max(1, rect.width()), Math.max(1, rect.height())));
                shot.recycle();
                finishSnip();
            }

            @Override
            public void onCancelled() {
                removeCrop();
                shot.recycle();
                finishSnip();
            }
        });

        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                overlayType(),
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            params.layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS;
        }

        windowManager.addView(cropView, params);
        cropView.requestFocus();
    }

    private void removeCrop() {
        if (cropView == null) return;
        try {
            windowManager.removeView(cropView);
        } catch (Exception ignored) {
        }
        cropView = null;
    }

    private void finishSnip() {
        busy = false;
        if (bubble != null) bubble.setVisibility(View.VISIBLE);
    }

    // ---------------------------------------------------------------- delivery

    private void deliver(Bitmap crop) {
        final Uri uri = save(crop);
        crop.recycle();
        if (uri == null) {
            toast("Could not save the snip");
            return;
        }

        clipboard.setPrimaryClip(ClipData.newUri(getContentResolver(), "SnipPaste", uri));

        if (PasteService.isRunning()) {
            PasteService.pasteWhenReady(new Runnable() {
                @Override
                public void run() {
                    // Nothing had focus, or the field refused an image.
                    toast("Copied — long-press the box and tap Paste");
                    share(uri);
                }
            });
        } else {
            toast("Copied to clipboard");
            share(uri);
        }
    }

    private Uri save(Bitmap bitmap) {
        pruneOldSnips();
        File file = new File(SnipProvider.snipDir(this), "snip-" + System.currentTimeMillis() + ".png");
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(file);
            bitmap.compress(Bitmap.CompressFormat.PNG, 100, out);
            out.flush();
            return SnipProvider.uriFor(file);
        } catch (Exception e) {
            return null;
        } finally {
            try {
                if (out != null) out.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void pruneOldSnips() {
        File[] files = SnipProvider.snipDir(this).listFiles();
        if (files == null) return;
        long cutoff = System.currentTimeMillis() - SNIP_TTL_MS;
        for (File file : files) {
            if (file.lastModified() < cutoff) file.delete();
        }
    }

    /** Offered when auto-paste is unavailable, so the snip is still one tap from anywhere. */
    private void share(Uri uri) {
        Intent send = new Intent(Intent.ACTION_SEND)
                .setType("image/png")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(send, "Send snip to")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivity(chooser);
        } catch (Exception ignored) {
        }
    }

    private void toast(final String message) {
        handler.post(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(SnipService.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    // ---------------------------------------------------------------- teardown

    private void stopEverything() {
        stopping = true;
        running = false;
        removeCrop();
        if (bubble != null) {
            try {
                windowManager.removeView(bubble);
            } catch (Exception ignored) {
            }
            bubble = null;
        }
        if (projection != null) {
            try {
                projection.stop();
            } catch (Exception ignored) {
            }
            projection = null;
        }
        stopForeground(true);
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        removeCrop();
        if (bubble != null) {
            try {
                windowManager.removeView(bubble);
            } catch (Exception ignored) {
            }
            bubble = null;
        }
        super.onDestroy();
    }
}
