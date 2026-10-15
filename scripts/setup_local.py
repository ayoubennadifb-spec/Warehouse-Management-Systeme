"""Prepare a project-owned PostgreSQL 16 cluster on Windows (no global service)."""
import json
import os
from pathlib import Path
import secrets
import subprocess
import tempfile
import urllib.request
import zipfile

import psycopg
from psycopg import sql

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'
RUNTIME = ROOT / '.runtime'
BIN = RUNTIME / 'postgresql' / 'pgsql' / 'bin'
DATA = LOCAL / 'postgres'
SOURCE = 'https://sbp.enterprisedb.com/getfile.jsp?fileid=1260623'
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def run(*args, check=True):
    # pg_ctl's server inherits pipe handles on Windows; files avoid a wait on EOF.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run([str(x) for x in args], cwd=ROOT, stdout=output,
                                stderr=subprocess.STDOUT, creationflags=FLAGS, timeout=90)
        output.seek(0)
        result.stdout = output.read()
        result.stderr = b''
    if check and result.returncode:
        raise RuntimeError(f'{Path(args[0]).name} : code {result.returncode}. ' +
                           (result.stderr.decode('utf-8', errors='replace') or
                            result.stdout.decode('utf-8', errors='replace')))
    return result


def prepare():
    if os.name != 'nt':
        raise RuntimeError('Ce programme prépare Windows. Sur Linux, utilisez Docker Compose.')
    LOCAL.mkdir(exist_ok=True)
    RUNTIME.mkdir(exist_ok=True)
    config = LOCAL / 'db-admin.json'
    if not config.exists():
        if (ROOT / '.env').exists() or (DATA / 'PG_VERSION').exists():
            raise RuntimeError('Configuration existante : conservez-la et utilisez son PostgreSQL. Aucune modification effectuée.')
        settings = dict(user='portique_admin', password=secrets.token_urlsafe(32), port=5433,
                        app_password=secrets.token_urlsafe(32), test_password=secrets.token_urlsafe(32))
        with config.open('x', encoding='utf-8') as f:
            json.dump(settings, f)
    settings = json.loads(config.read_text(encoding='utf-8'))
    if not (BIN / 'pg_ctl.exe').exists():
        archive = RUNTIME / 'postgresql-windows.zip'
        if not archive.exists():
            print('Téléchargement PostgreSQL 16 depuis EnterpriseDB...', flush=True)
            pending = archive.with_suffix('.part')
            urllib.request.urlretrieve(SOURCE, pending)
            pending.replace(archive)
        with zipfile.ZipFile(archive) as z:
            target = (RUNTIME / 'postgresql').resolve()
            for entry in z.namelist():
                if not (target / entry).resolve().is_relative_to(target):
                    raise RuntimeError('Chemin inattendu dans l’archive PostgreSQL.')
            z.extractall(target)
    if not (DATA / 'PG_VERSION').exists():
        password_file = LOCAL / 'init-password.tmp'
        try:
            password_file.write_text(settings['password'], encoding='utf-8')
            run(BIN / 'initdb.exe', '-D', DATA, '-U', settings['user'],
                '--encoding=UTF8', '--locale=C', '--auth=scram-sha-256',
                '--pwfile=' + str(password_file))
        finally:
            password_file.unlink(missing_ok=True)
        with (DATA / 'postgresql.conf').open('a', encoding='utf-8') as f:
            f.write("\n# Portique Lab, accessible uniquement depuis ce PC.\nlisten_addresses = '127.0.0.1'\nport = 5433\n")
    if run(BIN / 'pg_ctl.exe', '-D', DATA, 'status', check=False).returncode:
        run(BIN / 'pg_ctl.exe', '-D', DATA, '-l', LOCAL / 'postgres.log', '-w', '-t', '30', 'start')
    with psycopg.connect(host='127.0.0.1', port=settings['port'], user=settings['user'],
                         password=settings['password'], dbname='postgres', autocommit=True) as db:
        for name, key in [('portique', 'app_password'), ('portique_test', 'test_password')]:
            if not db.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (name,)).fetchone():
                db.execute(sql.SQL('CREATE ROLE {} LOGIN PASSWORD {}').format(
                    sql.Identifier(name), sql.Literal(settings[key])))
            if not db.execute('SELECT 1 FROM pg_database WHERE datname=%s', (name,)).fetchone():
                db.execute(sql.SQL('CREATE DATABASE {} OWNER {}').format(sql.Identifier(name), sql.Identifier(name)))
        # Prevent the test role from connecting to the working database and vice versa.
        for name in ('portique', 'portique_test'):
            db.execute(sql.SQL('REVOKE CONNECT ON DATABASE {} FROM PUBLIC').format(sql.Identifier(name)))
            db.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(sql.Identifier(name), sql.Identifier(name)))
        print('PostgreSQL ' + db.execute('SHOW server_version').fetchone()[0])
    env = ROOT / '.env'
    expected = ('# Configuration locale Portique Lab — ne pas partager.\n'
                f'DATABASE_URL=postgresql://portique:{settings["app_password"]}@127.0.0.1:5433/portique\n'
                'APP_MODE=simulation\n')
    if not env.exists():
        env.write_text(expected, encoding='utf-8')
    elif env.read_text(encoding='utf-8') != expected:
        print('Votre fichier .env existant est conservé.')
    (LOCAL / 'test.env').write_text(
        f'TEST_DATABASE_URL=postgresql://portique_test:{settings["test_password"]}@127.0.0.1:5433/portique_test\n', encoding='utf-8')
    print('Bases application et tests prêtes. Identifiants conservés localement. Lancez demarrer.bat.')


if __name__ == '__main__':
    prepare()
