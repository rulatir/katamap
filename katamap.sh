#!/usr/bin/env bash
# katamap.sh — katana JSONL collector: write "documents" by response Content-Type (HTML/PDF/Office/etc).
# Prints each requested URL immediately; writes matching "document" URLs to -o; Ctrl+C kills everything.
set -Eeuo pipefail

out_file=""
concurrency=20
depth=""          # default: unlimited
retries=2
timeout_s=10
stderr_log="katamap.stderr.log"
raw_file=""

usage() {
  cat <<'EOF'
katamap.sh -o <output_file> [options] <start_url>

Required:
  -o <file>    output file for unique URLs whose response Content-Type indicates a document:
               HTML/PDF/Office/ODF/RTF/TXT/CSV.

Optional:
  -c <n>       katana concurrency (default: 20)
  -d <n>       depth (default: unlimited)
  -r <n>       katana retries (default: 2)
  -t <sec>     katana timeout seconds (default: 10)
  -R <file>    save raw katana JSONL to this file (optional)

Behavior:
  - Prints each REQUESTED URL immediately to STDOUT (from .request.endpoint)
  - Writes URLs whose RESPONSE Content-Type matches document types to -o
  - Prints progress to STDERR every 2s
  - Ctrl+C kills everything (entire process group)
EOF
}

while getopts ":o:c:d:r:t:R:h" opt; do
  case "$opt" in
    o) out_file="$OPTARG" ;;
    c) concurrency="$OPTARG" ;;
    d) depth="$OPTARG" ;;
    r) retries="$OPTARG" ;;
    t) timeout_s="$OPTARG" ;;
    R) raw_file="$OPTARG" ;;
    h) usage; exit 0 ;;
    \?) echo "Unknown option: -$OPTARG" >&2; usage; exit 2 ;;
    :)  echo "Option -$OPTARG requires an argument." >&2; usage; exit 2 ;;
  esac
done
shift $((OPTIND-1))

