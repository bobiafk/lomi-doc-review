#!/usr/bin/env bash
# Chaos pass against the real Docker stack. Each scenario breaks something on
# purpose and then asserts, from Postgres, that nothing was lost, nothing was
# duplicated and nothing is stuck. Results are written up in docs/chaos.md.
#
# Usage (repo root, stack built):  bash scripts/chaos.sh [scenario...]
# Scenarios: kill restart flush flush-queued double scale supersede redis-down postgres-restart
#
# Runs the worker with the dev-only canned LLM and a 20 s artificial delay so
# there is time to break things mid-extraction. Needs bash, curl, docker, node.

set -uo pipefail
cd "$(dirname "$0")/.."

API="${API:-http://localhost:3001}"
export EXTRACTION_LLM=canned
export CANNED_DELAY_MS="${CANNED_DELAY_MS:-20000}"
FAILED=0

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
pass() { log "PASS  $*"; }
fail() { log "FAIL  $*"; FAILED=1; }
check() { local desc=$1; shift; if "$@"; then pass "$desc"; else fail "$desc"; fi; }

sql() { docker compose exec -T postgres psql -U lomi -d lomi -tAc "$1" | tr -d '\r'; }
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);console.log(eval(process.argv[1]))})' "$1"; }

upload_doc() { # type title file -> document id
  curl -sf -F "type=$1" -F "title=$2" -F "file=@fixtures/documents/$3" "$API/documents" | json 'o.document.id'
}
upload_version() { # doc file -> http code
  curl -s -o /dev/null -w '%{http_code}' -F "file=@fixtures/documents/$2" "$API/documents/$1/versions"
}
version_status() { sql "select v.status from documents d join document_versions v on v.id = d.current_version_id where d.id = '$1'"; }
status_of() { sql "select status from document_versions where document_id = '$1' and version_no = $2"; }
wait_for() { # doc versionNo status timeoutSeconds
  local i s
  for ((i = 0; i < $4; i++)); do
    s=$(status_of "$1" "$2")
    if [ "$s" = "$3" ]; then log "  $1 v$2 is $3 after ${i}s"; return 0; fi
    sleep 1
  done
  log "  timed out: $1 v$2 is '$s', wanted $3"
  return 1
}
runs_of() { sql "select string_agg(r.attempt || ':' || r.outcome, ',' order by r.started_at) from extraction_runs r join document_versions v on v.id = r.version_id where v.document_id = '$1' and v.version_no = ${2:-1}"; }
values_of() { sql "select count(*) from extracted_values x join document_versions v on v.id = x.version_id where v.document_id = '$1' and v.version_no = ${2:-1}"; }
duplicates() { sql "select count(*) from (select 1 from extracted_values group by version_id, field having count(*) > 1) d"; }
totals() { sql "select (select count(*) from extracted_values) || ' values, ' || (select count(*) from reviews) || ' reviews, ' || (select count(*) from extraction_runs) || ' runs'"; }
stack_up() { docker compose up -d --wait >/dev/null 2>&1 || docker compose up -d --wait; }

scenario_kill() {
  log "== kill: SIGKILL the worker mid-extraction, then start it again"
  local id; id=$(upload_doc lease "Chaos: worker killed" lease-excerpt-001.pdf)
  wait_for "$id" 1 extracting 30 || { fail "kill: never started extracting"; return; }
  docker compose kill worker >/dev/null 2>&1; log "  worker killed (SIGKILL)"
  sleep 3
  check "kill: version is still visibly 'extracting' (lease held by the dead worker)" [ "$(status_of "$id" 1)" = extracting ]
  docker compose up -d worker >/dev/null 2>&1; log "  worker started again"
  check "kill: completes after the lease expires (lease 60 s + reconcile 30 s)" wait_for "$id" 1 extracted 150
  check "kill: dead run logged as abandoned, retry succeeded ($(runs_of "$id"))" [ "$(runs_of "$id")" = "1:abandoned,2:succeeded" ]
  check "kill: exactly 5 values" [ "$(values_of "$id")" = 5 ]
}

