FX=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$FX"/lib.sh; mkdir -p ~/dev/eng-report/{bin,reports,logs}; cd ~/dev/eng-report
echo '{"date":"2026-11-23","status":"green","failed":[]}' > reports/nightly.json
cat > bin/check-nightly.sh <<'T'
#!/bin/bash
# prints one line when the nightly report has failures; silent when green. Appends the trigger it got to logs/triggers.log
cd "$(dirname "$0")/.."
echo "$(date +%T) ${NG_TRIGGER_FILE:+file:$NG_TRIGGER_FILE }${NG_TRIGGER_JSON:0:300}" >> logs/triggers.log
python3 - <<'P'
import json; r=json.load(open('reports/nightly.json'))
if r['status']!='green': print(f"夜间工程报告 {r['date']} 失败：{', '.join(r['failed'])}")
P
T
python3 - > logs/build.log <<'T'
for i in range(1,6001):
    print(f"2026-11-22 23:{i//60%60:02d}:{i%60:02d} INFO step {i} ok cache=hit shard={i%16}" if i!=4471 else "2026-11-22 23:14:31 ERROR E4471 linker: undefined symbol `frob_init` in module quasar-bridge")
T
printf '# eng-report\nNightly engineering report. `reports/nightly.json` is the latest result, `logs/build.log` the full build log.\n' > README.md; repo eng-report
