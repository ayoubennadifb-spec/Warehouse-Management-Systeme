"""Prepare the adopted app on the project PostgreSQL instance without replacing data."""
from pathlib import Path
import json,os,secrets,shutil,subprocess
from urllib.parse import quote,urlsplit
import psycopg
from psycopg import sql
root=Path(__file__).resolve().parents[1];folder=root/'projet_portique_ contenaire_claude';envfile=folder/'.env'
admin=json.loads((root/'.local/db-admin.json').read_text(encoding='utf-8'))
if not envfile.exists():
 password=secrets.token_urlsafe(24)
 with psycopg.connect(host='127.0.0.1',port=admin['port'],user=admin['user'],password=admin['password'],dbname='postgres',autocommit=True,connect_timeout=5) as db:
  if db.execute("SELECT 1 FROM pg_roles WHERE rolname='portique_claude'").fetchone():raise SystemExit('Rôle Claude existant : restaurez son .env avant de poursuivre.')
  db.execute(sql.SQL('CREATE ROLE portique_claude LOGIN PASSWORD {}').format(sql.Literal(password)))
  for name in ('portique_claude','portique_claude_test'):db.execute(sql.SQL('CREATE DATABASE {} OWNER portique_claude').format(sql.Identifier(name)))
 base=f'postgresql://portique_claude:{quote(password)}@127.0.0.1:{admin["port"]}/'
 envfile.write_text('DATABASE_URL='+base+'portique_claude\nDATABASE_URL_TEST='+base+'portique_claude_test\nPORT=8080\nHOST=127.0.0.1\nSOURCE_EVENEMENTS=SIMULATION\n',encoding='utf-8')
npm=shutil.which('npm.cmd') or shutil.which('npm');node=shutil.which('node')
if not npm or not node:raise SystemExit('Installez Node.js >=22.18 puis relancez installer.bat.')
if not (folder/'node_modules').exists():subprocess.run([npm,'ci'],cwd=folder,check=True)
for command in ([npm,'run','build'],[node,'scripts/migrer.ts'],[node,'scripts/seed-demo.ts']):subprocess.run(command,cwd=folder,check=True)
print('Version principale Claude prête. Données existantes conservées.')
