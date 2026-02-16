#!/bin/bash
set -euo pipefail

SESSION="fresh-tdd-test-$$"
KEEP_SCREENSHOTS="${KEEP_SCREENSHOTS:-true}"

if [ "$KEEP_SCREENSHOTS" = "true" ]; then
  TMPDIR="/tmp/fresh-tdd-screenshots-$(date +%Y%m%d-%H%M%S)"
else
  TMPDIR="/tmp/fresh-tdd-$$"
fi

SCREENSHOTDIR="$TMPDIR/screenshots"
mkdir -p "$TMPDIR"
mkdir -p "$SCREENSHOTDIR"

cleanup() {
  if [ "$KEEP_SCREENSHOTS" = "false" ]; then
    tmux kill-session -t "$SESSION" 2>/dev/null || true
    rm -rf "$TMPDIR"
  else
    tmux kill-session -t "$SESSION" 2>/dev/null || true
  fi
}
trap cleanup EXIT

capture_screen() {
  local name="$1"
  local txt_path="$SCREENSHOTDIR/$name.txt"
  local html_path="$SCREENSHOTDIR/$name.html"
  
  tmux capture-pane -t "$SESSION" -p > "$txt_path"
  tmux2html "$SESSION" -o "$html_path" 2>/dev/null || true
  
  echo "📸 Screenshot: $html_path"
}

rm -rf ~/.config/fresh/plugins/bin/
if which glow &>/dev/null; then
  sudo rm -f "$(which glow)"
fi

echo "=== All glow removed ==="

# Create test file first
mkdir -p "$TMPDIR"
cat > "$TMPDIR/test_hotreload.md" << 'EOF'
# Test Document

Initial content.
EOF

tmux new-session -d -s "$SESSION" -x 120 -y 40 "fresh $TMPDIR/test_hotreload.md"
sleep 3

echo ""
echo "=== STEP 1: Toggle Preview (auto-installs glow) ==="
tmux send-keys -t "$SESSION" C-p
sleep 1
tmux send-keys -t "$SESSION" "Markdown"
sleep 1
tmux send-keys -t "$SESSION" Enter
sleep 5

capture_screen "step1_before_toggle"

tmux capture-pane -t "$SESSION" -p > "$TMPDIR/step1.txt"

OUTPUT=$(cat "$TMPDIR/step1.txt")
echo "$OUTPUT"
capture_screen "step1_after_toggle"

if [ -x ~/.config/fresh/plugins/bin/glow ]; then
  echo "✅ STEP 1 PASSED: Glow installed"
else
  echo "❌ STEP 1 FAILED: Glow binary not found"
  echo "📸 Screenshots: $SCREENSHOTDIR/"
  exit 1
fi

echo ""
echo "=== STEP 2: Hot Reload Test ==="

# Preview already opened by STEP 1, switch to right split and capture
tmux send-keys -t "$SESSION" C-w
sleep 0.3
tmux send-keys -t "$SESSION" l
sleep 0.3

capture_screen "step2_preview_opened"

# Capture initial preview content
tmux capture-pane -t "$SESSION" -p > "$TMPDIR/step2_initial.txt"
INITIAL_CONTENT=$(cat "$TMPDIR/step2_initial.txt")
echo "Initial preview content captured"

# Switch back to left split (source) to edit
tmux send-keys -t "$SESSION" C-w
sleep 0.3
tmux send-keys -t "$SESSION" h
sleep 0.3

# Type new content (simulating edit without save)
tmux send-keys -t "$SESSION" "o"  # Open new line in vim mode
sleep 0.3
tmux send-keys -t "$SESSION" "## Added Section"
sleep 0.5
tmux send-keys -t "$SESSION" Escape  # Exit insert mode
sleep 0.3

# Wait for debounce (300ms) + render time
sleep 1

# Switch to right split (preview) to check update
tmux send-keys -t "$SESSION" C-w
sleep 0.3
tmux send-keys -t "$SESSION" l
sleep 0.3

capture_screen "step2_after_edit"

# Capture updated preview content
tmux capture-pane -t "$SESSION" -p > "$TMPDIR/step2_after_edit.txt"
UPDATED_CONTENT=$(cat "$TMPDIR/step2_after_edit.txt")

# Check if preview updated (should contain "Added" - the heading we added)
if echo "$UPDATED_CONTENT" | grep -q "Added"; then
  echo "✅ STEP 2 PASSED: Hot reload works - preview updated without saving"
else
  echo "❌ STEP 2 FAILED: Preview did not update after edit"
  echo "📸 Screenshots: $SCREENSHOTDIR/"
  diff "$TMPDIR/step2_initial.txt" "$TMPDIR/step2_after_edit.txt" || true
  exit 1
fi

# Close preview
tmux send-keys -t "$SESSION" C-p
sleep 0.5
tmux send-keys -t "$SESSION" "Markdown: Toggle Preview"
sleep 0.5
tmux send-keys -t "$SESSION" Enter
sleep 1

echo ""
echo "=========================================="
echo "✅ ALL TESTS PASSED"
echo "=========================================="
echo "📸 Screenshots: $SCREENSHOTDIR/"
ls -la "$SCREENSHOTDIR/"

tmux kill-session -t "$SESSION" 2>/dev/null || true
