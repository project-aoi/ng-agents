FX=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$FX"/lib.sh; mkdir -p ~/dev/gateway/src ~/dev/gateway/test; cd ~/dev/gateway
printf 'def handle(req):\n    return {"status": 200}\n' > src/server.py; printf '# gateway\nAPI gateway. `python3 -m unittest discover -s test -q`.\n' > README.md; repo gateway
git checkout -q -b feat/rate-limit; cat > src/limiter.py <<'T'
import time
class TokenBucket:
    def __init__(self, rate, burst):
        self.rate, self.burst = rate, burst
        self.tokens = 0
        self.last = time.time()
    def allow(self, n=1):
        now = time.time()
        self.tokens = self.tokens + (now - self.last) * self.rate
        self.last = now
        if self.tokens >= n:
            self.tokens -= n
            return True
        return False
BUCKETS = {}
def bucket_for(client):
    if client not in BUCKETS: BUCKETS[client] = TokenBucket(10, 20)
    return BUCKETS[client]
T
printf 'import sys,unittest;sys.path.insert(0,"src")\nfrom limiter import TokenBucket\nclass T(unittest.TestCase):\n    def test_denies_when_empty(self): self.assertFalse(TokenBucket(1,1).allow(5))\n' > test/test_limiter.py
git add -A; git commit -qm "feat: rate limit"; git push -q -u origin feat/rate-limit; forge mr create --branch feat/rate-limit --title "限流：每客户端令牌桶"; git checkout -q main