scenario_restart() {
  log "== restart: docker compose restart (every service) mid-extraction"
  local id; id=$(upload_doc lease "Chaos: stack restarted" lease-excerpt-001.pdf)
  wait_for "$id" 1 extracting 30 || { fail "restart: never started extracting"; return; }
  docker compose restart >/dev/null 2>&1; log "  stack restarted"
  check "restart: completes" wait_for "$id" 1 extracted 150
  check "restart: one successful run, earlier attempt not lost ($(runs_of "$id"))" [ "$(runs_of "$id")" = "1:abandoned,2:succeeded" ]
  check "restart: exactly 5 values" [ "$(values_of "$id")" = 5 ]
}

scenario_flush() {
  log "== flush: Redis FLUSHALL mid-extraction, then restart the stack"
  local value
  value=$(sql "select x.id from extracted_values x join documents d on d.current_version_id = x.version_id where d.id = 'doc-invoice-001' order by x.field limit 1")
  [ -n "$value" ] && curl -s -o /dev/null -H 'content-type: application/json' -d '{"action":"approve","note":"before the flush"}' "$API/values/$value/review"
  local id; id=$(upload_doc lease "Chaos: redis flushed" lease-excerpt-001.pdf)
  wait_for "$id" 1 extracting 30 || { fail "flush: never started extracting"; return; }
  local before; before=$(totals); log "  before: $before"
  docker compose exec -T redis redis-cli FLUSHALL >/dev/null; log "  FLUSHALL done"
  docker compose restart >/dev/null 2>&1; log "  stack restarted"
  check "flush: in-flight version completes" wait_for "$id" 1 extracted 150
  local after; after=$(totals); log "  after:  $after"
  check "flush: no value, review or run lost (values/reviews/runs only grew)" node -e '
    const [b, a] = process.argv.slice(1).map((s) => s.match(/\d+/g).map(Number));
    process.exit(a.every((n, i) => n >= b[i]) ? 0 : 1)' "$before" "$after"
  check "flush: the review made before the flush is still there" [ "$(sql "select count(*) from reviews where note = 'before the flush'")" -ge 1 ]
}

scenario_flush_queued() {
  log "== flush-queued: job only in Redis (worker down), FLUSHALL, worker back"
  docker compose stop worker >/dev/null 2>&1
  local id; id=$(upload_doc invoice "Chaos: job flushed" invoice-001.pdf)
  check "flush-queued: job is in Redis before the flush" [ "$(docker compose exec -T redis redis-cli --scan --pattern 'bull:extraction:*' | grep -c .)" -gt 0 ]
  docker compose exec -T redis redis-cli FLUSHALL >/dev/null; log "  FLUSHALL done: the only job is gone"
  docker compose start worker >/dev/null 2>&1
  check "flush-queued: reconciler re-enqueues from Postgres and it completes" wait_for "$id" 1 extracted 60
}

scenario_double() {
  log "== double: the same new version uploaded twice at once, then again"
  local id; id=$(upload_doc invoice "Chaos: double upload" invoice-001.pdf)
  local a b tmp; tmp=$(mktemp -d)
  upload_version "$id" invoice-001.v2.pdf > "$tmp/a" & upload_version "$id" invoice-001.v2.pdf > "$tmp/b" & wait
  a=$(cat "$tmp/a"); b=$(cat "$tmp/b"); rm -rf "$tmp"
  check "double: concurrent uploads -> one 202 and one 200 duplicate (got $a, $b)" [ "$(printf '%s\n%s\n' "$a" "$b" | sort | tr '\n' ' ')" = "200 202 " ]
  check "double: third identical upload is a no-op (200)" [ "$(upload_version "$id" invoice-001.v2.pdf)" = 200 ]
  check "double: exactly 2 versions exist" [ "$(sql "select count(*) from document_versions where document_id = '$id'")" = 2 ]
  check "double: v2 completes" wait_for "$id" 2 extracted 60
  check "double: v2 extracted once ($(runs_of "$id" 2))" [ "$(runs_of "$id" 2)" = "1:succeeded" ]
}

