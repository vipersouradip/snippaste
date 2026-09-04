package com.snippaste;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;

/**
 * Full-screen selection surface shown over a frozen screenshot.
 *
 * The screen is already captured by the time this appears, so dragging here
 * cannot disturb what is being snipped.
 */
public class CropView extends View {

    public interface Listener {
        void onCropped(Rect rectInBitmap);
        void onCancelled();
    }

    private static final int LOUPE_SIZE_DP = 104;
    private static final float LOUPE_ZOOM = 3.5f;
    private static final int MIN_DRAG_PX = 12;

    private final Bitmap shot;
    private final Listener listener;
    private final float density;

    private final Paint dim = new Paint();
    private final Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint innerBorder = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint text = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint badgeBg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint hintBg = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint loupePaint = new Paint();
    private final Paint loupeBorder = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint crosshair = new Paint(Paint.ANTI_ALIAS_FLAG);

    private final Matrix shotMatrix = new Matrix();
    private BitmapShader shader;

    private boolean dragging = false;
    private boolean hasSelection = false;
    private float x0, y0, x1, y1;
    private float touchX = -1, touchY = -1;
    private boolean finished = false;

    public CropView(Context context, Bitmap shot, Listener listener) {
        super(context);
        this.shot = shot;
        this.listener = listener;
        this.density = context.getResources().getDisplayMetrics().density;

        dim.setColor(Color.argb(128, 9, 9, 14));

        border.setColor(Color.parseColor("#7C6CFF"));
        border.setStyle(Paint.Style.STROKE);
        border.setStrokeWidth(dp(2));

        innerBorder.setColor(Color.argb(190, 255, 255, 255));
        innerBorder.setStyle(Paint.Style.STROKE);
        innerBorder.setStrokeWidth(dp(1));

        text.setColor(Color.WHITE);
        text.setTextSize(dp(13));
        text.setFakeBoldText(true);

        badgeBg.setColor(Color.parseColor("#7C6CFF"));
        hintBg.setColor(Color.argb(230, 18, 18, 24));

        loupePaint.setFilterBitmap(false);   // crisp pixels when magnified
        loupeBorder.setColor(Color.argb(150, 255, 255, 255));
        loupeBorder.setStyle(Paint.Style.STROKE);
        loupeBorder.setStrokeWidth(dp(1));

        crosshair.setColor(Color.parseColor("#7C6CFF"));
        crosshair.setStrokeWidth(dp(1));

        setFocusable(true);
        setFocusableInTouchMode(true);
    }

    private float dp(float v) {
        return v * density;
    }

    /** The captured bitmap is the whole screen, so it maps straight onto this view. */
    private float scaleX() {
        return getWidth() > 0 ? (float) shot.getWidth() / getWidth() : 1f;
    }

