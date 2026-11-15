using System.Drawing;

namespace CoffreAutoType;

/// <summary>Fenêtre du raccourci : configuration, déverrouillage, puis choix de l'identifiant à saisir.</summary>
sealed class PickerForm : Form
{
    readonly Session s;
    readonly Label status = new() { AutoSize = false, Height = 38, Dock = DockStyle.Top, Padding = new Padding(10, 8, 10, 0), Font = new Font("Segoe UI", 9f, FontStyle.Bold) };
    readonly Label error = new() { AutoSize = false, Height = 38, Dock = DockStyle.Bottom, Padding = new Padding(10, 4, 10, 0), ForeColor = Color.Firebrick };
    readonly Label hint = new() { AutoSize = false, Height = 22, Dock = DockStyle.Bottom, Padding = new Padding(10, 0, 10, 0), ForeColor = SystemColors.GrayText, Font = new Font("Segoe UI", 8f) };
    readonly FlowLayoutPanel setupPanel = Panel(), unlockPanel = Panel(), listPanel = Panel();
    readonly TextBox repoBox = Box(), tokenBox = Box(password: true), pwBox = Box(password: true), searchBox = Box();
    readonly ListView list = new() { View = View.Details, FullRowSelect = true, HideSelection = false, MultiSelect = false, Width = 520, Height = 250, Font = new Font("Segoe UI", 9.5f) };
    Button setupGo = null!, unlockGo = null!;
    IntPtr target;
    string targetTitle = "", targetProcess = "";
    bool busy;
    bool forceSetup;

    public IntPtr Target => target;
    public event Action<Entry, TypeMode>? Picked;
    public event Action? LockRequested;

    static FlowLayoutPanel Panel() => new() { Dock = DockStyle.Fill, FlowDirection = FlowDirection.TopDown, WrapContents = false, Padding = new Padding(10, 4, 10, 0), Visible = false };
    static TextBox Box(bool password = false) => new() { Width = 520, UseSystemPasswordChar = password, Font = new Font("Segoe UI", 10f) };
    static Label Para(string t) => new() { Text = t, AutoSize = true, MaximumSize = new Size(520, 0), Margin = new Padding(0, 4, 0, 6) };
    static Button Btn(string t, EventHandler onClick) { var b = new Button { Text = t, AutoSize = true, Padding = new Padding(8, 3, 8, 3), Margin = new Padding(0, 6, 8, 0) }; b.Click += onClick; return b; }

