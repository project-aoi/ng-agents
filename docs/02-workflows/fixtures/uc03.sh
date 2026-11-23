FX=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$FX"/lib.sh; mk() { mkdir -p $1/src; }
A=~/dev/harness-a; mk $A; cat > $A/src/retry.py <<'T'
import time, random
MAX_ATTEMPTS = 5
def with_retry(call, is_transient):
    """Exponential backoff with full jitter; only transient errors are retried."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try: return call()
        except Exception as e:
            if attempt == MAX_ATTEMPTS or not is_transient(e): raise
            time.sleep(random.uniform(0, min(30, 2 ** attempt)))
T
cat > $A/src/permissions.py <<'T'
DENY, ASK, ALLOW = "deny", "ask", "allow"
def decide(tool, args, rules, mode):
    """First matching rule wins: deny > ask > allow. Read-only tools default to allow, the rest to ask."""
    for verdict in (DENY, ASK, ALLOW):
        if any(r.matches(tool, args) for r in rules.get(verdict, [])): return verdict
    if mode == "plan" and tool.writes: return DENY
    return ALLOW if not tool.writes else ASK
T
cat > $A/src/context.py <<'T'
COMPACT_AT = 0.85
def maybe_compact(history, window, summarize):
    """Summarise everything but the last 12 turns once 85% of the window is used."""
    if tokens(history) < COMPACT_AT * window: return history
    head, tail = history[:-12], history[-12:]
    return [summarize(head)] + tail
def tokens(h): return sum(len(m) // 4 for m in h)
T
printf '# harness-a\nAgent harness A: retry, permissions, context compaction.\n' > $A/README.md; repo harness-a
B=$(mktemp -d)/harness-b; mkdir -p $B/src; cat > $B/src/retry.go <<'T'
package harness
// Retry: fixed 3 attempts, linear 2s backoff, every error is retried including permanent ones.
const MaxAttempts = 3
func Retry(call func() error) error { var err error; for i := 0; i < MaxAttempts; i++ { if err = call(); err == nil { return nil }; sleep(2 * (i + 1)) }; return err }
T
cat > $B/src/policy.go <<'T'
package harness
// Policy: allowlist only. Anything not on the list is refused; there is no "ask" state.
func Allowed(tool string, list []string) bool { for _, t := range list { if t == tool { return true } }; return false }
T
cat > $B/src/window.go <<'T'
package harness
// Window: drops the oldest turns when full; no summary is kept.
func Trim(h []string, max int) []string { if len(h) > max { return h[len(h)-max:] }; return h }
T
printf '# harness-b\nAgent harness B (Go).\n' > $B/README.md; mkdir -p ~/dropbox && cp -r $B ~/dropbox/harness-b
