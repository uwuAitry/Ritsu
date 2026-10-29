using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;

namespace HdrHost;

// HDR10+ 导出主机：raw(gbrp10le) + meta.json -> ffmpeg(libx265) -> hdr10plus_tool inject -> 混流 mp4 -> ffprobe 验收。
// 只依赖系统 ffmpeg/ffprobe/hdr10plus_tool，无 NuGet 依赖。
// 两个命令：
//   encode : 一次性离线（--raw ... --meta ... --out ...）
//   serve  : 本地 HTTP 流式接收（页面/WebView2 用）：POST /session -> /session/{id}/frames* -> /session/{id}/finish
internal static class Program
{
    private const string X265Params =
        "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:" +
        "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):" +
        "max-cll=1000,400";

    private sealed class Session
    {
        public int W;
        public int H;
        public string Fps = "24";
        public string MetaPath = "";
        public string RawPath = "";
    }

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
            {
                Console.WriteLine(
                    "usage:\n" +
                    "  HdrHost encode --raw <gbrp10le.bin> --width W --height H --fps F --meta <json> --out <mp4>\n" +
                    "                 [--audio <aac>] [--ffmpeg p] [--ffprobe p] [--tool p] [--work dir]\n" +
                    "  HdrHost serve  [--port 8712] [--outdir dir] [--ffmpeg p] [--ffprobe p] [--tool p]");
                return args.Length == 0 ? 2 : 0;
            }
            return args[0] switch
            {
                "encode" => Encode(Parse(args)),
                "serve" => Serve(Parse(args)),
                _ => Fail($"unknown command: {args[0]}")
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ERROR {ex.Message}");
            return 1;
        }
    }

    // ---------------- CLI encode ----------------

    private static int Encode(Dictionary<string, string> d)
    {
        string raw = Need(d, "raw");
        int w = int.Parse(Need(d, "width"), CultureInfo.InvariantCulture);
        int h = int.Parse(Need(d, "height"), CultureInfo.InvariantCulture);
        string fps = Need(d, "fps");
        string meta = Need(d, "meta");
        string outPath = Need(d, "out");
        string ffmpeg = d.GetValueOrDefault("ffmpeg", "ffmpeg");
        string ffprobe = d.GetValueOrDefault("ffprobe", SiblingTool(ffmpeg, "ffprobe") ?? "ffprobe");
        string tool = d.GetValueOrDefault("tool", "hdr10plus_tool");
        string? audio = d.GetValueOrDefault("audio");
        string work = d.GetValueOrDefault("work",
            Path.Combine(Path.GetTempPath(), "hdrhost-" + Guid.NewGuid().ToString("N")[..8]));

        DateTime t0 = DateTime.UtcNow;
        string file = RunPipeline(raw, w, h, fps, meta, outPath, audio, ffmpeg, ffprobe, tool, work);
        Console.WriteLine($"PASS: {file} (work={work}, {DateTime.UtcNow - t0:0.0}s)");
        return 0;
    }

    // ---------------- shared pipeline ----------------

    private static string RunPipeline(string raw, int w, int h, string fps, string meta, string outPath,
        string? audio, string ffmpeg, string ffprobe, string tool, string work)
    {
        Directory.CreateDirectory(work);
        string baseHevc = Path.Combine(work, "base.hevc");
        string injected = Path.Combine(work, "injected.hevc");
        string roundtrip = Path.Combine(work, "roundtrip.json");

        Console.WriteLine($"[1/4] encode {w}x{h}@{fps}");
        Run(ffmpeg, new[]
        {
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "gbrp10le", "-s", $"{w}x{h}", "-r", fps, "-i", raw,
            "-vf", "scale=out_color_matrix=bt2020nc:out_range=tv,format=yuv420p10le",
            "-c:v", "libx265", "-preset", "medium", "-crf", "16",
            "-x265-params", X265Params, "-tag:v", "hvc1", "-an", "-f", "hevc", baseHevc
        });

        Console.WriteLine("[2/4] inject ST2094-40 metadata");
        Run(tool, new[] { "inject", "-i", baseHevc, "-j", meta, "-o", injected });

        Console.WriteLine($"[3/4] mux -> {outPath}");
        var mux = new List<string> { "-y", "-hide_banner", "-loglevel", "error", "-r", fps, "-i", injected };
        if (!string.IsNullOrEmpty(audio)) mux.AddRange(new[] { "-i", audio });
        mux.AddRange(new[] { "-map", "0:v:0" });
        if (!string.IsNullOrEmpty(audio)) mux.AddRange(new[] { "-map", "1:a:0", "-c:a", "copy" });
        mux.AddRange(new[]
        {
            "-c:v", "copy", "-color_primaries", "bt2020", "-color_trc", "smpte2084",
            "-colorspace", "bt2020nc", "-movflags", "+faststart", outPath
        });
        Run(ffmpeg, mux);

        Console.WriteLine("[4/4] verify (C3)");
        string stream = Run(ffprobe, new[]
        {
            "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=codec_name,profile,pix_fmt,color_space,color_transfer,color_primaries",
            "-of", "default=nw=1", outPath
        }, capture: true);
        Require(stream, "pix_fmt=yuv420p10le", stream);
        Require(stream, "color_transfer=smpte2084", stream);
        Require(stream, "color_primaries=bt2020", stream);

        string frames = Run(ffprobe, new[]
        {
            "-v", "error", "-select_streams", "v:0", "-show_frames",
            "-show_entries", "frame=side_data_list", "-of", "json", outPath
        }, capture: true);
        Require(frames, "SMPTE2094-40", frames);

        // hdr10plus_tool extract 只吃基本流/TS，不吃 mp4；从注入后的 .hevc 回读校验
        Run(tool, new[] { "extract", "-i", injected, "-o", roundtrip });
        if (!File.Exists(roundtrip) || new FileInfo(roundtrip).Length == 0)
            throw new Exception("hdr10plus_tool extract 未产出有效 JSON");

        return outPath;
    }

    // ---------------- HTTP serve ----------------

    private static int Serve(Dictionary<string, string> d)
    {
        int port = int.Parse(d.GetValueOrDefault("port", "8712"), CultureInfo.InvariantCulture);
        string ffmpeg = d.GetValueOrDefault("ffmpeg", "ffmpeg");
        string ffprobe = d.GetValueOrDefault("ffprobe", SiblingTool(ffmpeg, "ffprobe") ?? "ffprobe");
        string tool = d.GetValueOrDefault("tool", "hdr10plus_tool");
        string outdir = d.GetValueOrDefault("outdir", Path.Combine(Path.GetTempPath(), "hdrhost-out"));
        string workRoot = Path.Combine(Path.GetTempPath(), "hdrhost-sessions");
        Directory.CreateDirectory(outdir);
        Directory.CreateDirectory(workRoot);

        var sessions = new Dictionary<string, Session>();
        var listener = new HttpListener();
        listener.Prefixes.Add($"http://127.0.0.1:{port}/");
        listener.Start();
        Console.WriteLine($"HdrHost serve on http://127.0.0.1:{port}/  outdir={outdir}");

        while (true)
        {
            HttpListenerContext ctx = listener.GetContext();
            try
            {
                Handle(ctx, sessions, ffmpeg, ffprobe, tool, outdir, workRoot);
            }
            catch (Exception ex)
            {
                TryJson(ctx, 500, new { ok = false, error = ex.Message });
            }
            finally
            {
                try { ctx.Response.OutputStream.Close(); } catch { /* ignore */ }
            }
        }
    }

    private static void Handle(HttpListenerContext ctx, Dictionary<string, Session> sessions,
        string ffmpeg, string ffprobe, string tool, string outdir, string workRoot)
    {
        HttpListenerRequest req = ctx.Request;
        HttpListenerResponse res = ctx.Response;
        AddCors(res);
        if (req.HttpMethod == "OPTIONS") { res.StatusCode = 204; return; }

        string path = req.Url!.AbsolutePath;
        string[] parts = path.Trim('/').Split('/');

        if (req.HttpMethod == "GET" && path == "/health")
        {
            WriteText(res, 200, "ok");
            return;
        }

        if (req.HttpMethod == "POST" && path == "/session")
        {
            using var doc = JsonDocument.Parse(req.InputStream);
            JsonElement root = doc.RootElement;
            var s = new Session
            {
                W = root.GetProperty("width").GetInt32(),
                H = root.GetProperty("height").GetInt32(),
                Fps = FpsText(root.GetProperty("fps")),
            };
            string id = Guid.NewGuid().ToString("N");
            string dir = Path.Combine(workRoot, id);
            Directory.CreateDirectory(dir);
            s.MetaPath = Path.Combine(dir, "meta.json");
            s.RawPath = Path.Combine(dir, "frames.raw");
            File.WriteAllText(s.MetaPath, root.GetProperty("meta").GetRawText());
            using (File.Create(s.RawPath)) { }
            sessions[id] = s;
            TryJson(res, 200, new { id, frame_bytes = s.W * s.H * 3 * 2 });
            return;
        }

        if (parts.Length == 3 && parts[0] == "session" && sessions.TryGetValue(parts[1], out Session? sess))
        {
            if (parts[2] == "frames" && req.HttpMethod == "POST")
            {
                using (var fs = new FileStream(sess.RawPath, FileMode.Append, FileAccess.Write))
                    req.InputStream.CopyTo(fs);
                TryJson(res, 200, new { ok = true, size = new FileInfo(sess.RawPath).Length });
                return;
            }
            if (parts[2] == "finish" && req.HttpMethod == "POST")
            {
                long perFrame = (long)sess.W * sess.H * 3 * 2;
                long size = new FileInfo(sess.RawPath).Length;
                if (size == 0 || size % perFrame != 0)
                    throw new Exception($"frames size {size} not a multiple of frame size {perFrame}");
                string outPath = Path.Combine(outdir, parts[1] + ".mp4");
                string file = RunPipeline(sess.RawPath, sess.W, sess.H, sess.Fps, sess.MetaPath, outPath,
                    null, ffmpeg, ffprobe, tool, Path.Combine(workRoot, parts[1]));
                TryJson(res, 200, new { ok = true, path = file, frames = size / perFrame });
                return;
            }
        }

        TryJson(res, 404, new { ok = false, error = "not found " + path });
    }

    private static void AddCors(HttpListenerResponse res)
    {
        res.Headers["Access-Control-Allow-Origin"] = "*";
        res.Headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS";
        res.Headers["Access-Control-Allow-Headers"] = "Content-Type";
        res.Headers["Access-Control-Allow-Private-Network"] = "true";
    }

    private static string FpsText(JsonElement e) =>
        e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetRawText();

    private static void WriteText(HttpListenerResponse res, int code, string body)
    {
        byte[] b = Encoding.UTF8.GetBytes(body);
        res.StatusCode = code;
        res.ContentType = "text/plain; charset=utf-8";
        res.ContentLength64 = b.Length;
        res.OutputStream.Write(b, 0, b.Length);
    }

    private static void TryJson(HttpListenerContext ctx, int code, object payload)
    {
        HttpListenerResponse res = ctx.Response;
        AddCors(res);
        byte[] b = JsonSerializer.SerializeToUtf8Bytes(payload);
        res.StatusCode = code;
        res.ContentType = "application/json; charset=utf-8";
        res.ContentLength64 = b.Length;
        try { res.OutputStream.Write(b, 0, b.Length); } catch { /* client gone */ }
    }

    // ---------------- helpers ----------------

    private static void Require(string haystack, string needle, string context)
    {
        if (!haystack.Contains(needle, StringComparison.Ordinal))
            throw new Exception($"verification failed: expected '{needle}' in:\n{context}");
    }

    private static string? SiblingTool(string exe, string name)
    {
        try
        {
            string? dir = Path.GetDirectoryName(Path.GetFullPath(exe));
            if (dir is null) return null;
            string candidate = Path.Combine(dir, OperatingSystem.IsWindows() ? name + ".exe" : name);
            return File.Exists(candidate) ? candidate : null;
        }
        catch { return null; }
    }

    private static string Run(string exe, IEnumerable<string> argList, bool capture = false)
    {
        var psi = new ProcessStartInfo(exe)
        {
            RedirectStandardOutput = capture,
            RedirectStandardError = capture,
            UseShellExecute = false
        };
        foreach (var a in argList) psi.ArgumentList.Add(a);

        using var p = Process.Start(psi) ?? throw new Exception($"cannot start {exe}");
        string stdout = capture ? p.StandardOutput.ReadToEnd() : string.Empty;
        string stderr = capture ? p.StandardError.ReadToEnd() : string.Empty;
        p.WaitForExit();
        if (p.ExitCode != 0)
            throw new Exception($"{exe} exited {p.ExitCode}\n{stderr}");
        return stdout;
    }

    private static Dictionary<string, string> Parse(string[] args)
    {
        var d = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < args.Length; i++)
        {
            string a = args[i];
            if (!a.StartsWith("--")) throw new ArgumentException($"unexpected argument: {a}");
            if (i + 1 >= args.Length) throw new ArgumentException($"missing value for {a}");
            d[a[2..]] = args[++i];
        }
        return d;
    }

    private static string Need(Dictionary<string, string> d, string key) =>
        d.TryGetValue(key, out var v) && v.Length > 0
            ? v
            : throw new ArgumentException($"missing required --{key}");

    private static int Fail(string msg)
    {
        Console.Error.WriteLine(msg);
        return 2;
    }
}
