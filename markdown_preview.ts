/// <reference path="/usr/share/fresh-editor/plugins/lib/fresh.d.ts" />
// Markdown Preview Plugin with Auto-Download
// Automatically downloads glow if not present, then renders markdown in a virtual buffer split.

const editor = getEditor();

// Configuration
const GLOW_VERSION = "v2.1.1";
const GLOW_BIN_DIR = editor.pathJoin(editor.getConfigDir(), "plugins", "bin");
const GLOW_BIN_PATH = editor.pathJoin(GLOW_BIN_DIR, "glow");

// Track preview state per source buffer
const previewState = new Map<number, {
  previewBufferId: number;
  splitId: number;
  processHandle: ProcessHandle<SpawnResult> | null;
  lastContentHash: string;
}>();

// Debounce timer for content changes
const changeDebounceTimer = new Map<number, number>();

// Check if glow is available (global or local)
async function findGlow(): Promise<string | null> {
  // Check global glow first
  try {
    const handle = editor.spawnProcess('which', ['glow']);
    const result = await handle.result;
    if (result.exit_code === 0 && result.stdout.trim()) {
      return 'glow';
    }
  } catch { /* ignore */ }

  // Check local glow
  try {
    const handle = editor.spawnProcess('test', ['-x', GLOW_BIN_PATH]);
    const result = await handle.result;
    if (result.exit_code === 0) {
      return GLOW_BIN_PATH;
    }
  } catch { /* ignore */ }

  return null;
}

// Get platform-specific download URL
function getGlowDownloadUrl(): string | null {
  // Detect platform using uname
  const platform = 'linux'; // Default to linux for now
  const arch = 'x86_64';    // Default to x86_64

  // Map to glow release naming
  let osName = 'Linux';
  let archName = 'x86_64';

  return `https://github.com/charmbracelet/glow/releases/download/${GLOW_VERSION}/glow_${GLOW_VERSION.replace('v', '')}_${osName}_${archName}.tar.gz`;
}

// Download and install glow
async function installGlow(): Promise<boolean> {
  const url = getGlowDownloadUrl();
  if (!url) {
    editor.setStatus('Unsupported platform for automatic glow installation');
    return false;
  }

  editor.setStatus('Downloading glow...');

  // Create bin directory
  editor.spawnProcess('mkdir', ['-p', GLOW_BIN_DIR]);

  const tempDir = `/tmp/fresh-glow-install-${Date.now()}`;
  const archivePath = `${tempDir}/glow.tar.gz`;

  try {
    // Create temp directory
    await editor.spawnProcess('mkdir', ['-p', tempDir]).result;

    // Download
    editor.setStatus('Downloading glow from GitHub...');
    const curlHandle = editor.spawnProcess('curl', ['-L', '-o', archivePath, url]);
    const curlResult = await curlHandle.result;

    if (curlResult.exit_code !== 0) {
      // Try wget as fallback
      const wgetHandle = editor.spawnProcess('wget', ['-O', archivePath, url]);
      const wgetResult = await wgetHandle.result;
      if (wgetResult.exit_code !== 0) {
        editor.setStatus('Failed to download glow. Please install manually.');
        return false;
      }
    }

    // Extract
    editor.setStatus('Extracting glow...');
    const extractHandle = editor.spawnProcess('tar', ['-xzf', archivePath, '-C', tempDir]);
    const extractResult = await extractHandle.result;

    if (extractResult.exit_code !== 0) {
      editor.setStatus('Failed to extract glow archive');
      return false;
    }

    // Find and move glow binary
    const findHandle = editor.spawnProcess('find', [tempDir, '-name', 'glow', '-type', 'f']);
    const findResult = await findHandle.result;

    if (findResult.exit_code !== 0 || !findResult.stdout.trim()) {
      editor.setStatus('Could not find glow binary in archive');
      return false;
    }

    const glowBinary = findResult.stdout.trim().split('\n')[0];
    const mvHandle = editor.spawnProcess('mv', [glowBinary, GLOW_BIN_PATH]);
    const mvResult = await mvHandle.result;

    if (mvResult.exit_code !== 0) {
      editor.setStatus('Failed to move glow binary');
      return false;
    }

    // Make executable
    const chmodHandle = editor.spawnProcess('chmod', ['+x', GLOW_BIN_PATH]);
    await chmodHandle.result;

    // Cleanup
    editor.spawnProcess('rm', ['-rf', tempDir]);

    editor.setStatus('glow installed successfully!');
    return true;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    editor.setStatus(`Failed to install glow: ${msg}`);
    return false;
  }
}

