// SnipPaste native messaging host.
//
// Chrome cannot open the operating system's snipping overlay, so this small
// helper does it: the extension asks for a snip, this launches Windows' own
// screen-clip overlay (the same one as Win+Shift+S), waits for the result to
// land on the clipboard, and hands the PNG straight back over stdout.
//
// Protocol is Chrome native messaging: a 4-byte little-endian length followed
// by UTF-8 JSON. Replies larger than Chrome's 1 MB per-message ceiling are
// split into "chunk" messages and reassembled by the extension.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

static class SnipPasteHost
{
    const string Version = "1.2.0";
    const int ChunkChars = 700000;          // base64 chars per message, well under 1 MB
    const int DefaultTimeoutMs = 90000;

    [DllImport("user32.dll")]
    static extern uint GetClipboardSequenceNumber();

    static Stream stdin;
    static Stream stdout;

    [STAThread]
    static int Main()
    {
        stdin = Console.OpenStandardInput();
        stdout = Console.OpenStandardOutput();

        try
        {
            string message;
            while ((message = ReadMessage()) != null)
            {
                Dispatch(message);
            }
        }
        catch (Exception e)
        {
            TrySend("{\"type\":\"error\",\"message\":" + JsonString(e.Message) + "}");
            return 1;
        }
        return 0;
    }

    static void Dispatch(string message)
    {
        string cmd = Field(message, "cmd");

        if (cmd == "ping")
        {
            Send("{\"type\":\"pong\",\"version\":" + JsonString(Version) +
                 ",\"os\":" + JsonString(Environment.OSVersion.VersionString) + "}");
            return;
        }

        if (cmd == "clipboard")
        {
            // Whatever image is on the clipboard right now, no overlay.
            byte[] existing = ReadClipboardPng();
            if (existing == null) SendError("no image on the clipboard");
            else SendImage(existing);
            return;
        }

        if (cmd == "snip")
        {
            int timeout = FieldInt(message, "timeoutMs", DefaultTimeoutMs);
            byte[] png;
            string failure = Snip(timeout, out png);
            if (png == null) SendError(failure ?? "cancelled");
            else SendImage(png);
            return;
        }

        SendError("unknown command: " + cmd);
    }

    // ---------------------------------------------------------------- snipping

    static string Snip(int timeoutMs, out byte[] png)
    {
        png = null;
        uint baseline = GetClipboardSequenceNumber();

        string launchError = LaunchOverlay();
        if (launchError != null) return launchError;

        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        bool overlaySeen = false;

        while (DateTime.UtcNow < deadline)
        {
            if (GetClipboardSequenceNumber() != baseline)
            {
                Thread.Sleep(250);                 // let the clipboard settle
                png = ReadClipboardPng();
                if (png != null) return null;
            }

            bool running = OverlayRunning();
            if (running)
            {
                overlaySeen = true;
            }
            else if (overlaySeen)
            {
                // The overlay closed. Give the clipboard a final chance, then
                // treat it as the user pressing Esc.
                Thread.Sleep(600);
                if (GetClipboardSequenceNumber() != baseline)
                {
                    png = ReadClipboardPng();
                    if (png != null) return null;
                }
                return "cancelled";
            }

            Thread.Sleep(120);
        }
        return "timed out waiting for the snip";
    }

    static string LaunchOverlay()
    {
        // Windows 10/11: the ms-screenclip: protocol is exactly what Win+Shift+S runs.
        try
        {
            Process.Start(new ProcessStartInfo("ms-screenclip:") { UseShellExecute = true });
            return null;
        }
        catch (Exception first)
        {
            try
            {
                Process.Start(new ProcessStartInfo("SnippingTool.exe", "/clip") { UseShellExecute = true });
                return null;
            }
            catch
            {
                return "could not open the Windows snipping overlay (" + first.Message + ")";
            }
        }
    }

    static readonly string[] OverlayProcesses = { "SnippingTool", "ScreenClippingHost", "ScreenSketch" };

