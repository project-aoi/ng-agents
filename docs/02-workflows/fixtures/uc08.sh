FX=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$FX"/lib.sh; mkdir -p ~/dev/http-client/{src,test}; cd ~/dev/http-client
printf 'MAX_RETRY = 1\ndef backoff(n): return 0.5\ndef request(send):\n    for n in range(MAX_RETRY + 1):\n        r = send()\n        if r < 500: return r\n    return r\n' > src/client.py
printf 'import sys,unittest;sys.path.insert(0,"src")\nimport client\nclass T(unittest.TestCase):\n    def test_ok(self): self.assertEqual(client.request(lambda: 200), 200)\n' > test/test_client.py
printf '# http-client\n`python3 -m unittest discover -s test -q`\n' > README.md; repo http-client
