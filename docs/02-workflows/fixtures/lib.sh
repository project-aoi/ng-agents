set -e
cp "$FX"/forge.py ~/bin/forge; chmod +x ~/bin/forge
repo() { # repo <name>: publish ~/dev/<name> to a bare origin
  cd ~/dev/$1; git init -q; git add -A; git commit -qm "${2:-initial}"; git init -q --bare ~/remotes/$1.git; git -C ~/remotes/$1.git symbolic-ref HEAD refs/heads/main; git remote add origin ~/remotes/$1.git; git push -q -u origin main; }
