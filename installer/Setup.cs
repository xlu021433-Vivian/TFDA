using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: AssemblyTitle("神器外卖助手安装程序")]
[assembly: AssemblyVersion("0.3.2.0")]
[assembly: AssemblyFileVersion("0.3.2.0")]

internal static class Package
{
    internal const string Digest = "1a6b3bed12e1e008290fbaf0114e52d1045aee88b41316a04f6c385903c725ba";

    static string Hash(Stream stream)
    {
        using (var sha = SHA256.Create())
            return BitConverter.ToString(sha.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    internal static void Extract(string target, Action<int> progress)
    {
        string destination = Path.GetFullPath(target).TrimEnd(Path.DirectorySeparatorChar);
        if (destination.Length < 4 || File.Exists(destination))
            throw new IOException("请选择普通文件夹作为安装位置。");
        if (Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length != 0)
            throw new IOException("安装位置不是空文件夹。请选择一个新的空文件夹，避免覆盖已有设置。");
        using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("Shenqi.Payload"))
        {
            if (payload == null || Hash(payload) != Digest)
                throw new IOException("安装包校验失败，请从 GitHub 发布页重新下载。");
            payload.Position = 0;
            using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
            {
                Directory.CreateDirectory(destination);
                int completed = 0;
                foreach (var entry in zip.Entries)
                {
                    const string prefix = "Shenqi-Waimai/";
                    if (!entry.FullName.StartsWith(prefix, StringComparison.Ordinal))
                        throw new IOException("安装包目录结构异常。");
                    string relative = entry.FullName.Substring(prefix.Length).Replace('/', Path.DirectorySeparatorChar);
                    string path = Path.GetFullPath(Path.Combine(destination, relative));
                    if (!path.StartsWith(destination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                        throw new IOException("安装包路径异常。");
                    Directory.CreateDirectory(Path.GetDirectoryName(path));
                    using (var input = entry.Open())
                    using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
                        input.CopyTo(output);
                    completed++;
                    if (completed % 40 == 0) progress(completed * 85 / zip.Entries.Count);
                }
            }
        }
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        var manifest = serializer.Deserialize<List<Dictionary<string, string>>>(
            File.ReadAllText(Path.Combine(destination, "files.sha256.json"), Encoding.UTF8));
        for (int i = 0; i < manifest.Count; i++)
        {
            string path = Path.GetFullPath(Path.Combine(destination, manifest[i]["path"].Replace('/', Path.DirectorySeparatorChar)));
            if (!path.StartsWith(destination + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
                throw new IOException("文件校验路径异常。");
            using (var file = File.OpenRead(path))
                if (Hash(file) != manifest[i]["sha256"])
                    throw new IOException("文件校验失败：" + manifest[i]["path"]);
            if (i % 40 == 0) progress(85 + i * 15 / manifest.Count);
        }
        UpdateLaunchers(destination, false);
        progress(100);
    }

    internal static void UpdateLaunchers(string destination, bool repair)
    {
        destination = Path.GetFullPath(destination);
        var updates = new Dictionary<string, byte[]>();
        foreach (string name in new[] { "START.bat", "INSTALL-EXTENSION.bat", "INSTALL-HELP.txt" })
        {
            using (var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream("Shenqi." + name))
            using (var data = new MemoryStream())
            {
                if (resource == null) throw new IOException("启动入口资源缺失。");
                resource.CopyTo(data);
                updates[name] = data.ToArray();
            }
        }
        if (!File.Exists(Path.Combine(destination, "app", "app.py")) ||
            !File.Exists(Path.Combine(destination, "runtime", "python.exe")) ||
            !File.Exists(Path.Combine(destination, "browser-extension", "manifest.json")))
            throw new IOException("所选目录不是完整的神器安装目录。");
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        string manifestPath = Path.Combine(destination, "files.sha256.json");
        var manifest = serializer.Deserialize<List<Dictionary<string, string>>>(File.ReadAllText(manifestPath, Encoding.UTF8));
        // Repair only known public launchers; never overwrite user-edited scripts or settings.
        if (repair)
        {
            using (var payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("Shenqi.Payload"))
            {
                if (Hash(payload) != Digest) throw new IOException("安装包校验失败。");
                payload.Position = 0;
                using (var zip = new ZipArchive(payload, ZipArchiveMode.Read))
                    foreach (var update in updates)
                    {
                        string path = Path.Combine(destination, update.Key);
                        if (!File.Exists(path)) continue;
                        string current;
                        using (var file = File.OpenRead(path)) current = Hash(file);
                        using (var fresh = new MemoryStream(update.Value))
                            if (current == Hash(fresh)) continue;
                        var original = zip.GetEntry("Shenqi-Waimai/" + update.Key);
                        if (original == null) throw new IOException("启动入口已被修改，未覆盖：" + update.Key);
                        using (var old = original.Open())
                            if (current != Hash(old)) throw new IOException("启动入口已被修改，未覆盖：" + update.Key);
                    }
            }
        }
        foreach (var update in updates)
        {
            File.WriteAllBytes(Path.Combine(destination, update.Key), update.Value);
            var entry = manifest.Find(item => item["path"] == update.Key);
            if (entry == null) { entry = new Dictionary<string, string> { { "path", update.Key } }; manifest.Add(entry); }
            using (var stream = new MemoryStream(update.Value)) entry["sha256"] = Hash(stream);
        }
        File.WriteAllText(manifestPath, serializer.Serialize(manifest), new UTF8Encoding(false));
    }

    internal static void Shortcut(string destination, string directory)
    {
        dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell"));
        try
        {
            dynamic link = shell.CreateShortcut(destination);
            try
            {
                link.TargetPath = Path.Combine(directory, "START.bat");
                link.WorkingDirectory = directory;
                link.Description = "启动神器外卖助手；关闭运行窗口将停止本地通知服务";
                link.Save();
            }
            finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(link); }
        }
        finally { System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell); }
    }
}

internal sealed class SetupForm : Form
{
    readonly TextBox location = new TextBox();
    readonly Button browse = new Button();
    readonly Button install = new Button();
    readonly CheckBox shortcut = new CheckBox();
    readonly ProgressBar progress = new ProgressBar();
    readonly Label status = new Label();
    readonly FlowLayoutPanel actions = new FlowLayoutPanel();
    bool busy;
    string installed;
    static readonly Color Ink = Color.FromArgb(51, 43, 38);
    static readonly Color Muted = Color.FromArgb(101, 91, 82);
    static readonly Color Brand = Color.FromArgb(125, 76, 45);

    internal SetupForm()
    {
        Text = "神器外卖助手 · 安装";
        ClientSize = new Size(680, 536);
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Microsoft YaHei UI", 10);
        BackColor = Color.FromArgb(250, 248, 244);
        ForeColor = Ink;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        LabelText("把午餐助手装到电脑上", 32, 28, 616, 48, 22, Ink, true);
        LabelText("工作日 11:00  ·  预算 25 元  ·  不吃猪肉  ·  必须用券", 32, 88, 616, 32, 11, Brand, true);
        LabelText("已包含 Python 和运行库，无需安装开发环境。\n浏览器扩展需手动加载一次，美团登录与配送地址由你确认。", 32, 136, 616, 56, 10, Muted, false);
        LabelText("安装位置（请选择空文件夹）", 32, 208, 616, 28, 10, Ink, false);
        location.SetBounds(32, 244, 504, 32);
        location.Text = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Programs", "Shenqi-Waimai-0.3.2");
        location.AccessibleName = "安装位置";
        Controls.Add(location);
        browse.SetBounds(552, 240, 96, 40);
        browse.Text = "更改位置";
        browse.Click += delegate {
            using (var dialog = new FolderBrowserDialog { Description = "选择新的空文件夹；已有文件不会被覆盖" })
                if (dialog.ShowDialog(this) == DialogResult.OK) location.Text = dialog.SelectedPath;
        };
        Controls.Add(browse);
        shortcut.SetBounds(32, 296, 616, 32);
        shortcut.Text = "创建桌面“神器外卖助手”快捷方式";
        shortcut.Checked = true;
        Controls.Add(shortcut);
        progress.SetBounds(32, 344, 616, 16);
        Controls.Add(progress);
        status.SetBounds(32, 376, 616, 64);
        status.ForeColor = Muted;
        status.Text = "安装后定时保持关闭，确认授权后才会启用。\n完整真实账号自动下单仍待验证，首次使用请在旁观察。";
        Controls.Add(status);
        install.SetBounds(472, 456, 176, 44);
        install.Text = "安装到电脑";
        install.Font = new Font(Font, FontStyle.Bold);
        install.BackColor = Brand;
        install.ForeColor = Color.White;
        install.FlatStyle = FlatStyle.Flat;
        install.FlatAppearance.BorderSize = 0;
        install.Click += Install;
        Controls.Add(install);
        AcceptButton = install;
        actions.SetBounds(32, 452, 616, 56);
        actions.Visible = false;
        Controls.Add(actions);
        FormClosing += delegate(object sender, FormClosingEventArgs args) {
            if (busy) args.Cancel = true;
        };
    }

    void LabelText(string text, int x, int y, int w, int h, float size, Color color, bool bold)
    {
        Controls.Add(new Label { Text = text, Bounds = new Rectangle(x, y, w, h), ForeColor = color,
            Font = new Font("Microsoft YaHei UI", size, bold ? FontStyle.Bold : FontStyle.Regular) });
    }

    void ActionButton(string caption, string file)
    {
        var button = new Button { Text = caption, Width = 184, Height = 44, Margin = new Padding(0, 0, 16, 0) };
        button.Click += delegate { Process.Start(new ProcessStartInfo(Path.Combine(installed, file)) { UseShellExecute = true, WorkingDirectory = installed }); };
        actions.Controls.Add(button);
    }

    async void Install(object sender, EventArgs args)
    {
        busy = true;
        location.Enabled = browse.Enabled = shortcut.Enabled = install.Enabled = false;
        status.Text = "正在校验并安装，请保持窗口打开…";
        string target = location.Text;
        var updates = new Progress<int>(value => progress.Value = value);
        try
        {
            await Task.Run(() => Package.Extract(target, value => ((IProgress<int>)updates).Report(value)));
            installed = Path.GetFullPath(target);
            string result = "安装完成。先点击“加载浏览器扩展”，再启动助手。";
            if (shortcut.Checked)
            {
                try { Package.Shortcut(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory), "神器外卖助手.lnk"), installed); }
                catch { result += "\n桌面快捷方式未创建，可从安装目录的 START.bat 启动。"; }
            }
            progress.Value = 100;
            status.Text = result;
            install.Visible = false;
            ActionButton("加载浏览器扩展", "INSTALL-EXTENSION.bat");
            ActionButton("启动神器助手", "START.bat");
            ActionButton("阅读使用说明", "先看这里.txt");
            actions.Visible = true;
            AcceptButton = null;
        }
        catch (Exception error)
        {
            status.ForeColor = Color.FromArgb(151, 45, 35);
            status.Text = "未完成安装：" + error.Message;
            location.Enabled = browse.Enabled = shortcut.Enabled = install.Enabled = true;
        }
        finally { busy = false; }
    }
}

internal static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 2 && args[0] == "--repair-launchers")
            {
                Package.UpdateLaunchers(args[1], true);
                return 0;
            }
            if (args.Length == 2 && args[0] == "--verify-extract")
            {
                Package.Extract(args[1], delegate { });
                File.WriteAllText(Path.Combine(args[1], "installer-test.ok"), Package.Digest);
                return 0;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            using (var window = new SetupForm())
            {
                if (args.Length == 2 && args[0] == "--preview")
                {
                    window.Show();
                    Application.DoEvents();
                    window.Refresh();
                    using (var bitmap = new Bitmap(window.Width, window.Height))
                    { window.DrawToBitmap(bitmap, new Rectangle(Point.Empty, window.Size)); bitmap.Save(args[1]); }
                    window.Hide();
                    return 0;
                }
                Application.Run(window);
            }
            return 0;
        }
        catch (Exception error)
        {
            if (args.Length != 0) Console.Error.WriteLine(error.Message);
            else MessageBox.Show(error.Message, "神器安装程序", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
