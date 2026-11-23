#!/usr/bin/env python3
"""forge: a local stand-in for a code forge (MR + CI). State in ~/.forge/<repo>.json; the remote is a bare repository.
  forge mr create --branch B --title T     forge mr view N [--json]     forge mr list
  forge ci status N [--json] [--exit-status]      (exit 0 passed, 1 not yet/failed)
  forge mr merge N      (the reviewer does this)
CI: first run fails in job `lint` (known flaky) ~40s after creation, a re-run starts by itself and passes ~110s later."""
import json,os,sys,subprocess,time,argparse
def sh(*a): return subprocess.run(a,capture_output=True,text=True)
root=sh('git','rev-parse','--show-toplevel').stdout.strip()
name=os.path.basename(sh('git','remote','get-url','origin').stdout.strip()).replace('.git','') if root else ''
if not name: sys.exit('forge: run it inside a repository that has an origin')
F=os.path.expanduser(f'~/.forge/{name}.json'); os.makedirs(os.path.dirname(F),exist_ok=True)
db=json.load(open(F)) if os.path.exists(F) else {'mrs':[]}
def save(): json.dump(db,open(F,'w'),indent=1,ensure_ascii=False)
def ci(m):
    t=time.time()-m['created']
    if m.get('merged'): return {'state':'passed','jobs':{'test':'passed','lint':'passed'}}
    if t<40: return {'state':'running','attempt':1,'jobs':{'test':'running','lint':'running'}}
    if t<150: return {'state':'running','attempt':2,'jobs':{'test':'passed','lint':'running'},'previous_attempt':{'state':'failed','jobs':{'lint':'failed (runner timeout, known flaky)'}}}
    return {'state':'passed','attempt':2,'jobs':{'test':'passed','lint':'passed'}}
def get(n):
    for m in db['mrs']:
        if m['id']==int(n): return m
    sys.exit(f'forge: no MR !{n}')
a=sys.argv[1:]; J='--json' in a; X='--exit-status' in a; a=[x for x in a if x not in('--json','--exit-status')]
if a[:2]==['mr','create']:
    p=argparse.ArgumentParser(); p.add_argument('--branch',required=True); p.add_argument('--title',required=True); p.add_argument('--description',default=''); o=p.parse_args(a[2:])
    if not sh('git','ls-remote','--heads','origin',o.branch).stdout.strip(): sys.exit(f'forge: branch {o.branch} is not on origin, push it first')
    m={'id':len(db['mrs'])+1,'branch':o.branch,'target':'main','title':o.title,'created':time.time(),'merged':None}; db['mrs'].append(m); save(); print(f"!{m['id']} http://forge.local/{name}/-/merge_requests/{m['id']}")
elif a[:2]==['mr','view']:
    m=get(a[2]); r={**m,'state':'merged' if m['merged'] else 'open','ci':ci(m)}; print(json.dumps(r,ensure_ascii=False,indent=1))
elif a[:2]==['mr','list']: print('\n'.join(f"!{m['id']} {m['branch']} {'merged' if m['merged'] else 'open'} {m['title']}" for m in db['mrs']))
elif a[:2]==['ci','status']:
    c=ci(get(a[2])); print(json.dumps(c,ensure_ascii=False,indent=1)); sys.exit(0 if not X or c['state']=='passed' else 1)
elif a[:2]==['mr','merge']:
    m=get(a[2]); u=sh('git','remote','get-url','origin').stdout.strip(); t=f'/tmp/merge-{os.getpid()}'
    for c in(['git','clone','-q',u,t],['git','-C',t,'merge','--no-ff','-q','-m',f"Merge !{m['id']}",f"origin/{m['branch']}"],['git','-C',t,'push','-q','origin','main']):
        r=sh(*c)
        if r.returncode: sys.exit('forge: '+r.stderr)
    m['merged']=time.strftime('%F %T'); save(); print('merged')
else: sys.exit(__doc__)
