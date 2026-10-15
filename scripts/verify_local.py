"""Run checks only against the separate, locally provisioned test database."""
import os
from pathlib import Path
import subprocess
import sys
from urllib.parse import urlsplit

ROOT=Path(__file__).resolve().parents[1]
settings=dict(line.split('=',1) for line in (ROOT/'.local/test.env').read_text(encoding='utf-8').splitlines() if '=' in line)
url=settings['TEST_DATABASE_URL']
parsed=urlsplit(url)
if parsed.hostname!='127.0.0.1' or parsed.port!=5433 or parsed.path!='/portique_test':
    raise SystemExit('Les vérifications exigent la base dédiée portique_test sur le port local 5433.')
env=dict(os.environ,TEST_DATABASE_URL=url,DATABASE_URL=url,APP_MODE='simulation',PYTHONUTF8='1')
subprocess.run([sys.executable,'-m','unittest','discover','-s','tests','-v'],cwd=ROOT,env=env,check=True)
subprocess.run([sys.executable,'-m','tests.api_check'],cwd=ROOT,env=env,check=True)
subprocess.run(['node','--test',*map(str,sorted((ROOT/'tests').glob('*.test.mjs')))],cwd=ROOT,env=env,check=True)
print('Tous les contrôles ont réussi. La base de travail n’a pas été utilisée pour les tests.')