scenario_scale() {
  log "== scale: two workers race for the same jobs"
  docker compose up -d --scale worker=2 --no-recreate worker >/dev/null 2>&1
  local ids=() i
  for i in 1 2 3; do ids+=("$(upload_doc market_report "Chaos: two workers $i" market-report-excerpt-001.pdf)"); done
  for i in "${ids[@]}"; do wait_for "$i" 1 extracted 90 || fail "scale: $i did not complete"; done
  for i in "${ids[@]}"; do check "scale: $i extracted once ($(runs_of "$i"))" [ "$(runs_of "$i")" = "1:succeeded" ]; done
  check "scale: no duplicated (version, field) anywhere" [ "$(duplicates)" = 0 ]
  docker compose up -d --scale worker=1 worker >/dev/null 2>&1
}

scenario_supersede() {
  log "== supersede: v2 uploaded while v1 is extracting"
  local id; id=$(upload_doc invoice "Chaos: v2 during v1" invoice-001.pdf)
  wait_for "$id" 1 extracting 30 || { fail "supersede: v1 never started"; return; }
  check "supersede: v2 accepted (202)" [ "$(upload_version "$id" invoice-001.v2.pdf)" = 202 ]
  check "supersede: v1 marked superseded at once" [ "$(status_of "$id" 1)" = superseded ]
  check "supersede: v2 completes" wait_for "$id" 2 extracted 90
  check "supersede: v1's run was discarded and logged ($(runs_of "$id" 1))" [ "$(runs_of "$id" 1)" = "1:superseded" ]
  check "supersede: v1 has no values, v2 has 5" [ "$(values_of "$id" 1)/$(values_of "$id" 2)" = "0/5" ]
  check "supersede: v1 stays queryable" [ "$(curl -s -o /dev/null -w '%{http_code}' "$API/documents/$id/versions/1")" = 200 ]
}

scenario_redis_down() {
  log "== redis-down: upload while Redis is stopped"
  docker compose stop redis >/dev/null 2>&1
  local start end id
  start=$(date +%s%N); id=$(upload_doc lease "Chaos: redis down" lease-excerpt-001.pdf); end=$(date +%s%N)
  check "redis-down: upload still answered, in $(((end - start) / 1000000)) ms" [ -n "$id" ]
  check "redis-down: version committed as queued" [ "$(status_of "$id" 1)" = queued ]
  docker compose start redis >/dev/null 2>&1
  check "redis-down: reconciler enqueues it once Redis is back; it completes" wait_for "$id" 1 extracted 120
}

scenario_postgres_restart() {
  log "== postgres-restart: Postgres restarted mid-extraction"
  local id; id=$(upload_doc lease "Chaos: postgres restarted" lease-excerpt-001.pdf)
  wait_for "$id" 1 extracting 30 || { fail "postgres-restart: never started"; return; }
  docker compose restart postgres >/dev/null 2>&1; log "  postgres restarted"
  check "postgres-restart: completes" wait_for "$id" 1 extracted 150
  check "postgres-restart: exactly 5 values ($(runs_of "$id"))" [ "$(values_of "$id")" = 5 ]
}

stack_up
log "stack up with EXTRACTION_LLM=$EXTRACTION_LLM CANNED_DELAY_MS=$CANNED_DELAY_MS; $(totals)"
SCENARIOS=("$@")
[ ${#SCENARIOS[@]} -eq 0 ] && SCENARIOS=(kill restart flush flush-queued double scale supersede redis-down postgres-restart)
for s in "${SCENARIOS[@]}"; do "scenario_${s//-/_}"; done
log "duplicate (version, field) rows in the whole database: $(duplicates)"
log "stuck versions (extracting with an expired lease): $(sql "select count(*) from document_versions where status = 'extracting' and lease_expires_at < now()")"
[ "$FAILED" = 0 ] && log "ALL PASSED" || log "SOME CHECKS FAILED"
exit "$FAILED"
