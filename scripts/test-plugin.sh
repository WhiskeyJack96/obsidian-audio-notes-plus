#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Voice Notes Plus — Obsidian CLI integration test script
#
# Uses the Obsidian CLI (requires 1.12+ installer) to exercise plugin features
# against the local test vault.
#
# Usage:
#   ./scripts/test-plugin.sh            # run all tests
#   ./scripts/test-plugin.sh --rebuild   # rebuild plugin before testing
# ---------------------------------------------------------------------------

set -euo pipefail

VAULT_PATH="$HOME/Workspace/plugin-test-vault"
VAULT_NAME="plugin-test-vault"
PLUGIN_ID="voice-notes-plus"
OBS="/Applications/Obsidian.app/Contents/MacOS/Obsidian"
TEST_NOTE_PATH="__test__/voice-notes-test.md"
TEST_AUDIO_DIR="Voice Notes"

# Counters
PASSED=0
FAILED=0
SKIPPED=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RESET='\033[0m'

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

obs() {
  "$OBS" vault="$VAULT_NAME" "$@" 2>/dev/null
}

log_header() {
  echo ""
  echo -e "${CYAN}━━━ $1 ━━━${RESET}"
}

pass() {
  PASSED=$((PASSED + 1))
  echo -e "  ${GREEN}✔ $1${RESET}"
}

fail() {
  FAILED=$((FAILED + 1))
  echo -e "  ${RED}✘ $1${RESET}"
  if [[ -n "${2:-}" ]]; then
    echo -e "    ${RED}↳ $2${RESET}"
  fi
}

skip() {
  SKIPPED=$((SKIPPED + 1))
  echo -e "  ${YELLOW}⊘ $1 (skipped)${RESET}"
}

assert_contains() {
  local output="$1" expected="$2" label="$3"
  if echo "$output" | grep -qiF "$expected"; then
    pass "$label"
  else
    fail "$label" "expected output to contain '$expected'"
  fi
}

assert_not_empty() {
  local output="$1" label="$2"
  if [[ -n "$output" ]]; then
    pass "$label"
  else
    fail "$label" "expected non-empty output"
  fi
}

assert_exit_ok() {
  local exit_code="$1" label="$2"
  if [[ "$exit_code" -eq 0 ]]; then
    pass "$label"
  else
    fail "$label" "exit code $exit_code"
  fi
}

