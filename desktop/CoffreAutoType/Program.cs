using System.Drawing;
using Microsoft.Win32;

namespace CoffreAutoType;

static class Program
{
    [STAThread]
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--selftest") return SelfTest.Run(args);

        using var mutex = new Mutex(true, "Local\\CoffreAutoType.SingleInstance", out var first);
        if (!first) return 0; // déjà lancé : l'icône est dans la zone de notification

        ApplicationConfiguration.Initialize();
        Application.Run(new TrayApp());
        return 0;
    }
}

/// <summary>Icône de la zone de notification + raccourci global + saisie dans la fenêtre précédente.</summary>
sealed class TrayApp : ApplicationContext
{
    const int HotkeyId = 0xC0FE;
    const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    readonly Session session = new();
    readonly PickerForm picker;
    readonly NotifyIcon tray;
    readonly HotkeyWindow hotkeyWindow;
    readonly System.Windows.Forms.Timer lockTimer = new() { Interval = 15_000 };

    public TrayApp()
    {
        picker = new PickerForm(session);
        picker.Picked += OnPicked;
        picker.LockRequested += () => session.Lock();

        var menu = new ContextMenuStrip();
        menu.Items.Add("Ouvrir", null, (_, _) => Open());
        menu.Items.Add("Réglages du dépôt…", null, (_, _) => picker.ShowFor(Native.GetForegroundWindow(), setup: true));
        menu.Items.Add("Verrouiller", null, (_, _) => session.Lock());
        var startup = new ToolStripMenuItem("Lancer au démarrage de Windows") { Checked = IsStartup() };
        startup.Click += (_, _) => { SetStartup(!startup.Checked); startup.Checked = IsStartup(); };
        menu.Items.Add(startup);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Quitter", null, (_, _) => ExitThread());

        tray = new NotifyIcon { Text = "Coffre : saisie automatique", Visible = true, ContextMenuStrip = menu, Icon = LoadIcon() };
        tray.DoubleClick += (_, _) => Open();

        hotkeyWindow = new HotkeyWindow(Open);
        var (mods, vk) = ParseHotkey(session.Settings.Hotkey);
        if (!Native.RegisterHotKey(hotkeyWindow.Handle, HotkeyId, mods | Native.MOD_NOREPEAT, vk))
            tray.ShowBalloonTip(5000, "Coffre", $"Le raccourci {session.Settings.Hotkey} est déjà pris par un autre logiciel. Utilisez l'icône de la zone de notification.", ToolTipIcon.Warning);

        lockTimer.Tick += (_, _) =>
        {
            var minutes = session.Settings.AutoLockMinutes;
            if (session.Unlocked && minutes > 0 && DateTime.UtcNow - session.LastUse > TimeSpan.FromMinutes(minutes)) session.Lock();
        };
        lockTimer.Start();
        SystemEvents.SessionSwitch += (_, e) => { if (e.Reason is SessionSwitchReason.SessionLock or SessionSwitchReason.ConsoleDisconnect) session.Lock(); };

        if (!session.Settings.HasVault) tray.ShowBalloonTip(6000, "Coffre", $"Appuyez sur {session.Settings.Hotkey} pour configurer la saisie automatique.", ToolTipIcon.Info);
    }

    static Icon LoadIcon()
    {
        try
        {
            using var bmp = new Bitmap(Path.Combine(AppContext.BaseDirectory, "icon.png"));
            return Icon.FromHandle(bmp.GetHicon());
        }
        catch (Exception e) when (e is IOException or ArgumentException) { return SystemIcons.Shield; }
    }

    void Open()
    {
        var fg = Native.GetForegroundWindow();
        if (picker.Visible) { picker.Hide(); return; }
        picker.ShowFor(fg == picker.Handle ? IntPtr.Zero : fg);
    }

    /// <summary>Retourne dans la fenêtre d'origine, vérifie qu'elle est bien active, puis tape. Sinon ne tape RIEN.</summary>
    void OnPicked(Entry e, TypeMode mode)
    {
        if (!Native.BringToFront(picker.Target))
        {
            tray.ShowBalloonTip(4000, "Coffre", "Impossible de revenir à la fenêtre d'origine : rien n'a été tapé.", ToolTipIcon.Warning);
            return;
        }
        Native.WaitModifiersReleased();
        var text = mode switch
        {
            TypeMode.PasswordOnly => e.Password,
            TypeMode.UsernameOnly => e.Username,
            _ => (e.Username.Length > 0 ? e.Username + "\t" : "") + e.Password + (session.Settings.PressEnter ? "\n" : ""),
        };
        Native.TypeText(text);
        session.Touch();
    }

    static (uint mods, uint vk) ParseHotkey(string spec)
    {
        uint mods = 0;
        var vk = (uint)Keys.K;
        foreach (var part in spec.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl" or "control": mods |= Native.MOD_CONTROL; break;
                case "alt": mods |= Native.MOD_ALT; break;
                case "shift": mods |= Native.MOD_SHIFT; break;
                case "win": mods |= Native.MOD_WIN; break;
                default: if (Enum.TryParse<Keys>(part, true, out var k)) vk = (uint)k; break;
            }
        }
        return mods == 0 ? (Native.MOD_CONTROL | Native.MOD_ALT, vk) : (mods, vk); // jamais de raccourci sans modificateur
    }

    static bool IsStartup()
    {
        using var k = Registry.CurrentUser.OpenSubKey(RunKey);
        return k?.GetValue("CoffreAutoType") is string;
    }

    static void SetStartup(bool on)
    {
        using var k = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        if (k is null) return;
        if (on) k.SetValue("CoffreAutoType", $"\"{Environment.ProcessPath}\"");
        else k.DeleteValue("CoffreAutoType", throwOnMissingValue: false);
    }

    protected override void ExitThreadCore()
    {
        Native.UnregisterHotKey(hotkeyWindow.Handle, HotkeyId);
        hotkeyWindow.DestroyHandle();
        tray.Visible = false;
        tray.Dispose();
        session.Lock();
        base.ExitThreadCore();
    }

    sealed class HotkeyWindow : NativeWindow
    {
        readonly Action onHotkey;
        public HotkeyWindow(Action onHotkey)
        {
            this.onHotkey = onHotkey;
            CreateHandle(new CreateParams());
        }
        protected override void WndProc(ref Message m)
        {
            if (m.Msg == Native.WM_HOTKEY) onHotkey();
            else base.WndProc(ref m);
        }
    }
}
