FX=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$FX"/lib.sh; mkdir -p ~/dev/log-tool/{src,test,scripts}; cd ~/dev/log-tool
printf 'import re\nLINE = re.compile(r"^(\\S+) (\\w+) (.*)$")\ndef parse(line):\n    m = LINE.match(line)\n    return {"ts": m[1], "level": m[2], "msg": m[3]} if m else None\n' > src/parse.py
printf 'import sys,unittest;sys.path.insert(0,"src")\nfrom parse import parse\nclass T(unittest.TestCase):\n    def test_basic(self): self.assertEqual(parse("t INFO hi")["level"], "INFO")\n' > test/test_parse.py
cat > scripts/soak.sh <<'T'
#!/bin/bash
# long soak check (~4 minutes). Writes progress to soak.out in the current directory
echo "soak start $$ $(date +%T)" >> soak.out
for i in $(seq 48); do sleep 5; echo "tick $i $(date +%T)" >> soak.out; done
python3 -m unittest discover -s test -q 2>&1 | tail -1 >> soak.out; echo "soak done $(date +%T)" >> soak.out; tail -2 soak.out
T
printf 'soak.out\n' > .gitignore; printf '# log-tool\nLog parser. Unit tests: `python3 -m unittest discover -s test -q`. Before handing over a change run the soak check `bash scripts/soak.sh` (about 4 minutes, run it in the background).\n' > README.md; repo log-tool