[[ -n "$out_file" ]] || { echo "Error: -o is required" >&2; usage; exit 2; }
[[ $# -eq 1 ]] || { echo "Error: <start_url> required" >&2; usage; exit 2; }
start_url="$1"

command -v katana >/dev/null 2>&1 || { echo "Error: katana not found in PATH." >&2; exit 127; }
command -v jq >/dev/null 2>&1 || { echo "Error: jq not found in PATH." >&2; exit 127; }

: >"$out_file"
: >"$stderr_log"

tmpdir="$(mktemp -d)"
req_count_file="$tmpdir/req.count"
doc_count_file="$tmpdir/doc.count"
last_event_file="$tmpdir/last_event.epoch"
echo 0 >"$req_count_file"
echo 0 >"$doc_count_file"
date +%s >"$last_event_file"

inc() { local f="$1"; echo $(( $(cat "$f" 2>/dev/null || echo 0) + 1 )) >"$f" 2>/dev/null || true; }
touch_event() { date +%s >"$last_event_file" 2>/dev/null || true; }

# jq: from katana JSONL lines -> emit:
#   REQ <url>
#   DOC <url>     (when response Content-Type is a "document" type)
#
# IMPORTANT: guard against null/non-string endpoints (prevents "cannot be matched" errors).
read -r -d '' jq_prog <<'JQ' || true
def ct_norm: (tostring | ascii_downcase | split(";")[0] | gsub("[ \t]";""));
def is_doc_ct($ct):
  ($ct | ct_norm) as $c
  | (
      # HTML pages
      ($c == "text/html") or
      # PDF
      ($c == "application/pdf") or
      # Plain-text / CSV / RTF
      ($c == "text/plain") or
      ($c == "text/csv") or
      ($c == "application/rtf") or
      ($c == "text/rtf") or
      # MS Office legacy
      ($c == "application/msword") or
      ($c == "application/vnd.ms-word") or
      ($c == "application/vnd.ms-excel") or
      ($c == "application/vnd.ms-powerpoint") or
      # OOXML (docx/xlsx/pptx)
      ($c | startswith("application/vnd.openxmlformats-officedocument.")) or
      # ODF (odt/ods/odp)
      ($c | startswith("application/vnd.oasis.opendocument."))
    );

(try fromjson catch empty) as $o
| select($o|type) == "object"?
| ($o.request.endpoint // empty) as $u
| ($o.response.headers["Content-Type"] // $o.response.headers["content-type"] // "") as $ct
# Only run string-specific tests when $u is actually a string to avoid "null cannot be matched" errors.
| if ($u|type) == "string" then
    if ($u | test("^https?://")) then
      "REQ\t" + $u,
      (if is_doc_ct($ct) then "DOC\t" + $u else empty end)
    else
      empty
    end
  else
    empty
  end
JQ

katana_cmd=(
  katana
  -u "$start_url"
  -j
  -silent
  -c "$concurrency"
  -retry "$retries"
  -timeout "$timeout_s"
  -cs '^https?://'
  -fs rdn
)
[[ -n "${depth:-}" ]] && katana_cmd+=(-d "$depth")

progress_pid=""
pgid=""
cleanup_done=0
pipeline_leader_pid=""

cleanup() {
  ((cleanup_done)) && return 0
  cleanup_done=1

  if [[ -n "${progress_pid:-}" ]] && kill -0 "$progress_pid" 2>/dev/null; then
    kill "$progress_pid" 2>/dev/null || true
    wait "$progress_pid" 2>/dev/null || true
  fi

  if [[ -n "${pgid:-}" ]]; then
    kill -INT  -- "-$pgid" 2>/dev/null || true
    sleep 0.2
    kill -TERM -- "-$pgid" 2>/dev/null || true
    sleep 0.2
    kill -KILL -- "-$pgid" 2>/dev/null || true
  fi

  [[ -f "$out_file" ]] && sort -u -o "$out_file" "$out_file" 2>/dev/null || true
  rm -rf "$tmpdir" 2>/dev/null || true
}

on_int() { echo "[interrupt] stopping..." >&2; cleanup; exit 130; }
trap on_int INT
trap cleanup EXIT

progress() {
  while true; do
    local r d last now idle
    r="$(cat "$req_count_file" 2>/dev/null || echo 0)"
    d="$(cat "$doc_count_file" 2>/dev/null || echo 0)"
    last="$(cat "$last_event_file" 2>/dev/null || date +%s)"
    now="$(date +%s)"
    idle=$((now - last))
    printf "[progress] requested=%s documents=%s idle=%ss output=%s (katana stderr: %s)\n" \
      "$r" "$d" "$idle" "$out_file" "$stderr_log" >&2
    sleep 2
  done
}

run_stream() {
  if [[ -n "$raw_file" ]]; then
    "${katana_cmd[@]}" 2> >(tee -a "$stderr_log" >&2) | tee "$raw_file"
  else
    "${katana_cmd[@]}" 2> >(tee -a "$stderr_log" >&2)
  fi
}

progress & progress_pid=$!

# Ensure background pipeline is its own process group; then Ctrl+C can kill -PGID.
set -m
(
  set -Eeuo pipefail
  run_stream \
  | jq -Rr "$jq_prog" \
  | while IFS=$'\t' read -r tag url; do
      [[ -n "${tag:-}" && -n "${url:-}" ]] || continue
      touch_event
      case "$tag" in
        REQ)
          printf '%s\n' "$url"
          inc "$req_count_file"
          ;;
        DOC)
          printf '%s\n' "$url" >>"$out_file"
          inc "$doc_count_file"
          ;;
      esac
    done
) &
pipeline_leader_pid=$!

pgid="$(ps -o pgid= "$pipeline_leader_pid" | tr -d '[:space:]')"
[[ -n "$pgid" ]] || pgid="$pipeline_leader_pid"

wait "$pipeline_leader_pid" 2>/dev/null || true

sort -u -o "$out_file" "$out_file" 2>/dev/null || true
echo "[done] output=$out_file (katana stderr: $stderr_log)" >&2