    private float scaleY() {
        return getHeight() > 0 ? (float) shot.getHeight() / getHeight() : 1f;
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        if (w <= 0 || h <= 0) return;
        shotMatrix.reset();
        shotMatrix.setScale((float) w / shot.getWidth(), (float) h / shot.getHeight());
        shader = new BitmapShader(shot, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        canvas.drawBitmap(shot, shotMatrix, null);

        RectF sel = selection();
        if (sel == null) {
            canvas.drawRect(0, 0, getWidth(), getHeight(), dim);
        } else {
            // Dim everything except the selection.
            canvas.drawRect(0, 0, getWidth(), sel.top, dim);
            canvas.drawRect(0, sel.bottom, getWidth(), getHeight(), dim);
            canvas.drawRect(0, sel.top, sel.left, sel.bottom, dim);
            canvas.drawRect(sel.right, sel.top, getWidth(), sel.bottom, dim);
            canvas.drawRect(sel, border);
            canvas.drawRect(sel, innerBorder);
            drawSizeBadge(canvas, sel);
        }

        if (sel == null) drawHint(canvas);
        if (touchX >= 0) drawLoupe(canvas);
    }

    private void drawHint(Canvas canvas) {
        String label = "Drag to snip  ·  Back to cancel";
        float pad = dp(12);
        float w = text.measureText(label) + pad * 2;
        float h = dp(38);
        float left = (getWidth() - w) / 2f;
        float top = dp(48);
        canvas.drawRoundRect(new RectF(left, top, left + w, top + h), h / 2, h / 2, hintBg);
        canvas.drawText(label, left + pad, top + h / 2 + dp(4.5f), text);
    }

    private void drawSizeBadge(Canvas canvas, RectF sel) {
        int w = Math.round(sel.width() * scaleX());
        int h = Math.round(sel.height() * scaleY());
        String label = w + " × " + h;
        float pad = dp(7);
        float bw = text.measureText(label) + pad * 2;
        float bh = dp(24);
        float left = Math.max(dp(4), Math.min(getWidth() - bw - dp(4), sel.left));
        float top = sel.top > bh + dp(8) ? sel.top - bh - dp(6)
                : Math.min(getHeight() - bh - dp(4), sel.bottom + dp(6));
        canvas.drawRoundRect(new RectF(left, top, left + bw, top + bh), dp(5), dp(5), badgeBg);
        canvas.drawText(label, left + pad, top + bh / 2 + dp(4.5f), text);
    }

    /** Magnified view of the true pixels under the finger, which the finger hides. */
    private void drawLoupe(Canvas canvas) {
        if (shader == null) return;
        float size = dp(LOUPE_SIZE_DP);
        float left = touchX + dp(28);
        float top = touchY - size - dp(28);
        if (left + size > getWidth() - dp(8)) left = touchX - size - dp(28);
        if (left < dp(8)) left = dp(8);
        if (top < dp(8)) top = touchY + dp(28);
        if (top + size > getHeight() - dp(8)) top = getHeight() - size - dp(8);

        Matrix m = new Matrix();
        float scale = (getWidth() > 0 ? (float) getWidth() / shot.getWidth() : 1f) * LOUPE_ZOOM;
        m.setScale(scale, scale);
        // Put the touched pixel at the centre of the loupe.
        m.postTranslate(left + size / 2 - touchX * LOUPE_ZOOM, top + size / 2 - touchY * LOUPE_ZOOM);
        shader.setLocalMatrix(m);
        loupePaint.setShader(shader);

        RectF box = new RectF(left, top, left + size, top + size);
        canvas.save();
        canvas.clipRect(box);
        canvas.drawRect(box, loupePaint);
        float cx = box.centerX(), cy = box.centerY();
        canvas.drawLine(cx, box.top, cx, box.bottom, crosshair);
        canvas.drawLine(box.left, cy, box.right, cy, crosshair);
        canvas.restore();
        canvas.drawRoundRect(box, dp(8), dp(8), loupeBorder);
    }

    private RectF selection() {
        if (!hasSelection) return null;
        return new RectF(Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1));
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        touchX = event.getX();
        touchY = event.getY();

        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                dragging = true;
                hasSelection = true;
                x0 = x1 = touchX;
                y0 = y1 = touchY;
                invalidate();
                return true;

            case MotionEvent.ACTION_MOVE:
                if (dragging) {
                    x1 = touchX;
                    y1 = touchY;
                    invalidate();
                }
                return true;

            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_CANCEL:
                if (!dragging) return true;
                dragging = false;
                RectF sel = selection();
                // A stray tap means "I mis-tapped", not "snip nothing".
                if (sel == null || sel.width() < MIN_DRAG_PX || sel.height() < MIN_DRAG_PX) {
                    hasSelection = false;
                    touchX = touchY = -1;
                    invalidate();
                    return true;
                }
                finish(sel);
                return true;
        }
        return super.onTouchEvent(event);
    }

    private void finish(RectF sel) {
        if (finished) return;
        finished = true;
        Rect inBitmap = new Rect(
                Math.max(0, Math.round(sel.left * scaleX())),
                Math.max(0, Math.round(sel.top * scaleY())),
                Math.min(shot.getWidth(), Math.round(sel.right * scaleX())),
                Math.min(shot.getHeight(), Math.round(sel.bottom * scaleY())));
        listener.onCropped(inBitmap);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (!finished) {
                finished = true;
                listener.onCancelled();
            }
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }
}
