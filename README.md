# Fresh Preview Plugins ooc


Eine Sammlung von Preview-Plugins für den Fresh Editor.

---

## Plugin: markdown_preview.ts

Markdown Preview Plugin für den Fresh Editor.

### Features
- **Markdown: Toggle Preview** - Vorschau in einem Side-Split
- **Markdown: Install Glow** - Glow automatisch herunterladen

### Installation
```bash
ln -sf ~/fresh-plugins/markdown_preview.ts ~/.config/fresh/plugins/
```

### glow Auto-Install
Das Plugin installiert glow automatisch nach `~/.config/fresh/plugins/bin/glow`, falls nicht bereits installiert.

---

## Plugin: pdf_preview.ts

PDF Preview Plugin - zeigt PDFs als Text im Terminal an.

### Features
- **PDF: Toggle Preview** - PDF in einem Side-Split als Text anzeigen
- Unterstützt `ps2ascii` (ghostscript) oder `pdftotext` (poppler)

### Voraussetzungen
```bash
# Fedora/RHEL
sudo dnf install ghostscript   # für ps2ascii
# oder
sudo dnf install poppler-utils # für pdftotext

# Debian/Ubuntu
sudo apt install ghostscript   # für ps2ascii
# oder
sudo apt install poppler-utils # für pdftotext
```

### Installation
```bash
ln -sf ~/fresh-plugins/pdf_preview.ts ~/.config/fresh/plugins/
```

### Verwendung
1. Öffne eine PDF-Datei in fresh (im Read-Only Modus)
2. Drücke `Ctrl+Shift+P` für die Command Palette
3. Wähle **"PDF: Toggle Preview"**
4. Das PDF wird als Text in einem Split angezeigt

---

## Testing

### Test Scripts

| Script | Beschreibung |
|--------|-------------|
| `test_tdd.sh` | Vollständiger TDD Test |
| `test_with_screenshot.sh` | Test mit HTML Screenshots |
| `test_fresh.sh` | Einfacher Funktionstest |

### TDD Workflow

```bash
# Test ausführen
./test_tdd.sh
```

### TUI Testing unter Wayland

**Text-Output:**
```bash
tmux new-session -d -s test -x 120 -y 40 "fresh datei.md"
tmux send-keys -t test C-p
tmux capture-pane -t test -p > output.txt
```

**HTML-Screenshots (mit Farben):**
```bash
pip install tmux2html
tmux new-session -d -s test -x 120 -y 40 "fresh datei.md"
tmux2html test -o output.html
```

### Tools

| Tool | Zweck |
|------|-------|
| tmux + capture-pane | Text-Output erfassen |
| tmux2html | HTML-Screenshot mit Farben |
| termframe | SVG-Screenshot (funktioniert nicht mit fresh) |

### Wayland Screenshot Tools

| Tool | Funktioniert |
|------|-------------|
| grim | ✅ |
| gnome-screenshot | ✅ (Xwayland) |
| import (ImageMagick) | ❌ (nur X11) |
