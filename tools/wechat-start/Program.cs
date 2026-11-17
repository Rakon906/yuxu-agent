using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Reflection;

[assembly: AssemblyTitle("Yuxu 微信登录")]
[assembly: AssemblyProduct("Yuxu")]
[assembly: AssemblyDescription("Yuxu 微信引擎启动与登录恢复")]
[assembly: AssemblyVersion("0.1.0.0")]

// This launcher uses only Windows/.NET Framework components and the wx.exe inside this project.
// It never stores a WeChat password, API token, or QR payload in its own logs.
internal static class Program
{
    private static readonly string[] Hosts = {
        "long.weixin.qq.com", "short.weixin.qq.com", "szlong.weixin.qq.com",
        "szshort.weixin.qq.com", "login.weixin.qq.com"
    };
    private static readonly string[] LastKnownIps = {
        "43.129.254.147", "43.129.255.26", "43.129.255.38",
        "43.155.124.238", "43.159.234.18"
    };
    private const string BlockBegin = "# SocioMem temporary WeChat DNS begin";
    private const string BlockEnd = "# SocioMem temporary WeChat DNS end";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static string Root;
    private static string Wx;
    private static string DataDir;
    private static string RuntimeDir;
    private static string LogPath;
    private static bool SuppressPause;

    private sealed class CommandResult
    {
        public int ExitCode;
        public string Stdout;
        public string Stderr;
        public bool TimedOut;
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine("Yuxu 微信引擎 0.1.0");
            return 0;
        }
        if (args.Length == 1 && (args[0] == "--help" || args[0] == "-h"))
        {
            Console.WriteLine("Yuxu 微信登录\n直接运行：恢复微信登录，必要时扫码或手机确认。\n--check：只读检查；--no-pause：结束时不等待；--version：查看版本。\n恢复整个 Agent 请运行 Yuxu-Start.exe。\n组件来源与许可见 THIRD_PARTY_NOTICES.md。");
            return 0;
        }
        ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
        Root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        Wx = Path.Combine(Root, @".tools\agent-wechat\v1.3.2\wx.exe");
        DataDir = Path.Combine(Root, @".runtime\agent-wechat");
        RuntimeDir = Path.Combine(Root, @".runtime\wechat-start");
        LogPath = Path.Combine(RuntimeDir, "start.log");
        try
        {
            if (args.Length > 0 && args[0] == "--write-hosts")
                return WriteHostsElevated(args);
            if (args.Length > 0 && args[0] == "--self-test")
                return SelfTest();
            if (args.Length > 0 && args[0] == "--restore-dns")
                return RestoreDns();
            if (args.Length > 0 && args[0] == "--check")
                return CheckOnly();
            if (args.Length == 1 && args[0] == "--no-pause")
            {
                SuppressPause = true;
                return StartFlow();
            }
            if (args.Length != 0)
                throw new InvalidOperationException("未知参数。直接运行 EXE，或使用 --check / --no-pause / --restore-dns。");
            return StartFlow();
        }
        catch (Exception error)
        {
            Log("失败：" + error.Message);
            Pause();
            return 1;
        }
    }

    private static void Log(string message)
    {
        Console.WriteLine(message);
        try
        {
            Directory.CreateDirectory(RuntimeDir);
            File.AppendAllText(LogPath, DateTimeOffset.Now.ToString("o") + " " + message + Environment.NewLine,
                new UTF8Encoding(false));
        }
        catch { /* A read-only log directory must not block login. */ }
    }

    private static void Pause()
    {
        if (SuppressPause || Console.IsInputRedirected) return;
        Console.WriteLine("按 Enter 关闭此窗口；微信服务会继续运行。");
        Console.ReadLine();
    }

    private static string Quote(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static CommandResult RunWx(string arguments, int timeoutMs)
    {
        if (!File.Exists(Wx)) throw new FileNotFoundException("未找到 Yuxu 微信引擎程序", Wx);
        var result = new CommandResult();
        var output = new StringBuilder();
        var errors = new StringBuilder();
        var info = new ProcessStartInfo(Wx, "--json --data-dir " + Quote(DataDir) + " " + arguments);
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.WorkingDirectory = Root;
        using (var process = new Process())
        {
            process.StartInfo = info;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) {
                if (eventArgs.Data != null) output.AppendLine(eventArgs.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs eventArgs) {
                if (eventArgs.Data != null) errors.AppendLine(eventArgs.Data);
            };
            process.Start();
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (!process.WaitForExit(timeoutMs))
            {
                result.TimedOut = true;
                try { process.Kill(); } catch { }
                process.WaitForExit();
            }
            else process.WaitForExit();
            result.ExitCode = process.ExitCode;
        }
        result.Stdout = output.ToString();
        result.Stderr = errors.ToString();
        return result;
    }

    private static Dictionary<string, object> ParseObject(string text)
    {
        try { return Json.DeserializeObject(text) as Dictionary<string, object>; }
        catch { return null; }
    }

    private static string Field(Dictionary<string, object> data, string key)
    {
        object value;
        return data != null && data.TryGetValue(key, out value) && value != null ? value.ToString() : null;
    }

    private static bool Online(Dictionary<string, object> account)
    {
        return Field(account, "authenticated") == "True" && Field(account, "connection") == "online";
    }

    private static Dictionary<string, object> Account(bool createIfMissing)
    {
        var response = RunWx("accounts list", 20000);
        if (response.TimedOut || response.ExitCode != 0)
            throw new InvalidOperationException("无法读取微信账号列表：" + response.Stderr.Trim());
        var root = ParseObject(response.Stdout);
        object rawItems;
        if (root == null || !root.TryGetValue("items", out rawItems) || !(rawItems is IEnumerable))
            throw new InvalidOperationException("微信账号列表格式异常。");
        int count = 0;
        Dictionary<string, object> selected = null;
        foreach (object raw in (IEnumerable)rawItems)
        {
            var item = raw as Dictionary<string, object>;
            if (item == null) continue;
            count++;
            if (Field(item, "alias") == "yuxu") selected = item;
        }
        if (selected != null) return selected;
        if (count != 0 || !createIfMissing)
            throw new InvalidOperationException("已有微信账号，但没有 yuxu 别名；为避免登录错号，启动已停止。");
        Log("没有已保存账号；创建新的 yuxu 本地账号。旧群记忆不会自动绑定新账号 ID。");
        var created = RunWx("accounts create --alias yuxu", 20000);
        if (created.TimedOut || created.ExitCode != 0)
            throw new InvalidOperationException("创建本地微信账号失败：" + created.Stderr.Trim());
        return Account(false);
    }

    private static void EnsureService()
    {
        var status = RunWx("status", 9000);
        var info = ParseObject(status.Stdout);
        if (!status.TimedOut && status.ExitCode == 0 && Field(info, "state") == "ready")
        {
            string actualDir = Field(info, "dataDir");
            if (actualDir == null || !actualDir.TrimStart('\\', '?').TrimEnd('\\')
                    .EndsWith(DataDir.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("6174 端口上运行的微信服务使用了其他数据目录。");
            Log("复用已运行的 Yuxu 微信服务。");
            return;
        }
        Log("启动 Yuxu 微信服务...");
        var start = new ProcessStartInfo(Wx, "--data-dir " + Quote(DataDir) + " serve");
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        start.WorkingDirectory = Root;
        using (var process = Process.Start(start))
        {
            for (int attempt = 0; attempt < 18; attempt++)
            {
                Thread.Sleep(1000);
                if (process.HasExited)
                    throw new InvalidOperationException("微信服务启动后退出，退出码 " + process.ExitCode + "。检查是否已有其他程序占用数据目录。");
                status = RunWx("status", 5000);
                info = ParseObject(status.Stdout);
                if (!status.TimedOut && status.ExitCode == 0 && Field(info, "state") == "ready")
                {
                    Log("微信服务已 ready。");
                    return;
                }
            }
        }
        throw new InvalidOperationException("微信服务未在 18 秒内进入 ready；检查端口 6174 和数据目录锁。");
    }

    private static bool WaitOnline(int checks)
    {
        for (int attempt = 0; attempt < checks; attempt++)
        {
            var account = Account(true);
            if (Online(account))
            {
                Log("微信账号已登录：authenticated=true，connection=online。");
                return true;
            }
            if (attempt + 1 < checks) Thread.Sleep(2000);
        }
        return false;
    }

    private static bool TcpReachable(IPAddress address, int port)
    {
        try
        {
            using (var client = new TcpClient(address.AddressFamily))
            {
                IAsyncResult connection = client.BeginConnect(address, port, null, null);
                if (!connection.AsyncWaitHandle.WaitOne(1800)) return false;
                client.EndConnect(connection);
                return true;
            }
        }
        catch { return false; }
    }

    private static bool HostReachable(string host)
    {
        try
        {
            foreach (var address in Dns.GetHostAddresses(host))
                if (address.AddressFamily == AddressFamily.InterNetwork && TcpReachable(address, 80)) return true;
        }
        catch { }
        return false;
    }

    private static bool LoginHostsReachable()
    {
        bool allReachable = true;
        foreach (string host in Hosts)
            if (!HostReachable(host)) { Log("登录地址不可连接：" + host); allReachable = false; }
        return allReachable;
    }

    private static void PrintNetworkState()
    {
        string school = "未发现";
        string personal = "未发现";
        foreach (var adapter in NetworkInterface.GetAllNetworkInterfaces())
        {
            string label = adapter.Name + " " + adapter.Description;
            string state = adapter.OperationalStatus == OperationalStatus.Up ? "已连接" : "未连接";
            if (label.IndexOf("Sangfor", StringComparison.OrdinalIgnoreCase) >= 0) school = state;
            if (label.IndexOf("Meta Tunnel", StringComparison.OrdinalIgnoreCase) >= 0) personal = state;
        }
        Log("网络适配器：学校 VPN=" + school + "；Meta Tunnel=" + personal + "。以实际微信连接探测为准。");
    }

    private sealed class TimeoutWebClient : WebClient
    {
        protected override WebRequest GetWebRequest(Uri address)
        {
            var request = base.GetWebRequest(address);
            request.Timeout = 7000;
            return request;
        }
    }

    private static List<IPAddress> PublicAddresses(string host)
    {
        var result = new List<IPAddress>();
        foreach (string endpoint in new[] {
            "https://cloudflare-dns.com/dns-query?name=",
            "https://dns.google/resolve?name="
        })
        {
            try
            {
                using (var client = new TimeoutWebClient())
                {
                    client.Headers[HttpRequestHeader.Accept] = "application/dns-json";
                    string body = client.DownloadString(endpoint + Uri.EscapeDataString(host) + "&type=A");
                    var response = ParseObject(body);
                    object rawAnswers;
                    if (response == null || !response.TryGetValue("Answer", out rawAnswers) || !(rawAnswers is IEnumerable))
                        continue;
                    foreach (object raw in (IEnumerable)rawAnswers)
                    {
                        var answer = raw as Dictionary<string, object>;
                        IPAddress address;
                        if (answer != null && Field(answer, "type") == "1" &&
                            IPAddress.TryParse(Field(answer, "data"), out address) &&
                            address.AddressFamily == AddressFamily.InterNetwork && !result.Contains(address))
                            result.Add(address);
                    }
                    if (result.Count > 0) break;
                }
            }
            catch { /* Try the second resolver and last-known addresses. */ }
        }
        return result;
    }

    private static Dictionary<string, string> ChooseReachableAddresses()
    {
        var chosen = new Dictionary<string, string>();
        for (int index = 0; index < Hosts.Length; index++)
        {
            var candidates = PublicAddresses(Hosts[index]);
            IPAddress lastKnown;
            if (IPAddress.TryParse(LastKnownIps[index], out lastKnown) && !candidates.Contains(lastKnown))
                candidates.Add(lastKnown);
            IPAddress selected = null;
            foreach (var address in candidates)
                if (TcpReachable(address, 80)) { selected = address; break; }
            if (selected == null)
                throw new InvalidOperationException(Hosts[index] + " 的公共 DNS 地址均无法连接。检查当前 VPN/网络；未修改系统 DNS。");
            chosen.Add(Hosts[index], selected.ToString());
        }
        return chosen;
    }

    private static int BlockStart(byte[] bytes, out int blockEnd)
    {
        string text = Encoding.GetEncoding(28591).GetString(bytes);
        int begin = text.IndexOf(BlockBegin, StringComparison.Ordinal);
        int end = text.IndexOf(BlockEnd, StringComparison.Ordinal);
        if ((begin < 0) != (end < 0)) throw new InvalidOperationException("hosts 中的 Yuxu 标记不完整，拒绝修改。");
        if (begin < 0) { blockEnd = -1; return -1; }
        if (text.IndexOf(BlockBegin, begin + BlockBegin.Length, StringComparison.Ordinal) >= 0 ||
            text.IndexOf(BlockEnd, end + BlockEnd.Length, StringComparison.Ordinal) >= 0 || end <= begin)
            throw new InvalidOperationException("hosts 中的 Yuxu 标记重复或乱序，拒绝修改。");
        int start = text.LastIndexOf('\n', Math.Max(0, begin - 1)) + 1;
        if (text.Substring(start, begin - start).Trim().Length != 0)
            throw new InvalidOperationException("hosts 标记前有其他内容，拒绝修改。");
        blockEnd = text.IndexOf('\n', end + BlockEnd.Length);
        blockEnd = blockEnd < 0 ? bytes.Length : blockEnd + 1;
        return start;
    }

    private static byte[] ProposedHosts(byte[] current, Dictionary<string, string> mapping)
    {
        int end;
        int start = BlockStart(current, out end);
        var output = new List<byte>();
        if (start < 0) output.AddRange(current);
        else
        {
            for (int index = 0; index < start; index++) output.Add(current[index]);
            for (int index = end; index < current.Length; index++) output.Add(current[index]);
        }
        if (mapping == null) return output.ToArray();
        if (output.Count > 0 && output[output.Count - 1] != (byte)'\n')
            output.AddRange(Encoding.ASCII.GetBytes("\r\n"));
        var block = new StringBuilder();
        block.Append(BlockBegin).Append(" managed\r\n");
        foreach (string host in Hosts)
        {
            IPAddress address;
            string value;
            if (!mapping.TryGetValue(host, out value) || !IPAddress.TryParse(value, out address) ||
                address.AddressFamily != AddressFamily.InterNetwork)
                throw new InvalidOperationException("非法微信地址映射：" + host);
            block.Append(value).Append(' ').Append(host).Append("\r\n");
        }
        block.Append(BlockEnd).Append("\r\n");
        output.AddRange(Encoding.ASCII.GetBytes(block.ToString()));
        return output.ToArray();
    }

    private static string Hash(byte[] bytes)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "");
    }

    private static int WriteHostsElevated(string[] args)
    {
        if (args.Length != 2) throw new InvalidOperationException("管理员参数错误。");
        string folder = Path.GetFullPath(args[1]);
        string expectedRoot = Path.GetFullPath(Path.Combine(RuntimeDir, "backups")) + Path.DirectorySeparatorChar;
        if (!folder.StartsWith(expectedRoot, StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("管理员操作目录超出项目运行区。");
        string hosts = Path.Combine(Environment.SystemDirectory, @"drivers\etc\hosts");
        byte[] current = File.ReadAllBytes(hosts);
        byte[] expected = File.ReadAllBytes(Path.Combine(folder, "hosts.before"));
        byte[] proposed = File.ReadAllBytes(Path.Combine(folder, "hosts.proposed"));
        if (Hash(current) != Hash(expected))
            throw new InvalidOperationException("hosts 文件已被其他程序更改，拒绝覆盖。");
        File.WriteAllBytes(hosts, proposed);
        if (Hash(File.ReadAllBytes(hosts)) != Hash(proposed))
            throw new InvalidOperationException("hosts 写入校验失败；原文件备份保存在 " + folder);
        return 0;
    }

    private static bool ChangeHosts(Dictionary<string, string> mapping)
    {
        string hosts = Path.Combine(Environment.SystemDirectory, @"drivers\etc\hosts");
        byte[] current = File.ReadAllBytes(hosts);
        byte[] proposed = ProposedHosts(current, mapping);
        if (Hash(current) == Hash(proposed)) return false;
        string folder = Path.Combine(RuntimeDir, "backups", DateTime.Now.ToString("yyyyMMdd-HHmmss-fff"));
        Directory.CreateDirectory(folder);
        File.WriteAllBytes(Path.Combine(folder, "hosts.before"), current);
        File.WriteAllBytes(Path.Combine(folder, "hosts.proposed"), proposed);
        Log("hosts 原文件已备份到 " + folder);
        Log("需要 Windows 管理员确认，以更新仅针对微信的域名映射。");
        var info = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName,
            "--write-hosts " + Quote(folder));
        info.UseShellExecute = true;
        info.Verb = "runas";
        info.WindowStyle = ProcessWindowStyle.Hidden;
        using (var child = Process.Start(info))
        {
            if (!child.WaitForExit(60000) || child.ExitCode != 0)
                throw new InvalidOperationException("管理员 hosts 更新未完成；备份位于 " + folder);
        }
        if (Hash(File.ReadAllBytes(hosts)) != Hash(proposed))
            throw new InvalidOperationException("管理员操作返回成功，但 hosts 内容未通过校验。");
        Log(mapping == null ? "已移除 Yuxu 临时 DNS 映射。" : "临时微信 DNS 映射已验证写入。");
        return true;
    }

    private static int RestoreDns()
    {
        ChangeHosts(null);
        return 0;
    }

    private static int CheckOnly()
    {
        Log("微信启动检查（只读）");
        PrintNetworkState();
        var status = RunWx("status", 9000);
        var info = ParseObject(status.Stdout);
        Log("服务：" + (Field(info, "state") ?? "未运行"));
        if (Field(info, "state") == "ready")
        {
            try
            {
                var account = Account(false);
                Log("账号：" + (Online(account) ? "online" : "disconnected"));
            }
            catch (Exception error) { Log("账号检查失败：" + error.Message); }
        }
        foreach (string host in Hosts)
            Log(host + "：" + (HostReachable(host) ? "可连接" : "不可连接"));
        return 0;
    }

    private static int RunLogin(string arguments, int timeoutMs)
    {
        Log("开始微信手机认证；按终端显示扫码或在手机确认。");
        var info = new ProcessStartInfo(Wx, "--data-dir " + Quote(DataDir) + " auth login " + arguments);
        info.UseShellExecute = false;
        info.WorkingDirectory = Root;
        using (var process = Process.Start(info))
        {
            if (!process.WaitForExit(timeoutMs))
            {
                try { process.Kill(); } catch { }
                throw new InvalidOperationException("微信登录等待超时。");
            }
            return process.ExitCode;
        }
    }

    private static int StartFlow()
    {
        Log("Yuxu 微信启动器");
        PrintNetworkState();
        if (!File.Exists(Wx)) throw new FileNotFoundException("未找到 wx.exe", Wx);
        EnsureService();
        if (WaitOnline(5)) { Pause(); return 0; }

        if (!LoginHostsReachable())
        {
            if (Environment.GetEnvironmentVariable("YUXU_ALLOW_NETWORK_REPAIR") != "1")
                throw new InvalidOperationException("微信登录网络不可达。先检查网络；仅在明确需要时设置 YUXU_ALLOW_NETWORK_REPAIR=1 后重试。默认不会修改 hosts 或路由。");
            Log("微信登录地址不可连接；查询可用地址并准备临时修正。");
            ChangeHosts(ChooseReachableAddresses());
            if (!LoginHostsReachable())
                throw new InvalidOperationException("修正后微信登录地址仍不可连接。");
        }

        Log("尝试已保存的设备登录；如手机出现确认提示，请批准。");
        RunLogin("--strategy saved-device --no-qr --timeout 45", 60000);
        if (WaitOnline(2)) { Pause(); return 0; }

        Log("已保存设备未登录，转为二维码登录。");
        RunLogin("--strategy qr --force-qr --timeout 300", 330000);
        if (WaitOnline(3)) { Pause(); return 0; }
        throw new InvalidOperationException("微信登录未完成。若没有显示二维码，登录是在生成二维码之前失败；请检查微信连接路由，不要反复扫码。详情见 " + LogPath);
    }

    private static int SelfTest()
    {
        byte[] original = Encoding.ASCII.GetBytes("127.0.0.1 localhost\r\n");
        var mapping = new Dictionary<string, string>();
        for (int index = 0; index < Hosts.Length; index++) mapping.Add(Hosts[index], LastKnownIps[index]);
        byte[] applied = ProposedHosts(original, mapping);
        byte[] replaced = ProposedHosts(applied, mapping);
        byte[] restored = ProposedHosts(applied, null);
        byte[] legacy = Encoding.ASCII.GetBytes("127.0.0.1 localhost\r\n\r\n" +
            "# SocioMem temporary WeChat DNS begin 2026-11-04\r\n" +
            "43.129.254.147 long.weixin.qq.com\r\n" +
            "# SocioMem temporary WeChat DNS end\r\n" +
            "# unrelated line\r\n");
        byte[] refreshed = ProposedHosts(legacy, mapping);
        byte[] refreshedAgain = ProposedHosts(refreshed, mapping);
        byte[] legacyRestored = ProposedHosts(refreshed, null);
        if (Hash(applied) != Hash(replaced) || Hash(original) != Hash(restored) ||
            Hash(refreshed) != Hash(refreshedAgain) ||
            !Encoding.ASCII.GetString(legacyRestored).Contains("# unrelated line") ||
            Encoding.ASCII.GetString(legacyRestored).Contains(BlockBegin))
            throw new InvalidOperationException("hosts 变更与撤回自检失败。");
        Console.WriteLine("self-test: passed");
        return 0;
    }
}
