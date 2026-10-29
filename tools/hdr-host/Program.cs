using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace HdrHost;

// 阶段①命令行主机：raw(gbrp10le) + meta.json -> ffmpeg(libx265) -> hdr10plus_tool inject -> 混流 mp4 -> ffprobe 验收。
// 只依赖系统 ffmpeg/ffprobe/hdr10plus_tool，无 NuGet 依赖。
internal static class Program
{
    private const string X265Params =
        "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:" +
        "master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1):" +
        "max-cll=1000,400";

    private static int Main(string[] args)
    {
        try
        {
            if (args.Length == 0 || args[0] is "-h" or "--help" or "help")
            {
                Console.WriteLine(
                    "usage: HdrHost encode --raw <gbrp10le.bin> --width W --height H --fps F " +
                    "--meta <hdr10plus.json> --out <out.mp4> [--audio <aac>] " +
                    "[--ffmpeg <path>] [--ffprobe <path>] [--tool <path>] [--work <dir>]");
                return args.Length == 0 ? 2 : 0;
            }
            return args[0] switch
            {
                "encode" => Encode(Parse(args)),
                _ => Fail($"unknown command: {args[0]}")
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ERROR {ex.Message}");
            return 1;
        }
    }

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
        Directory.CreateDirectory(work);

        string baseHevc = Path.Combine(work, "base.hevc");
        string injected = Path.Combine(work, "injected.hevc");
        string roundtrip = Path.Combine(work, "roundtrip.json");

        Console.WriteLine($"[1/4] encode {w}x{h}@{fps} -> {baseHevc}");
        Run(ffmpeg, new[]
        {
            "-y", "-hide_banner", "-loglevel", "error",
            "-f", "rawvideo", "-pix_fmt", "gbrp10le", "-s", $"{w}x{h}", "-r", fps, "-i", raw,
            "-vf", "scale=out_color_matrix=bt2020nc:out_range=tv,format=yuv420p10le",
            "-c:v", "libx265", "-preset", "medium", "-crf", "16",
            "-x265-params", X265Params, "-tag:v", "hvc1", "-an", "-f", "hevc", baseHevc
        });

        Console.WriteLine($"[2/4] inject HDR10+ metadata -> {injected}");
        Run(tool, new[] { "inject", "-i", baseHevc, "-j", meta, "-o", injected });

        Console.WriteLine($"[3/4] mux -> {outPath}");
        var mux = new List<string>
        {
            "-y", "-hide_banner", "-loglevel", "error", "-r", fps, "-i", injected
        };
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

        Console.WriteLine($"PASS: {outPath} (work={work})");
        return 0;
    }

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
            bool win = OperatingSystem.IsWindows();
            string candidate = Path.Combine(dir, win ? name + ".exe" : name);
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
