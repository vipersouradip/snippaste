# SnipPaste for Android

A floating bubble that sits over every app. Tap it, drag a region of the screen, and the
snip goes into whatever you are typing in.

`SnipPaste.apk` in this folder is built and signed, ready to sideload.

> **Read this first.** This app is **compiled but not run-tested.** It was built on a Windows
> machine with no Android device or emulator attached, so every check was static: it
> compiles, dexes, packages, signs and verifies, and its manifest declares the right
> components. Nothing has exercised it on real hardware. Expect to shake out bugs on first
> use — tell me what happens and I will fix it.

## Why a separate app

The Chrome extension cannot work on Android, for three independent reasons: Chrome for
Android has never supported extensions; Android has no native-messaging mechanism, so the
desktop helper cannot exist; and Android Chromium does not implement screen capture outside
the page. So this is a native app that does the same job through `MediaProjection`.

## Install

1. Copy `SnipPaste.apk` to the tablet (USB, Drive, email — anything).
2. Tap it. Android will ask to allow installing unknown apps from that source; allow it.
3. Open **SnipPaste**.

### Grant two permissions

**Draw over other apps** — required, this is the bubble. The app's first button opens the
right settings page.

**Accessibility → SnipPaste** — optional but it is what makes pasting automatic. Android has
no other way for one app to put an image into another app's text field.

> On Android 13 and newer, a sideloaded app cannot be switched on in Accessibility until you
> lift the restriction: **Settings → Apps → SnipPaste → ⋮ (top right) → Allow restricted
> settings**. Without that, the Accessibility toggle appears greyed out or silently refuses.

### Start it

Tap **Start bubble**. Android asks permission to capture the screen — that consent lasts for
the whole session, so you are asked once per start, not once per snip.

## Use

Tap the bubble → the screen freezes → drag a rectangle → release. Drag the bubble itself to
move it out of the way. Press Back during a snip to cancel.

To stop: the **Stop** action on the ongoing notification, or **Stop bubble** in the app.

## How it works

`MediaProjection` mirrors the display into an `ImageReader`; one frame is pulled, the bubble
having been hidden first so it is not in its own screenshot. That still frame is shown in a
full-screen overlay (`CropView`) with a dimmed surround, a live pixel-size badge and a
magnifier, since a fingertip covers the pixels it is trying to place. The cropped PNG is
written to the app's cache, published through a small custom `ContentProvider`, and put on
the clipboard as a `content://` URI. Then the accessibility service fires `ACTION_PASTE` on
the focused field.

No third-party libraries at all — not even AndroidX. That is why it builds with plain SDK
tools and the APK is 37 KB.

## Known limits

- **Auto-paste depends on the receiving app.** `ACTION_PASTE` puts the image in only if that
  text field accepts rich content. A field that handles text only will report the paste as
  successful and insert nothing. The snip is always on your clipboard as a backstop.
- **When no field has focus**, or the paste action is refused, a share sheet opens instead so
  you can send the snip to ChatGPT (or anywhere) directly. That path is reliable.
- **Screen-capture consent is per session.** Android re-asks whenever the bubble is started,
  and revokes projection if you use the system's "Stop sharing" control.
- **Secure screens** (banking apps, DRM video) come back black. That is the OS enforcing
  `FLAG_SECURE`, and no app can bypass it.
- **Phones as well as tablets** — nothing here is tablet-specific, it is just laid out for a
  larger screen.

## Build from source

Only a JDK 17 and the Android SDK are needed; there is no Gradle project, because with no
dependencies to resolve there is nothing for it to do.

```powershell
$env:JAVA_HOME    = "<path to a JDK 17>"
$env:ANDROID_HOME = "<path to an SDK with platforms/android-34 and build-tools/34.0.0>"
powershell -ExecutionPolicy Bypass -File android\build.ps1
```

It compiles resources with `aapt2`, generates `R.java`, compiles with `javac`, dexes with
`d8`, aligns with `zipalign` and signs with `apksigner` against `debug.keystore` (created on
first run). Output: `android\SnipPaste.apk`.

## Layout

```
AndroidManifest.xml                  components and permissions
build.ps1                            the whole build, ~120 lines
java/com/snippaste/
  MainActivity.java                  setup screen: permissions, start/stop
  ConsentActivity.java               invisible screen-capture consent shim
  SnipService.java                   bubble, capture, crop, clipboard, delivery
  CropView.java                      selection overlay with magnifier
  PasteService.java                  accessibility service; only ever pastes
  SnipProvider.java                  serves the PNG to the pasting app
res/                                 layout, drawables, strings
```
