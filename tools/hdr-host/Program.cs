using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace HdrHost;

// HDR10+ 导出主机：raw(gbrp10le) + meta.json -> ffmpeg(libx265) -> hdr10plus_tool inject -> 混流 mp4 -> ffprobe 验收。
// 只依赖系统 ffmpeg/ffprobe/hdr10plus_tool，无 NuGet 依赖。
//   encode : 一次性离线（--raw ... --meta ... --out ...）
//   serve  : 本地 HTTP 流式接收（TcpListener，免 http.sys/管理员）：
//            POST /session -> /session/{id}/frames* -> /session/{id}/finish
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
                    "  HdrHost serve  [--port 8712] [--outdir dir] [--workdir dir] [--ffmpeg p] [--ffprobe p] [--tool p]");
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

    // ---------------- HTTP serve (TcpListener, no http.sys) ----------------

    private static int Serve(Dictionary<string, string> d)
    {
        int port = int.Parse(d.GetValueOrDefault("port", "8712"), CultureInfo.InvariantCulture);
        string ffmpeg = d.GetValueOrDefault("ffmpeg", "ffmpeg");
        string ffprobe = d.GetValueOrDefault("ffprobe", SiblingTool(ffmpeg, "ffprobe") ?? "ffprobe");
        string tool = d.GetValueOrDefault("tool", "hdr10plus_tool");
        string outdir = d.GetValueOrDefault("outdir", Path.Combine(Path.GetTempPath(), "hdrhost-out"));
        string workRoot = d.GetValueOrDefault("workdir", Path.Combine(Path.GetTempPath(), "hdrhost-sessions"));
        Directory.CreateDirectory(outdir);
        Directory.CreateDirectory(workRoot);

        var sessions = new Dictionary<string, Session>();
        var tcp = new TcpListener(IPAddress.Loopback, port);
        tcp.Start();
        Console.WriteLine($"HdrHost serve on http://127.0.0.1:{port}/  outdir={outdir}");

        while (true)
        {
            using TcpClient client = tcp.AcceptTcpClient();
            try
            {
                using NetworkStream ns = client.GetStream();
                (string method, string path, Dictionary<string, string> hdr, byte[] body) = ReadRequest(ns);
                (int code, string ctype, byte[] resp) = Route(method, path, body, sessions, ffmpeg, ffprobe, tool, outdir, workRoot);
                WriteResponse(ns, code, ctype, resp);
            }
            catch (Exception ex)
            {
                try
                {
                    using NetworkStream ns = client.GetStream();
                    WriteResponse(ns, 500, "application/json", JsonSerializer.SerializeToUtf8Bytes(new { ok = false, error = ex.Message }));
                }
                catch { /* client gone */ }
            }
            finally { try { client.Close(); } catch { } }
        }
    }

    private static (int, string, byte[]) Route(string method, string path, byte[] body,
        Dictionary<string, Session> sessions, string ffmpeg, string ffprobe, string tool, string outdir, string workRoot)
    {
        if (method == "OPTIONS") return (204, "text/plain", Array.Empty<byte>());

        string[] parts = path.Trim('/').Split('/');

        if (method == "GET" && path == "/health")
            return (200, "text/plain", Encoding.UTF8.GetBytes("ok"));

        if (method == "POST" && path == "/session")
        {
            using var doc = JsonDocument.Parse(body);
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
            return (200, "application/json",
                JsonSerializer.SerializeToUtf8Bytes(new { id, frame_bytes = s.W * s.H * 3 * 2 }));
        }

        if (parts.Length == 3 && parts[0] == "session" && sessions.TryGetValue(parts[1], out Session? sess))
        {
            if (parts[2] == "frames" && method == "POST")
            {
                using (var fs = new FileStream(sess.RawPath, FileMode.Append, FileAccess.Write))
                    fs.Write(body, 0, body.Length);
                return (200, "application/json",
                    JsonSerializer.SerializeToUtf8Bytes(new { ok = true, size = new FileInfo(sess.RawPath).Length }));
            }
            if (parts[2] == "finish" && method == "POST")
            {
                long perFrame = (long)sess.W * sess.H * 3 * 2;
                long size = new FileInfo(sess.RawPath).Length;
                if (size == 0 || size % perFrame != 0)
                    throw new Exception($"frames size {size} not a multiple of frame size {perFrame}");
                string outPath = Path.Combine(outdir, parts[1] + ".mp4");
                string file = RunPipeline(sess.RawPath, sess.W, sess.H, sess.Fps, sess.MetaPath, outPath,
                    null, ffmpeg, ffprobe, tool, Path.Combine(workRoot, parts[1]));
                return (200, "application/json",
                    JsonSerializer.SerializeToUtf8Bytes(new { ok = true, path = file, frames = size / perFrame }));
            }
        }

        return (404, "application/json", JsonSerializer.SerializeToUtf8Bytes(new { ok = false, error = "not found " + path }));
    }

    private static (string, string, Dictionary<string, string>, byte[]) ReadRequest(NetworkStream s)
    {
        var ms = new MemoryStream();
        var buf = new byte[16384];
        int hdrEnd = -1;
        while (hdrEnd < 0)
        {
            int n = s.Read(buf, 0, buf.Length);
            if (n <= 0) throw new Exception("client closed before headers");
            ms.Write(buf, 0, n);
            hdrEnd = FindHeaderEnd(ms.GetBuffer(), (int)ms.Length);
            if (ms.Length > 1 << 20) throw new Exception("headers too large");
        }
        byte[] all = ms.GetBuffer();
        string head = Encoding.ASCII.GetString(all, 0, hdrEnd);
        int bodyStart = hdrEnd + 4;
        string[] lines = head.Split("\r\n");
        string[] reqLine = lines[0].Split(' ');
        string method = reqLine[0];
        string path = reqLine[1];

        var hdr = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        for (int i = 1; i < lines.Length; i++)
        {
            int c = lines[i].IndexOf(':');
            if (c > 0) hdr[lines[i][..c].Trim()] = lines[i][(c + 1)..].Trim();
        }

        long len = hdr.TryGetValue("Content-Length", out string? cl) ? long.Parse(cl, CultureInfo.InvariantCulture) : 0;
        var body = new byte[(int)len];
        int have = (int)ms.Length - bodyStart;
        if (have > 0) Array.Copy(all, bodyStart, body, 0, Math.Min(have, (int)len));
        int need = (int)len - Math.Min(have, (int)len);
        int off = Math.Max(0, have);
        while (need > 0)
        {
            int n = s.Read(body, off, need);
            if (n <= 0) throw new Exception("client closed mid-body");
            off += n; need -= n;
        }
        return (method, path, hdr, body);
    }

    private static int FindHeaderEnd(byte[] b, int len)
    {
        for (int i = 0; i + 3 < len; i++)
            if (b[i] == '\r' && b[i + 1] == '\n' && b[i + 2] == '\r' && b[i + 3] == '\n') return i;
        return -1;
    }

    private static void WriteResponse(NetworkStream s, int code, string ctype, byte[] body)
    {
        string reason = code switch { 200 => "OK", 204 => "No Content", 404 => "Not Found", 500 => "Internal Server Error", _ => "OK" };
        string head =
            $"HTTP/1.1 {code} {reason}\r\n" +
            $"Content-Type: {ctype}\r\n" +
            $"Content-Length: {body.Length}\r\n" +
            "Access-Control-Allow-Origin: *\r\n" +
            "Access-Control-Allow-Methods: GET,POST,OPTIONS\r\n" +
            "Access-Control-Allow-Headers: Content-Type\r\n" +
            "Access-Control-Allow-Private-Network: true\r\n" +
            "Connection: close\r\n\r\n";
        byte[] hb = Encoding.ASCII.GetBytes(head);
        s.Write(hb, 0, hb.Length);
        if (body.Length > 0) s.Write(body, 0, body.Length);
        s.Flush();
    }

    private static string FpsText(JsonElement e) =>
        e.ValueKind == JsonValueKind.String ? e.GetString()! : e.GetRawText();

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