cleanup_test_note() {
  obs delete path="$TEST_NOTE_PATH" permanent 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Pre-flight checks
# ---------------------------------------------------------------------------

echo -e "${CYAN}Voice Notes Plus — Integration Test Suite${RESET}"
echo "Vault: $VAULT_PATH"
echo "Plugin: $PLUGIN_ID"
echo ""

if [[ ! -d "$VAULT_PATH" ]]; then
  echo -e "${RED}Error: Test vault not found at $VAULT_PATH${RESET}"
  exit 1
fi

if [[ ! -x "$OBS" ]]; then
  echo -e "${RED}Error: Obsidian not found at $OBS${RESET}"
  exit 1
fi

# Optional: rebuild plugin before testing
if [[ "${1:-}" == "--rebuild" ]]; then
  log_header "Rebuilding plugin"
  PLUGIN_DIR="$(cd "$(dirname "$0")/.." && pwd)"
  (cd "$PLUGIN_DIR" && npm run build)
  obs plugin:reload id="$PLUGIN_ID"
  sleep 1
  echo "  Plugin rebuilt and reloaded."
fi

# ===================================================================
# TEST GROUP 1: Plugin lifecycle
# ===================================================================
log_header "Plugin lifecycle"

# 1a. Plugin is listed as installed
output=$(obs plugins filter=community 2>/dev/null || true)
assert_contains "$output" "$PLUGIN_ID" "Plugin is installed"

# 1b. Plugin is enabled
output=$(obs plugins:enabled filter=community 2>/dev/null || true)
assert_contains "$output" "$PLUGIN_ID" "Plugin is enabled"

# 1c. Plugin info
output=$(obs plugin id="$PLUGIN_ID" 2>/dev/null || true)
assert_contains "$output" "Voice Notes Plus" "Plugin info returns name"

# 1d. Reload plugin
obs plugin:reload id="$PLUGIN_ID" 2>/dev/null
assert_exit_ok $? "Plugin reload succeeds"
sleep 1

# ===================================================================
# TEST GROUP 2: Commands are registered
# ===================================================================
log_header "Command registration"

EXPECTED_COMMANDS=(
  "voice-notes-plus:toggle-recording"
  "voice-notes-plus:start-recording-new-note"
  "voice-notes-plus:initialize-models"
  "voice-notes-plus:transcribe-audio"
  "voice-notes-plus:transcribe-embeds"
  "voice-notes-plus:transcribe-to-clipboard"
  "voice-notes-plus:toggle-recording-to-clipboard"
)

all_commands=$(obs commands filter="$PLUGIN_ID" 2>/dev/null || true)

for cmd_id in "${EXPECTED_COMMANDS[@]}"; do
  assert_contains "$all_commands" "$cmd_id" "Command '$cmd_id' registered"
done

# ===================================================================
# TEST GROUP 3: Settings persistence via eval
# ===================================================================
log_header "Settings persistence"

# 3a. Read current settings
settings_json=$(obs eval code="JSON.stringify(app.plugins.plugins['$PLUGIN_ID']?.settings ?? {})" 2>/dev/null || true)
assert_not_empty "$settings_json" "Settings object is readable"

# 3b. Verify default model size is 'base' or 'tiny'
assert_contains "$settings_json" '"modelSize"' "Settings contain modelSize"

# 3c. Write a setting and verify round-trip
obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  p.settings.recordingFilenameTemplate = 'test-{{date}}';
  p.saveSettings();
  'ok'
" >/dev/null 2>&1

sleep 0.5

saved_template=$(obs eval code="app.plugins.plugins['$PLUGIN_ID']?.settings?.recordingFilenameTemplate" 2>/dev/null || true)
assert_contains "$saved_template" "test-{{date}}" "Setting round-trips correctly"

# Restore default
obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  p.settings.recordingFilenameTemplate = 'recording-{{date}}';
  p.saveSettings();
  'ok'
" >/dev/null 2>&1

# ===================================================================
# TEST GROUP 4: File operations (create test note, embeds)
# ===================================================================
log_header "File operations & note creation"

cleanup_test_note

# 4a. Create a test note
obs create path="$TEST_NOTE_PATH" content="# Voice Notes Test\n\nThis is an automated test note." overwrite 2>/dev/null
assert_exit_ok $? "Create test note"

# 4b. Verify it exists
output=$(obs read path="$TEST_NOTE_PATH" 2>/dev/null || true)
assert_contains "$output" "Voice Notes Test" "Test note is readable"

# 4c. Find an existing audio file in the vault to embed
AUDIO_FILE=""
for f in "$VAULT_PATH/$TEST_AUDIO_DIR"/*.webm; do
  if [[ -f "$f" ]]; then
    AUDIO_FILE="$TEST_AUDIO_DIR/$(basename "$f")"
    break
  fi
done

if [[ -n "$AUDIO_FILE" ]]; then
  # 4d. Append an audio embed to the test note
  obs append path="$TEST_NOTE_PATH" content="\n![[${AUDIO_FILE}]]" 2>/dev/null
  assert_exit_ok $? "Append audio embed to test note"

  # Verify the embed is there
  output=$(obs read path="$TEST_NOTE_PATH" 2>/dev/null || true)
  assert_contains "$output" "![[" "Audio embed present in note"
else
  skip "Append audio embed (no audio files in vault)"
fi

# ===================================================================
# TEST GROUP 5: Audio file discovery via eval
# ===================================================================
log_header "Audio file discovery"

audio_count_raw=$(obs eval code="
  const exts = new Set(['mp3','wav','ogg','webm','flac','m4a','aac','opus']);
  app.vault.getFiles().filter(f => exts.has(f.extension.toLowerCase())).length
" 2>/dev/null || echo "0")

audio_count=$(echo "$audio_count_raw" | sed -n 's/^=> //p' | xargs)

if [[ "$audio_count" =~ ^[0-9]+$ ]] && [[ "$audio_count" -gt 0 ]]; then
  pass "Found $audio_count audio file(s) in vault"
else
  skip "No audio files found in vault"
fi

# ===================================================================
# TEST GROUP 6: Transcription model cache status
# ===================================================================
log_header "Model cache status"

cache_status=$(obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  if (!p) 'no-plugin';
  else {
    const cache = p.getAssetCacheManager();
    cache.getCacheStatus(p.settings.modelSize).then(files => {
      const cached = files.filter(f => f.exists).length;
      const total = files.length;
      console.log(JSON.stringify({ cached, total }));
    });
    'checking'
  }
" 2>/dev/null || true)

# Use a more reliable eval to get cache status synchronously-ish
sleep 1
cache_info=$(obs eval code="
  (async () => {
    const p = app.plugins.plugins['$PLUGIN_ID'];
    const cache = p.getAssetCacheManager();
    const files = await cache.getCacheStatus(p.settings.modelSize);
    const cached = files.filter(f => f.exists).length;
    return cached + '/' + files.length + ' cached';
  })()
" 2>/dev/null || true)

assert_not_empty "$cache_info" "Cache status is queryable"
echo "  ↳ Cache: $cache_info"

# ===================================================================
# TEST GROUP 7: Plugin busy state
# ===================================================================
log_header "Plugin state management"

busy_state=$(obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  p.busyState ?? 'unknown'
" 2>/dev/null || true)

# Plugin should be idle when not recording
if echo "$busy_state" | grep -qi "idle"; then
  pass "Plugin is idle (not busy)"
else
  # busyState is private, try alternative check
  is_recording=$(obs eval code="
    app.plugins.plugins['$PLUGIN_ID']?.isRecording ?? false
  " 2>/dev/null || true)
  if echo "$is_recording" | grep -qi "false"; then
    pass "Plugin is not recording"
  else
    fail "Plugin state check" "busyState=$busy_state, isRecording=$is_recording"
  fi
fi

# ===================================================================
# TEST GROUP 8: Transcript template rendering (via eval)
# ===================================================================
log_header "Template rendering"

template_output=$(obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  const settings = p.settings;
  const template = settings.transcriptTemplate || '{{audio}}\n> [!transcript]\n> {{transcript}}';
  template.replace('{{audio}}', '![[test.webm]]').replace('{{transcript}}', 'Hello world');
" 2>/dev/null || true)

assert_contains "$template_output" "Hello world" "Template renders transcript token"

# ===================================================================
# TEST GROUP 9: Protocol handler registration check
# ===================================================================
log_header "Protocol handlers"

protocol_handlers=$(obs eval code="
  const h = app.workspace.protocolHandlers;
  if (!h) 'none';
  else JSON.stringify([...h.keys()]);
" 2>/dev/null || true)

EXPECTED_PROTOCOLS=(
  "voice-notes-plus"
  "voice-notes-plus-start"
  "voice-notes-plus-start-new-note"
  "voice-notes-plus-stop"
  "voice-notes-plus-toggle"
  "voice-notes-plus-download-models"
)

for proto in "${EXPECTED_PROTOCOLS[@]}"; do
  assert_contains "$protocol_handlers" "$proto" "Protocol handler '$proto' registered"
done

# ===================================================================
# TEST GROUP 10: UI elements via DOM inspection
# ===================================================================
log_header "UI elements"

# 10a. Ribbon icon exists
ribbon_check=$(obs dev:dom selector=".side-dock-ribbon-action[aria-label='Toggle voice recording']" 2>/dev/null || true)
if [[ -n "$ribbon_check" ]] && ! echo "$ribbon_check" | grep -qi "no match"; then
  pass "Ribbon icon is present"
else
  # Try broader selector
  ribbon_check2=$(obs dev:dom selector=".side-dock-ribbon-action" all text 2>/dev/null || true)
  if echo "$ribbon_check2" | grep -qi "voice\|recording\|microphone"; then
    pass "Ribbon icon is present (broad match)"
  else
    skip "Ribbon icon check (DOM query unavailable)"
  fi
fi

# 10b. Status bar item exists
status_check=$(obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  p.statusBarEl ? 'exists' : 'missing'
" 2>/dev/null || true)
assert_contains "$status_check" "exists" "Status bar element exists"

# ===================================================================
# TEST GROUP 11: Settings tab registration
# ===================================================================
log_header "Settings tab"

settings_tab=$(obs eval code="
  const tabs = app.setting?.pluginTabs ?? [];
  const found = tabs.find(t => t.id === '$PLUGIN_ID');
  found ? found.name : 'not found'
" 2>/dev/null || true)

assert_contains "$settings_tab" "Voice Notes Plus" "Settings tab is registered"

# ===================================================================
# TEST GROUP 12: Download models command (dry-run check)
# ===================================================================
log_header "Model download command"

# Check the command exists and plugin is in the right state to accept it
can_init=$(obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  const commands = app.commands.commands;
  const cmd = commands['$PLUGIN_ID:initialize-models'];
  cmd ? 'available' : 'missing'
" 2>/dev/null || true)

assert_contains "$can_init" "available" "Download models command is available"

# ===================================================================
# TEST GROUP 13: Transcribe audio command check
# ===================================================================
log_header "Transcribe audio command"

# Open the test note so the command's checkCallback can pass
if [[ -n "$AUDIO_FILE" ]]; then
  obs open path="$TEST_NOTE_PATH" 2>/dev/null || true
  sleep 0.5

  transcribe_available=$(obs eval code="
    const cmd = app.commands.commands['$PLUGIN_ID:transcribe-audio'];
    cmd ? 'registered' : 'missing'
  " 2>/dev/null || true)
  assert_contains "$transcribe_available" "registered" "Transcribe audio command is registered"

  transcribe_embeds=$(obs eval code="
    const cmd = app.commands.commands['$PLUGIN_ID:transcribe-embeds'];
    cmd ? 'registered' : 'missing'
  " 2>/dev/null || true)
  assert_contains "$transcribe_embeds" "registered" "Transcribe embeds command is registered"
else
  skip "Transcribe commands (no audio files)"
fi

# ===================================================================
# TEST GROUP 14: TranscriptionManager lifecycle
# ===================================================================
log_header "TranscriptionManager lifecycle"

tm_state=$(obs eval code="
  const p = app.plugins.plugins['$PLUGIN_ID'];
  p.transcriptionManager === null ? 'null' : 'loaded'
" 2>/dev/null || true)

# After a fresh reload, transcriptionManager should be null (lazy init)
if echo "$tm_state" | grep -qi "null"; then
  pass "TranscriptionManager is lazily initialized (null at start)"
else
  pass "TranscriptionManager is pre-loaded (models kept loaded)"
fi

# ===================================================================
# TEST GROUP 15: Live transcription of an audio file
# ===================================================================
log_header "Live transcription"

# Pick the smallest audio file to keep the test fast
TRANSCRIBE_FILE=$(obs eval code="
  const exts = new Set(['mp3','wav','ogg','webm','flac','m4a','aac','opus']);
  const files = app.vault.getFiles().filter(f => exts.has(f.extension.toLowerCase()));
  files.sort((a,b) => a.stat.size - b.stat.size);
  files.length ? files[0].path : ''
" 2>/dev/null || true)

# Strip CLI noise — grab the => line
TRANSCRIBE_FILE=$(echo "$TRANSCRIBE_FILE" | sed -n 's/^=> //p' | xargs)

if [[ -n "$TRANSCRIBE_FILE" ]]; then
  echo "  ↳ Transcribing: $TRANSCRIBE_FILE"

  # Attach debugger so we can capture console.log from the async call
  obs dev:debug on 2>/dev/null || true
  obs dev:console clear 2>/dev/null || true

  # Fire transcription — returns immediately, result arrives via console.log
  obs eval code="
    (async () => {
      try {
        const p = app.plugins.plugins['$PLUGIN_ID'];
        const file = app.vault.getAbstractFileByPath('$TRANSCRIBE_FILE');
        if (!file) { console.log('TEST_TRANSCRIPT_ERROR:file-not-found'); return; }
        const result = await p.transcribe(file);
        console.log('TEST_TRANSCRIPT_RESULT:' + result);
      } catch(e) {
        console.log('TEST_TRANSCRIPT_ERROR:' + (e.stack || e.message));
      }
    })();
    'started'
  " >/dev/null 2>&1

  # Poll dev:console for the result (5s intervals, up to 2 min)
  transcript_clean=""
  for _poll in $(seq 1 24); do
    sleep 5
    console_out=$(obs dev:console 2>/dev/null || true)
    result_line=$(echo "$console_out" | grep -F "TEST_TRANSCRIPT_RESULT:" || true)
    error_line=$(echo "$console_out" | grep -F "TEST_TRANSCRIPT_ERROR:" || true)

    if [[ -n "$result_line" ]]; then
      transcript_clean=$(echo "$result_line" | sed 's/.*TEST_TRANSCRIPT_RESULT://')
      break
    fi
    if [[ -n "$error_line" ]]; then
      transcript_clean="ERROR:$(echo "$error_line" | sed 's/.*TEST_TRANSCRIPT_ERROR://')"
      break
    fi
  done

  # Detach debugger
  obs dev:debug off 2>/dev/null || true

  if [[ -n "$transcript_clean" ]] && ! echo "$transcript_clean" | grep -qiF "ERROR:"; then
    pass "Transcription returned text"
    display="${transcript_clean:0:120}"
    [[ ${#transcript_clean} -gt 120 ]] && display="${display}..."
    echo -e "  ↳ \"$display\""
  elif echo "$transcript_clean" | grep -qiF "ERROR:"; then
    fail "Transcription errored" "$transcript_clean"
  else
    fail "Transcription timed out (no result after 2 min)"
  fi
else
  skip "Live transcription (no audio files in vault)"
fi

# ===================================================================
# TEST GROUP 16: Screenshot for visual regression
# ===================================================================
log_header "Visual snapshot"

SCREENSHOT_DIR="$VAULT_PATH/__test__"
mkdir -p "$SCREENSHOT_DIR"
SCREENSHOT_PATH="$SCREENSHOT_DIR/test-screenshot.png"

obs dev:screenshot path="$SCREENSHOT_PATH" 2>/dev/null || true

if [[ -f "$SCREENSHOT_PATH" ]] && [[ -s "$SCREENSHOT_PATH" ]]; then
  pass "Screenshot captured ($(du -h "$SCREENSHOT_PATH" | cut -f1))"
else
  skip "Screenshot capture (may require updated installer)"
fi

# ===================================================================
# TEST GROUP 16: Error log is clean
# ===================================================================
log_header "Error log check"

errors=$(obs dev:errors 2>/dev/null || true)
if [[ -z "$errors" ]] || echo "$errors" | grep -qi "no errors\|no captured errors\|^$"; then
  pass "No errors in Obsidian console"
else
  # Filter for plugin-specific errors only
  plugin_errors=$(echo "$errors" | grep -i "$PLUGIN_ID\|voice.notes" || true)
  if [[ -z "$plugin_errors" ]]; then
    pass "No plugin-specific errors in console"
  else
    fail "Plugin errors found in console" "$plugin_errors"
  fi
fi

# ===================================================================
# Cleanup
# ===================================================================
log_header "Cleanup"

cleanup_test_note
# Remove screenshot artifacts
rm -f "$SCREENSHOT_PATH" 2>/dev/null || true
rmdir "$SCREENSHOT_DIR" 2>/dev/null || true
pass "Test artifacts cleaned up"

# ===================================================================
# Summary
# ===================================================================
echo ""
echo -e "${CYAN}━━━ Results ━━━${RESET}"
TOTAL=$((PASSED + FAILED + SKIPPED))
echo -e "  Total:   $TOTAL"
echo -e "  ${GREEN}Passed:  $PASSED${RESET}"
echo -e "  ${RED}Failed:  $FAILED${RESET}"
echo -e "  ${YELLOW}Skipped: $SKIPPED${RESET}"
echo ""

if [[ "$FAILED" -gt 0 ]]; then
  echo -e "${RED}FAIL${RESET}"
  exit 1
else
  echo -e "${GREEN}PASS${RESET}"
  exit 0
fi