function isMarkdownFile(path: string): boolean {
  const ext = editor.pathExtname(path).toLowerCase();
  return ext === '.md' || ext === '.markdown' || ext === '.mkd' || ext === '.mdx';
}

// Simple hash for content comparison
function hashContent(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString();
}

// Convert JS string character offset to UTF-8 byte offset.
// Fresh Editor uses byte offsets for all buffer positions (overlays, cursors, etc.).
function charToByteOffset(text: string, charOffset: number): number {
  let bytes = 0;
  const limit = Math.min(charOffset, text.length);
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7F) bytes += 1;
    else if (code <= 0x7FF) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF) {
      bytes += 4;
      i++; // skip low surrogate
    }
    else bytes += 3;
  }
  return bytes;
}

// Convert 256-color index to RGB
function color256ToRgb(n: number): [number, number, number] | null {
  if (n < 0 || n > 255) return null;
  if (n < 8) return ANSI_COLORS[n + 30] || null;
  if (n < 16) return ANSI_COLORS[n - 8 + 90] || null;
  if (n < 232) {
    const idx = n - 16;
    const r = Math.floor(idx / 36);
    const g = Math.floor((idx % 36) / 6);
    const b = idx % 6;
    return [r ? r * 40 + 55 : 0, g ? g * 40 + 55 : 0, b ? b * 40 + 55 : 0];
  }
  const gray = (n - 232) * 10 + 8;
  return [gray, gray, gray];
}

// ANSI color/style parsing
interface AnsiSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  fg: [number, number, number] | null;
}

// Map basic ANSI color codes to RGB
const ANSI_COLORS: Record<number, [number, number, number]> = {
  30: [0, 0, 0],       // black
  31: [205, 49, 49],   // red
  32: [13, 188, 121],  // green
  33: [229, 229, 16],  // yellow
  34: [36, 114, 200],  // blue
  35: [188, 63, 188],  // magenta
  36: [17, 168, 205],  // cyan
  37: [229, 229, 229], // white
  90: [102, 102, 102], // bright black
  91: [241, 76, 76],   // bright red
  92: [35, 209, 139],  // bright green
  93: [245, 245, 67],  // bright yellow
  94: [59, 142, 234],  // bright blue
  95: [214, 112, 214], // bright magenta
  96: [41, 184, 219],  // bright cyan
  97: [229, 229, 229], // bright white
};

/**
 * Parse ANSI-encoded text into spans with style info.
 * Handles SGR sequences: bold, italic, underline, foreground colors.
 */