    static bool OverlayRunning()
    {
        foreach (string name in OverlayProcesses)
        {
            try
            {
                if (Process.GetProcessesByName(name).Length > 0) return true;
            }
            catch { /* process list raced; treat as not running */ }
        }
        return false;
    }

    // --------------------------------------------------------------- clipboard

    static byte[] ReadClipboardPng()
    {
        for (int attempt = 0; attempt < 8; attempt++)
        {
            try
            {
                // Snipping Tool offers real PNG, which keeps transparency intact.
                if (Clipboard.ContainsData("PNG"))
                {
                    MemoryStream ms = Clipboard.GetData("PNG") as MemoryStream;
                    if (ms != null && ms.Length > 0) return ms.ToArray();
                }
                if (Clipboard.ContainsImage())
                {
                    using (Image image = Clipboard.GetImage())
                    {
                        if (image == null) return null;
                        using (MemoryStream ms = new MemoryStream())
                        {
                            image.Save(ms, ImageFormat.Png);
                            return ms.ToArray();
                        }
                    }
                }
                return null;
            }
            catch (ExternalException)
            {
                Thread.Sleep(120);   // another app holds the clipboard open
            }
            catch (Exception)
            {
                return null;
            }
        }
        return null;
    }

    // ----------------------------------------------------------------- framing

    static string ReadMessage()
    {
        byte[] header = ReadExactly(4);
        if (header == null) return null;
        int length = BitConverter.ToInt32(header, 0);
        if (length <= 0 || length > 64 * 1024 * 1024) return null;
        byte[] body = ReadExactly(length);
        if (body == null) return null;
        return Encoding.UTF8.GetString(body);
    }

    static byte[] ReadExactly(int count)
    {
        byte[] buffer = new byte[count];
        int read = 0;
        while (read < count)
        {
            int n = stdin.Read(buffer, read, count - read);
            if (n <= 0) return null;         // Chrome closed the pipe
            read += n;
        }
        return buffer;
    }

    static void Send(string json)
    {
        byte[] payload = Encoding.UTF8.GetBytes(json);
        stdout.Write(BitConverter.GetBytes(payload.Length), 0, 4);
        stdout.Write(payload, 0, payload.Length);
        stdout.Flush();
    }

    static void TrySend(string json)
    {
        try { Send(json); } catch { /* pipe already gone */ }
    }

    static void SendError(string message)
    {
        Send("{\"type\":\"error\",\"message\":" + JsonString(message) + "}");
    }

    static void SendImage(byte[] png)
    {
        string base64 = Convert.ToBase64String(png);
        int total = (base64.Length + ChunkChars - 1) / ChunkChars;
        if (total == 0) total = 1;

        for (int i = 0; i < total; i++)
        {
            int start = i * ChunkChars;
            int len = Math.Min(ChunkChars, base64.Length - start);
            Send("{\"type\":\"chunk\",\"seq\":" + i + ",\"total\":" + total +
                 ",\"data\":\"" + base64.Substring(start, len) + "\"}");
        }
        Send("{\"type\":\"done\",\"bytes\":" + png.Length + ",\"chunks\":" + total + "}");
    }

    // -------------------------------------------------------------- tiny JSON

    static string Field(string json, string name)
    {
        Match m = Regex.Match(json, "\"" + Regex.Escape(name) + "\"\\s*:\\s*\"([^\"]*)\"");
        return m.Success ? m.Groups[1].Value : "";
    }

    static int FieldInt(string json, string name, int fallback)
    {
        Match m = Regex.Match(json, "\"" + Regex.Escape(name) + "\"\\s*:\\s*(\\d+)");
        int value;
        if (m.Success && int.TryParse(m.Groups[1].Value, out value) && value > 0) return value;
        return fallback;
    }

    static string JsonString(string s)
    {
        StringBuilder sb = new StringBuilder("\"");
        foreach (char c in s ?? "")
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.Append('"').ToString();
    }
}
