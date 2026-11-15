# Test de bout en bout du logiciel Windows : vrai raccourci global, vraie fenêtre, vraie saisie dans une fenêtre cible.
# Une fenêtre de test « Banque » s'ouvre quelques secondes ; le logiciel doit y taper identifiant, Tab, mot de passe.
# Usage : powershell -File dev/desktop-e2e.ps1 <dossier-de-reglages> <mot-de-passe-maitre> <identifiant> <mot-de-passe>
param([string]$Dir, [string]$Master, [string]$User, [string]$Pass)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$exe = Join-Path $PSScriptRoot '..\desktop\CoffreAutoType\bin\Release\net8.0-windows\CoffreAutoType.exe'
$env:COFFRE_AUTOTYPE_DIR = $Dir
$app = Start-Process -FilePath $exe -PassThru
Start-Sleep -Milliseconds 1500

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Banque - Connexion'
$form.Size = New-Object System.Drawing.Size(420, 160)
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true
$tb1 = New-Object System.Windows.Forms.TextBox; $tb1.Location = '10,10'; $tb1.Width = 380
$tb2 = New-Object System.Windows.Forms.TextBox; $tb2.Location = '10,50'; $tb2.Width = 380
$form.Controls.AddRange(@($tb1, $tb2))

$script:step = 0
$script:result = $null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1800
$timer.Add_Tick({
    switch ($script:step) {
        0 { $form.Activate(); $tb1.Focus() | Out-Null }
        1 { [System.Windows.Forms.SendKeys]::SendWait('^%k') }                 # raccourci global Ctrl+Alt+K
        2 { [System.Windows.Forms.SendKeys]::SendWait($Master + '{ENTER}') }   # mot de passe maître dans la fenêtre du logiciel
        3 { }                                                                   # déverrouillage (PBKDF2)
        4 { [System.Windows.Forms.SendKeys]::SendWait('{ENTER}') }             # identifiant sélectionné en premier (titre de la fenêtre)
        5 { }                                                                   # saisie en cours
        6 {
            $script:result = @{ user = $tb1.Text; pass = $tb2.Text }
            $timer.Stop(); $form.Close()
        }
    }
    $script:step++
})
$form.Add_Shown({ $timer.Start() })
[System.Windows.Forms.Application]::Run($form)

try { Stop-Process -Id $app.Id -Force } catch {}
$ok = ($script:result.user -eq $User) -and ($script:result.pass -eq $Pass)
if ($ok) { 'OK : identifiant et mot de passe tapés dans la fenêtre cible, séparés par Tab.' }
else { "ECHEC : obtenu utilisateur='$($script:result.user)' mot de passe='$($script:result.pass)'"; exit 1 }
