#!/bin/bash

# Tool Guardian Hook
# Blocks dangerous tool operations (destructive file ops, force pushes, DB drops,
# etc.) before the Copilot coding agent executes them.
#
# Environment variables:
#   GUARD_MODE           - "warn" (log only) or "block" (exit non-zero on threats) (default: block)
#   SKIP_TOOL_GUARD      - "true" to disable entirely (default: unset)
#   TOOL_GUARD_LOG_DIR   - Directory for guard logs (default: logs/copilot/tool-guardian)
#   TOOL_GUARD_ALLOWLIST - Comma-separated patterns to skip (default: unset)

set -euo pipefail

# ---------------------------------------------------------------------------
# Early exit if disabled
# ---------------------------------------------------------------------------
if [[ "${SKIP_TOOL_GUARD:-}" == "true" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Read tool invocation from stdin (JSON with toolName + toolInput)
# ---------------------------------------------------------------------------
INPUT=$(cat)

MODE="${GUARD_MODE:-block}"
LOG_DIR="${TOOL_GUARD_LOG_DIR:-.github/logs/copilot/tool-guardian}"
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/guard.log"

# ---------------------------------------------------------------------------
# Extract tool name and input text
# ---------------------------------------------------------------------------
decode_unicode_ascii() {
  local s="$1" soh="$2" stx="$3" tab=$'\t'
  printf '%s\n' "$s" | sed \
    -e "s/\\\\u0009/${tab}/g" \
    -e "s/\\\\u0022/${stx}/g" \
    -e "s/\\\\u0027/'/g" \
    -e "s/\\\\u005[cC]/${soh}/g" \
    -e 's/\\u000[aAdD]/ /g; s/\\u0020/ /g; s/\\u0021/!/g; s/\\u0023/#/g; s/\\u0024/$/g; s/\\u0025/%/g; s/\\u0026/\&/g; s/\\u0028/(/g; s/\\u0029/)/g; s/\\u002[aA]/*/g; s/\\u002[bB]/+/g; s/\\u002[cC]/,/g; s/\\u002[dD]/-/g; s/\\u002[eE]/./g; s/\\u002[fF]/\//g' \
    -e 's/\\u0030/0/g; s/\\u0031/1/g; s/\\u0032/2/g; s/\\u0033/3/g; s/\\u0034/4/g; s/\\u0035/5/g; s/\\u0036/6/g; s/\\u0037/7/g; s/\\u0038/8/g; s/\\u0039/9/g; s/\\u003[aA]/:/g; s/\\u003[bB]/;/g; s/\\u003[cC]/</g; s/\\u003[dD]/=/g; s/\\u003[eE]/>/g; s/\\u003[fF]/?/g' \
    -e 's/\\u0040/@/g; s/\\u0041/A/g; s/\\u0042/B/g; s/\\u0043/C/g; s/\\u0044/D/g; s/\\u0045/E/g; s/\\u0046/F/g; s/\\u0047/G/g; s/\\u0048/H/g; s/\\u0049/I/g; s/\\u004[aA]/J/g; s/\\u004[bB]/K/g; s/\\u004[cC]/L/g; s/\\u004[dD]/M/g; s/\\u004[eE]/N/g; s/\\u004[fF]/O/g' \
    -e 's/\\u0050/P/g; s/\\u0051/Q/g; s/\\u0052/R/g; s/\\u0053/S/g; s/\\u0054/T/g; s/\\u0055/U/g; s/\\u0056/V/g; s/\\u0057/W/g; s/\\u0058/X/g; s/\\u0059/Y/g; s/\\u005[aA]/Z/g; s/\\u005[bB]/[/g; s/\\u005[dD]/]/g; s/\\u005[eE]/^/g; s/\\u005[fF]/_/g' \
    -e 's/\\u0060/`/g; s/\\u0061/a/g; s/\\u0062/b/g; s/\\u0063/c/g; s/\\u0064/d/g; s/\\u0065/e/g; s/\\u0066/f/g; s/\\u0067/g/g; s/\\u0068/h/g; s/\\u0069/i/g; s/\\u006[aA]/j/g; s/\\u006[bB]/k/g; s/\\u006[cC]/l/g; s/\\u006[dD]/m/g; s/\\u006[eE]/n/g; s/\\u006[fF]/o/g' \
    -e 's/\\u0070/p/g; s/\\u0071/q/g; s/\\u0072/r/g; s/\\u0073/s/g; s/\\u0074/t/g; s/\\u0075/u/g; s/\\u0076/v/g; s/\\u0077/w/g; s/\\u0078/x/g; s/\\u0079/y/g; s/\\u007[aA]/z/g; s/\\u007[bB]/{/g; s/\\u007[cC]/|/g; s/\\u007[dD]/}/g; s/\\u007[eE]/~/g'
}

extract_fallback_fields() {
  local soh=$'\001' stx=$'\002' etx=$'\003' tab=$'\t'
  local flat esc after_key start_ch rest_after_str

  flat=$(printf '%s' "$INPUT" | tr '\r\n\001\002\003' '     ')
  esc=$(printf '%s\n' "$flat" | sed "s/\\\\\\\\/${soh}/g; s/\\\\\"/${stx}/g")
  if [[ "$esc" == *'\u00'* ]]; then
    esc=$(decode_unicode_ascii "$esc" "$soh" "$stx")
  fi

  TOOL_NAME=$(printf '%s\n' "$esc" | grep -oE '"(toolName|tool_name)"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed -E 's/^"(toolName|tool_name)"[[:space:]]*:[[:space:]]*"//; s/"$//' || true)
  TOOL_NAME=$(printf '%s\n' "$TOOL_NAME" | sed -e "s/${stx}/\"/g" -e 's/\\\//\//g' -e "s/\\\\t/${tab}/g" -e 's/\\[rn]/ /g' -e "s/${soh}/\\\\/g")

  after_key=$(printf '%s\n' "$esc" | sed -E "s/\"(toolInput|tool_input)\"[[:space:]]*:[[:space:]]*/${etx}/" | tr '\003' '\n' | sed -n '2p')
  if [[ -z "$after_key" ]]; then
    TOOL_INPUT=""
    return
  fi

  start_ch="${after_key:0:1}"
  if [[ "$start_ch" == '"' ]]; then
    rest_after_str=$(printf '%s\n' "$after_key" | sed -E 's/^"[^"]*"//')
    if printf '%s\n' "$rest_after_str" | grep -qE '"(toolInput|tool_input)"[[:space:]]*:'; then
      TOOL_INPUT=$(printf '%s\n' "$after_key" | sed -E 's/[[:space:]]*\}[[:space:]]*$//')
    else
      TOOL_INPUT=$(printf '%s\n' "$after_key" | sed -E 's/^"([^"]*)".*/\1/; s/^"//')
    fi
  elif printf '%s\n' "$after_key" | grep -qE '^null([]}[:space:],]|$)' && ! printf '%s\n' "$after_key" | grep -qE '"(toolInput|tool_input)"[[:space:]]*:'; then
    TOOL_INPUT=""
    return
  else
    TOOL_INPUT=$(printf '%s\n' "$after_key" | sed -E 's/[[:space:]]*\}[[:space:]]*$//')
  fi

  TOOL_INPUT=$(printf '%s\n' "$TOOL_INPUT" | sed -e "s/${stx}/\"/g" -e 's/\\\//\//g' -e "s/\\\\t/${tab}/g" -e 's/\\[rn]/ /g' -e "s/${soh}/\\\\/g")
}

TOOL_NAME=""
TOOL_INPUT=""
PARSED_WITH_JQ=false

if command -v jq &>/dev/null && printf '%s' "$INPUT" | jq -e 'type == "object"' &>/dev/null; then
  PARSED_WITH_JQ=true
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '(.toolName // .tool_name // empty) | if type == "string" then . else tojson end' 2>/dev/null || echo "")
  TOOL_INPUT=$(printf '%s' "$INPUT" | jq -r 'if (.toolInput != null) then (.toolInput | if type == "string" then . else tojson end) elif (.tool_input != null) then (.tool_input | if type == "string" then . else tojson end) else empty end' 2>/dev/null || echo "")
fi

# Fallback: stream-extract without jq when jq is unavailable or stdin is not a JSON object
if [[ "$PARSED_WITH_JQ" != "true" ]]; then
  extract_fallback_fields
fi

# Combine for pattern matching
COMBINED="${TOOL_NAME} ${TOOL_INPUT}"

# ---------------------------------------------------------------------------
# Parse allowlist
# ---------------------------------------------------------------------------
ALLOWLIST=()
if [[ -n "${TOOL_GUARD_ALLOWLIST:-}" ]]; then
  IFS=',' read -ra ALLOWLIST <<< "$TOOL_GUARD_ALLOWLIST"
fi

is_allowlisted() {
  local text="$1"
  for pattern in "${ALLOWLIST[@]}"; do
    pattern=$(printf '%s' "$pattern" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [[ -z "$pattern" ]] && continue
    if [[ "$text" == *"$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

# Check allowlist early — if the combined text matches, skip all scanning
if [[ ${#ALLOWLIST[@]} -gt 0 ]] && is_allowlisted "$COMBINED"; then
  printf '{"timestamp":"%s","event":"guard_skipped","reason":"allowlisted","tool":"%s"}\n' \
    "$TIMESTAMP" "$TOOL_NAME" >> "$LOG_FILE"
  exit 0
fi

# ---------------------------------------------------------------------------
# Threat patterns (6 categories, ~20 patterns)
#
# Each entry: "CATEGORY:::SEVERITY:::REGEX:::SUGGESTION"
# Uses ::: as delimiter to avoid conflicts with regex pipe characters
# ---------------------------------------------------------------------------
PATTERNS=(
  # Destructive file operations
  "destructive_file_ops:::critical:::rm -rf /:::Use targeted 'rm' on specific paths instead of root"
  "destructive_file_ops:::critical:::rm -rf ~:::Use targeted 'rm' on specific paths instead of home directory"
  "destructive_file_ops:::critical:::rm -rf \.:::Use targeted 'rm' on specific files instead of current directory"
  "destructive_file_ops:::critical:::rm -rf \.\.:::Never remove parent directories recursively"
  "destructive_file_ops:::critical:::(rm|del|unlink).*\.env:::Use 'mv' to back up .env files before removing"
  "destructive_file_ops:::critical:::(rm|del|unlink).*\.git[^i]:::Never delete .git directory — use 'git' commands to manage repo state"

  # Destructive git operations
  "destructive_git_ops:::critical:::git push --force.*(main|master):::Use 'git push --force-with-lease' or push to a feature branch"
  "destructive_git_ops:::critical:::git push -f.*(main|master):::Use 'git push --force-with-lease' or push to a feature branch"
  "destructive_git_ops:::high:::git reset --hard:::Use 'git stash' to preserve changes, or 'git reset --soft'"
  "destructive_git_ops:::high:::git clean -fd:::Use 'git clean -n' (dry run) first to preview what will be deleted"

  # Database destruction
  "database_destruction:::critical:::DROP TABLE:::Use 'ALTER TABLE' or create a migration with rollback support"
  "database_destruction:::critical:::DROP DATABASE:::Create a backup first; consider revoking DROP privileges"
  "database_destruction:::critical:::TRUNCATE:::Use 'DELETE FROM ... WHERE' with a condition for safer data removal"
  "database_destruction:::high:::DELETE FROM [a-zA-Z_]+ *;:::Add a WHERE clause to 'DELETE FROM' to avoid deleting all rows"

  # Permission abuse
  "permission_abuse:::high:::chmod 777:::Use 'chmod 755' for directories or 'chmod 644' for files"
  "permission_abuse:::high:::chmod -R 777:::Use specific permissions ('chmod -R 755') and limit scope"

  # Network exfiltration
  "network_exfiltration:::critical:::curl.*\|.*bash:::Download the script first, review it, then execute"
  "network_exfiltration:::critical:::wget.*\|.*sh:::Download the script first, review it, then execute"
  "network_exfiltration:::high:::curl.*--data.*@:::Review what data is being sent before using 'curl --data @file'"

  # System danger
  "system_danger:::high:::sudo :::Avoid 'sudo' — run commands with the least privilege needed"
  "system_danger:::high:::npm publish:::Use 'npm publish --dry-run' first to verify package contents"
)

# ---------------------------------------------------------------------------
# Escape a string for safe JSON embedding
# ---------------------------------------------------------------------------
json_escape() {
  printf '%s' "$1" | tr '\r\n' '  ' | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g'
}

# ---------------------------------------------------------------------------
# Scan combined text against threat patterns
# ---------------------------------------------------------------------------
THREATS=()
THREAT_COUNT=0

for entry in "${PATTERNS[@]}"; do
  category="${entry%%:::*}"
  rest="${entry#*:::}"
  severity="${rest%%:::*}"
  rest="${rest#*:::}"
  regex="${rest%%:::*}"
  suggestion="${rest#*:::}"

  if printf '%s\n' "$COMBINED" | grep -qiE "$regex" 2>/dev/null; then
    local_match=$(printf '%s\n' "$COMBINED" | grep -oiE "$regex" 2>/dev/null | head -1)
    THREATS+=("${category}	${severity}	${local_match}	${suggestion}")
    THREAT_COUNT=$((THREAT_COUNT + 1))
  fi
done

# ---------------------------------------------------------------------------
# Output and logging
# ---------------------------------------------------------------------------
if [[ $THREAT_COUNT -gt 0 ]]; then
  echo ""
  echo "🛡️  Tool Guardian: $THREAT_COUNT threat(s) detected in '$TOOL_NAME' invocation"
  echo ""
  printf "  %-24s %-10s %-40s %s\n" "CATEGORY" "SEVERITY" "MATCH" "SUGGESTION"
  printf "  %-24s %-10s %-40s %s\n" "--------" "--------" "-----" "----------"

  # Build JSON findings array
  FINDINGS_JSON="["
  FIRST=true
  for threat in "${THREATS[@]}"; do
    IFS=$'\t' read -r category severity match suggestion <<< "$threat"

    # Truncate match for display
    display_match="$match"
    if [[ ${#match} -gt 38 ]]; then
      display_match="${match:0:35}..."
    fi
    printf "  %-24s %-10s %-40s %s\n" "$category" "$severity" "$display_match" "$suggestion"

    if [[ "$FIRST" != "true" ]]; then
      FINDINGS_JSON+=","
    fi
    FIRST=false
    FINDINGS_JSON+="{\"category\":\"$(json_escape "$category")\",\"severity\":\"$(json_escape "$severity")\",\"match\":\"$(json_escape "$match")\",\"suggestion\":\"$(json_escape "$suggestion")\"}"
  done
  FINDINGS_JSON+="]"

  echo ""

  # Write structured log entry
  printf '{"timestamp":"%s","event":"threats_detected","mode":"%s","tool":"%s","threat_count":%d,"threats":%s}\n' \
    "$TIMESTAMP" "$MODE" "$(json_escape "$TOOL_NAME")" "$THREAT_COUNT" "$FINDINGS_JSON" >> "$LOG_FILE"

  if [[ "$MODE" == "block" ]]; then
    echo "🚫 Operation blocked: resolve the threats above or adjust TOOL_GUARD_ALLOWLIST."
    echo "   Set GUARD_MODE=warn to log without blocking."
    exit 1
  else
    echo "⚠️  Threats logged in warn mode. Set GUARD_MODE=block to prevent dangerous operations."
  fi
else
  # Log clean result
  printf '{"timestamp":"%s","event":"guard_passed","mode":"%s","tool":"%s"}\n' \
    "$TIMESTAMP" "$MODE" "$(json_escape "$TOOL_NAME")" >> "$LOG_FILE"
fi

exit 0