function parseAnsi(raw: string): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  let bold = false, italic = false, underline = false;
  let fg: [number, number, number] | null = null;

  // Split on ANSI escape sequences, keeping the sequences
  const parts = raw.split(/(\x1b\[[0-9;]*m)/);

  for (const part of parts) {
    if (!part) continue;

    const m = part.match(/^\x1b\[([0-9;]*)m$/);
    if (m) {
      // Parse SGR parameters
      const params = m[1].split(';').map(s => s === '' ? 0 : parseInt(s, 10));
      for (let i = 0; i < params.length; i++) {
        const p = params[i];
        if (p === 0) { bold = false; italic = false; underline = false; fg = null; }
        else if (p === 1) bold = true;
        else if (p === 3) italic = true;
        else if (p === 4) underline = true;
        else if (p === 22) bold = false;
        else if (p === 23) italic = false;
        else if (p === 24) underline = false;
        else if (p >= 30 && p <= 37) fg = ANSI_COLORS[p] || null;
        else if (p >= 90 && p <= 97) fg = ANSI_COLORS[p] || null;
        else if (p === 39) fg = null;
        else if (p === 38 && params[i + 1] === 5 && params[i + 2] !== undefined) {
          // 256-color fg: \e[38;5;Nm
          fg = color256ToRgb(params[i + 2]);
          i += 2;
        }
        else if (p === 38 && params[i + 1] === 2 && params.length >= i + 5) {
          // 24-bit fg: \e[38;2;R;G;Bm
          fg = [params[i + 2], params[i + 3], params[i + 4]];
          i += 4;
        }
        else if (p === 48 && params[i + 1] === 5 && params[i + 2] !== undefined) {
          // 256-color bg: skip to avoid misinterpreting color index as fg
          i += 2;
        }
        else if (p === 48 && params[i + 1] === 2 && params.length >= i + 5) {
          // 24-bit bg: skip
          i += 4;
        }
      }
    } else {
      // Text content
      if (part.length > 0) {
        spans.push({ text: part, bold, italic, underline, fg });
      }
    }
  }
  return spans;
}

async function renderPreview(sourceBufferId: number): Promise<void> {
  const state = previewState.get(sourceBufferId);
  if (!state) return;

  const info = editor.getBufferInfo(sourceBufferId);
  if (!info) return;

  // Kill any running render process
  if (state.processHandle) {
    await state.processHandle.kill();
    state.processHandle = null;
  }

  // Get current buffer length (may have changed after edits)
  const currentLength = editor.getBufferLength(sourceBufferId);
  
  // Get current buffer content (unsaved changes)
  const bufferContent = await editor.getBufferText(sourceBufferId, 0, currentLength);
  
  // Check if content actually changed (avoid unnecessary re-renders)
  const contentHash = hashContent(bufferContent);
  if (state.lastContentHash === contentHash) {
    return;
  }
  state.lastContentHash = contentHash;

  // Write to temp file for glow
  const tempFile = `/tmp/fresh-md-preview-${sourceBufferId}-${Date.now()}.md`;
  editor.writeFile(tempFile, bufferContent);

  // Disable glow's word-wrap (-w 0) so it never breaks ANSI spans mid-line.
  // The virtual buffer's lineWrap handles visual wrapping instead.
  // Force color output (CLICOLOR_FORCE) so glow emits syntax highlighting
  // for code blocks even though stdout is not a TTY.
  const glowPath = await findGlow();
  if (!glowPath) {
    editor.setStatus('glow not found. Run "Markdown: Install Glow" command.');
    editor.spawnProcess('rm', ['-f', tempFile]);
    return;
  }

  state.processHandle = editor.spawnProcess(
    'env',
    ['CLICOLOR_FORCE=1', 'COLORTERM=truecolor', glowPath, '-s', 'dark', '-w', '0', tempFile],
  );

  try {
    const result = await state.processHandle.result;
    state.processHandle = null;

    if (result.exit_code !== 0) {
      editor.setStatus(`Preview error: ${result.stderr.trim()}`);
      return;
    }

    // Parse ANSI output into styled spans
    const spans = parseAnsi(result.stdout);

    // Build plain text and track overlay positions
    let plainText = '';
    const overlays: { start: number; end: number; bold: boolean; italic: boolean; underline: boolean; fg: [number, number, number] | null }[] = [];

    for (const span of spans) {
      const start = plainText.length;
      plainText += span.text;
      const end = plainText.length;

      // Only create overlay if there's styling
      if (span.bold || span.italic || span.fg) {
        overlays.push({ start, end, bold: span.bold, italic: span.italic, underline: span.underline, fg: span.fg });
      }
    }

    // Post-process: strip heading markers, fix H1 indent, compact tables, and
    // remove trailing whitespace — while keeping overlay offsets in sync.
    const rawLines = plainText.split('\n');
    let trimmedText = '';
    let originalPos = 0;
    const adjustments: { origStart: number; removed: number }[] = [];

    for (let i = 0; i < rawLines.length; i++) {
      let line = rawLines[i];
      const lineStart = originalPos;
      let removedFromLine = 0;

      // 1. Strip heading markers (H2-H6: ##, ###, etc.)
      const headingMatch = line.match(/^(  )#{2,6} /);
      if (headingMatch) {
        const markerLen = headingMatch[0].length - headingMatch[1].length;
        adjustments.push({ origStart: lineStart + headingMatch[1].length, removed: markerLen });
        line = headingMatch[1] + line.slice(headingMatch[0].length);
        removedFromLine += markerLen;
      }

      // 2. Fix H1 indent — glow adds a decorative bold space making 3 leading spaces instead of 2
      if (!headingMatch && line.startsWith('   ') && !line.startsWith('    ')) {
        adjustments.push({ origStart: lineStart + 2, removed: 1 });
        line = '  ' + line.slice(3);
        removedFromLine += 1;
      }

      // 3. Strip trailing whitespace
      const trimmed = line.trimEnd();
      const trailingSpaces = line.length - trimmed.length;
      if (trailingSpaces > 0) {
        adjustments.push({ origStart: lineStart + line.length - trailingSpaces + removedFromLine, removed: trailingSpaces });
      }

      trimmedText += trimmed + (i < rawLines.length - 1 ? '\n' : '');
      originalPos += rawLines[i].length + 1; // +1 for \n
    }

    // Adjust overlay offsets for all removals
    for (const ov of overlays) {
      let startAdj = 0;
      let endAdj = 0;
      for (const adj of adjustments) {
        // Adjust start
        if (ov.start > adj.origStart + adj.removed) {
          startAdj += adj.removed;
        } else if (ov.start > adj.origStart) {
          startAdj += ov.start - adj.origStart;
        }
        // Adjust end
        if (ov.end > adj.origStart + adj.removed) {
          endAdj += adj.removed;
        } else if (ov.end > adj.origStart) {
          endAdj += ov.end - adj.origStart;
        }
      }
      ov.start -= startAdj;
      ov.end -= endAdj;
    }

    plainText = trimmedText;

    // Build entries for the virtual buffer
    const lines = plainText.split('\n');
    const entries: TextPropertyEntry[] = lines.map(line => ({
      text: line + '\n',
    }));

    // Update the preview buffer content
    editor.setVirtualBufferContent(state.previewBufferId, entries);

    // Clear old overlays and apply new ones
    editor.clearNamespace(state.previewBufferId, 'md-preview');

    for (const ov of overlays) {
      if (ov.start >= ov.end) continue;
      const opts: Record<string, unknown> = {};
      if (ov.fg) opts['fg'] = ov.fg;
      if (ov.bold) opts['bold'] = true;
      if (ov.italic) opts['italic'] = true;
      // Fresh uses byte offsets for overlay positions, convert from char offsets
      const byteStart = charToByteOffset(plainText, ov.start);
      const byteEnd = charToByteOffset(plainText, ov.end);
      editor.addOverlay(state.previewBufferId, 'md-preview', byteStart, byteEnd, opts);
    }
  } catch {
    // Process was killed (e.g., preview closed), ignore
    state.processHandle = null;
  } finally {
    // Cleanup temp file
    editor.spawnProcess('rm', ['-f', tempFile]);
  }
}

async function openPreview(sourceBufferId: number): Promise<void> {
  const info = editor.getBufferInfo(sourceBufferId);
  if (!info || !isMarkdownFile(info.path)) {
    editor.setStatus('Not a markdown file');
    return;
  }

  // Check glow availability first
  const glowPath = await findGlow();
  if (!glowPath) {
    editor.setStatus('glow not found. Run "Markdown: Install Glow" command.');
    return;
  }

  // Create preview virtual buffer in a vertical split
  try {
    const result = await editor.createVirtualBufferInSplit({
      name: `*Preview: ${editor.pathBasename(info.path)}*`,
      readOnly: true,
      ratio: 0.5,
      direction: 'horizontal',
      showLineNumbers: false,
      showCursors: false,
      lineWrap: true,
      entries: [{ text: 'Rendering preview...\n' }],
    });

    previewState.set(sourceBufferId, {
      previewBufferId: result.bufferId,
      splitId: result.splitId!,
      processHandle: null,
      lastContentHash: '',
    });

    // Render the preview
    await renderPreview(sourceBufferId);

    // Focus back on the source split
    editor.focusSplit(editor.getActiveSplitId());

    editor.setStatus('Markdown preview opened');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    editor.setStatus(`Failed to open preview: ${msg}`);
  }
}

function closePreview(sourceBufferId: number): void {
  const state = previewState.get(sourceBufferId);
  if (!state) return;

  // Clear any pending debounce timer
  const timer = changeDebounceTimer.get(sourceBufferId);
  if (timer) {
    clearTimeout(timer);
    changeDebounceTimer.delete(sourceBufferId);
  }

  // Kill render process
  if (state.processHandle) {
    state.processHandle.kill();
  }

  // Close preview buffer and split
  editor.closeBuffer(state.previewBufferId);
  if (state.splitId) {
    editor.closeSplit(state.splitId);
  }

  previewState.delete(sourceBufferId);
  editor.setStatus('Markdown preview closed');
}

// Toggle preview for current buffer
globalThis.markdownTogglePreview = async function(): Promise<void> {
  const bufferId = editor.getActiveBufferId();

  if (previewState.has(bufferId)) {
    closePreview(bufferId);
  } else {
    await openPreview(bufferId);
  }
};

// Refresh preview on save
globalThis.onMarkdownPreviewBufferSaved = async function(data: {
  buffer_id: number;
}): Promise<void> {
  if (previewState.has(data.buffer_id)) {
    await renderPreview(data.buffer_id);
  }
};

// Hot reload: refresh preview after insert (debounced)
globalThis.onMarkdownPreviewAfterInsert = function(data: {
  buffer_id: number;
}): void {
  if (!previewState.has(data.buffer_id)) return;
  
  // Clear existing timer
  const existingTimer = changeDebounceTimer.get(data.buffer_id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  
  // Set new timer (300ms debounce)
  const timer = setTimeout(() => {
    changeDebounceTimer.delete(data.buffer_id);
    renderPreview(data.buffer_id);
  }, 300);
  
  changeDebounceTimer.set(data.buffer_id, timer as unknown as number);
};

// Hot reload: refresh preview after delete (debounced)
globalThis.onMarkdownPreviewAfterDelete = function(data: {
  buffer_id: number;
}): void {
  if (!previewState.has(data.buffer_id)) return;
  
  // Clear existing timer
  const existingTimer = changeDebounceTimer.get(data.buffer_id);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }
  
  // Set new timer (300ms debounce)
  const timer = setTimeout(() => {
    changeDebounceTimer.delete(data.buffer_id);
    renderPreview(data.buffer_id);
  }, 300);
  
  changeDebounceTimer.set(data.buffer_id, timer as unknown as number);
};

// Clean up when source buffer is closed
globalThis.onMarkdownPreviewBufferClosed = function(data: {
  buffer_id: number;
}): void {
  // Clear any pending debounce timer
  const timer = changeDebounceTimer.get(data.buffer_id);
  if (timer) {
    clearTimeout(timer);
    changeDebounceTimer.delete(data.buffer_id);
  }
  
  if (previewState.has(data.buffer_id)) {
    closePreview(data.buffer_id);
  }

  // Also check if a preview buffer was closed directly
  for (const [sourceId, state] of previewState.entries()) {
    if (state.previewBufferId === data.buffer_id) {
      if (state.processHandle) {
        state.processHandle.kill();
      }
      previewState.delete(sourceId);
      break;
    }
  }
};

// Register events
editor.on('after_file_save', 'onMarkdownPreviewBufferSaved');
editor.on('after_insert', 'onMarkdownPreviewAfterInsert');
editor.on('after_delete', 'onMarkdownPreviewAfterDelete');
editor.on('buffer_closed', 'onMarkdownPreviewBufferClosed');

// Install glow command
globalThis.markdownInstallGlow = async function(): Promise<void> {
  const existing = await findGlow();
  if (existing && existing !== GLOW_BIN_PATH) {
    editor.setStatus(`glow already installed: ${existing}`);
    return;
  }

  if (existing === GLOW_BIN_PATH) {
    editor.setStatus('glow already installed locally.');
    return;
  }

  const success = await installGlow();
  if (success) {
    editor.setStatus('glow installed! You can now use Markdown: Toggle Preview');
  }
};

// Register commands
editor.registerCommand(
  'Markdown: Toggle Preview',
  'Toggle markdown preview in a side split (rendered with glow)',
  'markdownTogglePreview',
  null
);

editor.registerCommand(
  'Markdown: Install Glow',
  'Download and install glow automatically',
  'markdownInstallGlow',
  null
);

editor.debug('Markdown Preview plugin loaded - use "Markdown: Toggle Preview" command');