    public PickerForm(Session session)
    {
        s = session;
        Text = "Coffre : saisie automatique";
        ClientSize = new Size(560, 400);
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = MinimizeBox = false;
        StartPosition = FormStartPosition.CenterScreen;
        TopMost = true;
        ShowInTaskbar = false;
        KeyPreview = true;
        AutoScaleMode = AutoScaleMode.Dpi;
        Font = new Font("Segoe UI", 9f);

        // Configuration
        setupGo = Btn("Télécharger mon coffre", async (_, _) => await RunSetup());
        setupPanel.Controls.AddRange(new Control[] {
            Para("Dépôt GitHub privé qui contient votre coffre chiffré (le même que dans l'extension) :"), repoBox,
            Para("Jeton GitHub limité à ce dépôt (lecture suffit). Il est protégé par votre session Windows :"), tokenBox,
            Para("Ce logiciel ne fait que LIRE votre coffre : il ne le modifie jamais."), setupGo });
        repoBox.KeyDown += (_, e) => { if (e.KeyCode == Keys.Enter) { tokenBox.Focus(); e.SuppressKeyPress = true; } };
        tokenBox.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await RunSetup(); } };

        // Déverrouillage
        unlockGo = Btn("Déverrouiller", async (_, _) => await RunUnlock());
        unlockPanel.Controls.AddRange(new Control[] { Para("Mot de passe maître :"), pwBox, unlockGo,
            Btn("Réglages du dépôt…", (_, _) => { forceSetup = true; ApplyState(); }) });
        pwBox.KeyDown += async (_, e) => { if (e.KeyCode == Keys.Enter) { e.SuppressKeyPress = true; await RunUnlock(); } };

        // Liste
        list.Columns.Add("Titre", 200);
        list.Columns.Add("Identifiant", 170);
        list.Columns.Add("Site", 135);
        list.DoubleClick += (_, _) => Pick(TypeMode.Both);
        searchBox.PlaceholderText = "Rechercher…";
        searchBox.TextChanged += (_, _) => FillList();
        var bar = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.LeftToRight, Margin = new Padding(0) };
        bar.Controls.AddRange(new Control[] {
            Btn("Mettre à jour", async (_, _) => await RunRefresh()),
            Btn("Verrouiller", (_, _) => { Hide(); LockRequested?.Invoke(); }),
            Btn("Réglages…", (_, _) => { forceSetup = true; ApplyState(); }) });
        listPanel.Controls.AddRange(new Control[] { searchBox, list, bar });

        hint.Text = "Entrée : identifiant + mot de passe · Ctrl+Entrée : mot de passe · Maj+Entrée : identifiant · Échap : fermer";
        Controls.Add(listPanel);
        Controls.Add(setupPanel);
        Controls.Add(unlockPanel);
        Controls.Add(hint);
        Controls.Add(error);
        Controls.Add(status);

        Deactivate += (_, _) => { if (!busy && Visible) Hide(); }; // la fenêtre ne reste jamais ouverte en arrière-plan
    }

    public void ShowFor(IntPtr targetWindow, bool setup = false)
    {
        target = targetWindow;
        targetTitle = Native.WindowTitle(targetWindow);
        targetProcess = Native.ProcessName(targetWindow);
        forceSetup = setup;
        error.Text = "";
        ApplyState();
        Show();
        Activate();
        Native.SetForegroundWindow(Handle);
        FocusMain();
    }

    void FocusMain()
    {
        if (setupPanel.Visible) repoBox.Focus();
        else if (unlockPanel.Visible) pwBox.Focus();
        else searchBox.Focus();
    }

    void ApplyState()
    {
        var shown = target == IntPtr.Zero ? "" : $"Saisie dans : {Shorten(targetTitle, 60)}{(targetProcess.Length > 0 ? $" ({targetProcess})" : "")}";
        var setup = forceSetup || !s.Settings.HasVault;
        setupPanel.Visible = setup;
        unlockPanel.Visible = !setup && !s.Unlocked;
        listPanel.Visible = !setup && s.Unlocked;
        status.Text = setup ? "Configuration" : s.Unlocked ? shown : "Coffre verrouillé\n" + shown;
        if (setup)
        {
            repoBox.Text = s.Settings.Repo;
            tokenBox.Text = "";
        }
        if (listPanel.Visible)
        {
            searchBox.Text = "";
            FillList();
        }
        pwBox.Text = "";
        FocusMain();
    }

    static string Shorten(string t, int n) => t.Length <= n ? t : t[..(n - 1)] + "…";

    /// <summary>Les identifiants dont le titre ou le site apparaît dans la fenêtre visée passent en premier.</summary>
    int Score(Entry e)
    {
        var hay = $"{targetTitle} {targetProcess}";
        var score = 0;
        if (e.Title.Length >= 3 && hay.Contains(e.Title, StringComparison.CurrentCultureIgnoreCase)) score += 2;
        var label = e.Host.Split('.')[0];
        if (label.Length >= 3 && hay.Contains(label, StringComparison.CurrentCultureIgnoreCase)) score += 1;
        return score;
    }

    void FillList()
    {
        if (s.Entries is null) return;
        var q = searchBox.Text.Trim();
        var rows = s.Entries
            .Where(e => q.Length == 0 || new[] { e.Title, e.Url, e.Username }.Any(f => f.Contains(q, StringComparison.CurrentCultureIgnoreCase)))
            .OrderByDescending(Score).ThenBy(e => e.Title, StringComparer.CurrentCultureIgnoreCase)
            .Take(300).ToList();
        list.BeginUpdate();
        list.Items.Clear();
        foreach (var e in rows) list.Items.Add(new ListViewItem(new[] { e.Title, e.Username, e.Host }) { Tag = e });
        if (list.Items.Count > 0) list.Items[0].Selected = true;
        list.EndUpdate();
    }

    void Pick(TypeMode mode)
    {
        if (list.SelectedItems.Count == 0 || list.SelectedItems[0].Tag is not Entry e) return;
        Hide();
        Picked?.Invoke(e, mode);
    }

    async Task Run(Func<Task> action, Button button, string busyText)
    {
        busy = true;
        error.Text = "";
        var old = button.Text;
        button.Enabled = false;
        button.Text = busyText;
        try { await action(); }
        catch (Exception ex) when (ex is VaultException or SyncException) { error.Text = ex.Message; }
        finally { busy = false; button.Enabled = true; button.Text = old; }
    }

    async Task RunSetup() => await Run(async () =>
    {
        await s.Join(repoBox.Text, tokenBox.Text);
        tokenBox.Text = "";
        forceSetup = false;
        ApplyState();
    }, setupGo, "Téléchargement…");

    async Task RunUnlock() => await Run(async () =>
    {
        await s.Unlock(pwBox.Text);
        pwBox.Text = "";
        ApplyState();
    }, unlockGo, "Déverrouillage…");

    async Task RunRefresh()
    {
        busy = true;
        error.Text = "";
        try
        {
            await s.Download();
            error.ForeColor = Color.SeaGreen;
            error.Text = "Coffre mis à jour. Reverrouillez puis déverrouillez pour afficher les changements.";
        }
        catch (SyncException ex) { error.ForeColor = Color.Firebrick; error.Text = ex.Message; }
        finally { busy = false; }
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        if (keyData == Keys.Escape) { Hide(); return true; }
        if (listPanel.Visible)
        {
            switch (keyData)
            {
                case Keys.Enter: Pick(TypeMode.Both); return true;
                case Keys.Control | Keys.Enter: Pick(TypeMode.PasswordOnly); return true;
                case Keys.Shift | Keys.Enter: Pick(TypeMode.UsernameOnly); return true;
                case Keys.Down or Keys.Up:
                    if (list.Items.Count == 0) return true;
                    var i = Math.Clamp((list.SelectedIndices.Count > 0 ? list.SelectedIndices[0] : -1) + (keyData == Keys.Down ? 1 : -1), 0, list.Items.Count - 1);
                    list.Items[i].Selected = true;
                    list.EnsureVisible(i);
                    return true;
            }
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); }
        base.OnFormClosing(e);
    }
}
