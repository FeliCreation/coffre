using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace CoffreAutoType;

/// <summary>Appels Windows : raccourci global, fenêtre active, saisie de caractères (SendInput).</summary>
static class Native
{
    public const int WM_HOTKEY = 0x0312;
    public const uint MOD_ALT = 1, MOD_CONTROL = 2, MOD_SHIFT = 4, MOD_WIN = 8, MOD_NOREPEAT = 0x4000;
    const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 2, KEYEVENTF_UNICODE = 4;
    const ushort VK_TAB = 0x09, VK_RETURN = 0x0D;

    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion { [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)]
    struct INPUT { public uint type; public InputUnion u; }

    public static string WindowTitle(IntPtr h)
    {
        var sb = new StringBuilder(256);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ProcessName(IntPtr h)
    {
        try
        {
            GetWindowThreadProcessId(h, out var pid);
            return pid == 0 ? "" : Process.GetProcessById((int)pid).ProcessName;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException) { return ""; }
    }

    /// <summary>Ramène une fenêtre au premier plan ; false si Windows la refuse (on ne tape alors RIEN).</summary>
    public static bool BringToFront(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        SetForegroundWindow(h);
        for (var i = 0; i < 20; i++)
        {
            if (GetForegroundWindow() == h) return true;
            Thread.Sleep(50);
        }
        return false;
    }

    /// <summary>Attend que Ctrl/Alt/Maj/Windows soient relâchées : sinon le texte serait tapé avec ces modificateurs.</summary>
    public static void WaitModifiersReleased()
    {
        for (var i = 0; i < 60; i++)
        {
            if (new[] { 0x11, 0x12, 0x10, 0x5B, 0x5C }.All(vk => (GetAsyncKeyState(vk) & 0x8000) == 0)) return;
            Thread.Sleep(50);
        }
    }

    static INPUT Key(ushort vk, ushort scan, uint flags) => new()
    {
        type = INPUT_KEYBOARD,
        u = new InputUnion { ki = new KEYBDINPUT { wVk = vk, wScan = scan, dwFlags = flags } },
    };

    /// <summary>Tape le texte caractère par caractère (Unicode) ; '\t' = Tab, '\n' = Entrée.</summary>
    public static void TypeText(string text)
    {
        foreach (var c in text)
        {
            INPUT[] pair = c switch
            {
                '\t' => new[] { Key(VK_TAB, 0, 0), Key(VK_TAB, 0, KEYEVENTF_KEYUP) },
                '\n' => new[] { Key(VK_RETURN, 0, 0), Key(VK_RETURN, 0, KEYEVENTF_KEYUP) },
                _ => new[] { Key(0, c, KEYEVENTF_UNICODE), Key(0, c, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP) },
            };
            SendInput(2, pair, Marshal.SizeOf<INPUT>());
            Thread.Sleep(6); // certaines applications perdent les caractères trop rapprochés
        }
    }
}
