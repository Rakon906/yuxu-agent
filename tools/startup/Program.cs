using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Reflection;

[assembly: AssemblyTitle("Yuxu Agent")]
[assembly: AssemblyProduct("Yuxu")]
[assembly: AssemblyDescription("Yuxu Agent 一键恢复")]
[assembly: AssemblyVersion("0.1.0.0")]

internal static class Program
{
    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        if (args.Length == 1 && args[0] == "--version")
        {
            Console.WriteLine("Yuxu Agent 0.1.0");
            return 0;
        }
        if (args.Length == 1 && (args[0] == "--help" || args[0] == "-h"))
        {
            Console.WriteLine("Yuxu Agent\n直接运行：恢复微信、模型和聊天进程。\n--check：只读检查；--no-pause：结束时不等待；--version：查看版本。\n只恢复微信登录请运行 Yuxu-WeChat.exe。\n组件来源与许可见 THIRD_PARTY_NOTICES.md。");
            return 0;
        }
        bool check = args.Length == 1 && args[0] == "--check";
        bool noPause = args.Length == 1 && args[0] == "--no-pause";
        if (args.Length != 0 && !check && !noPause)
        {
            Console.Error.WriteLine("用法：直接运行 Yuxu-Start.exe，或使用 --check / --no-pause。");
            return 2;
        }
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);
        string script = Path.Combine(root, @"tools\startup\start-agent.ps1");
        if (!File.Exists(script))
        {
            Console.Error.WriteLine("找不到启动脚本：" + script);
            return 2;
        }
        var info = new ProcessStartInfo("powershell.exe",
            "-NoProfile -ExecutionPolicy Bypass -File \"" + script + "\"" + (check ? " -Check" : ""));
        info.UseShellExecute = false;
        info.WorkingDirectory = root;
        try
        {
            using (var process = Process.Start(info))
            {
                process.WaitForExit();
                if (!check && !noPause && !Console.IsInputRedirected)
                {
                    Console.WriteLine("按 Enter 关闭窗口；后台服务会继续运行。");
                    Console.ReadLine();
                }
                return process.ExitCode;
            }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("启动器失败：" + error.Message);
            return 1;
        }
    }
}
