"""Manage only this project's Windows processes; preserve PostgreSQL data."""
import argparse
from contextlib import contextmanager
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
import uuid
import webbrowser

ROOT = Path(__file__).resolve().parents[1]
LOCAL = ROOT / '.local'
PID_FILE = LOCAL / 'app.pid'
PG = ROOT / '.runtime/postgresql/pgsql/bin/pg_ctl.exe'
DATA = LOCAL / 'postgres'
URL = 'http://127.0.0.1:8080'
FLAGS = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0


def process_stamp(pid):
    """Creation time distinguishes our process from a reused Windows PID."""
    if os.name != 'nt':
        raise RuntimeError('Ce lanceur est prévu pour Windows. Utilisez Docker sur les autres systèmes.')
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.OpenProcess(0x1000, False, int(pid))
    if not handle:
        return None
    try:
        created, exited, system, user = (wintypes.FILETIME() for _ in range(4))
        if not kernel.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(system), ctypes.byref(user)):
            return None
        if exited.dwHighDateTime or exited.dwLowDateTime:
            return None
        return (created.dwHighDateTime << 32) | created.dwLowDateTime
    finally:
        kernel.CloseHandle(handle)


def record():
    try:
        value = json.loads(PID_FILE.read_text(encoding='utf-8'))
        uuid.UUID(value['instance'])
        return value if process_stamp(value['pid']) == value['created'] else None
    except (OSError, ValueError, KeyError, TypeError):
        return None


def health():
    try:
        with urllib.request.urlopen(URL + '/api/health', timeout=2) as response:
            return json.load(response)
    except (OSError, ValueError):
        return {}


def pg_command(*args, check=True):
    if (LOCAL / 'postgres-wsl.ready').exists():
        action = str(args[-1])
        if action not in ('start', 'stop', 'status'):
            raise RuntimeError('Action PostgreSQL WSL inconnue.')
        command = ['wsl.exe', '-d', 'Ubuntu-24.04', '-u', 'root', '--',
                   'pg_ctlcluster', '16', 'main', action]
        result = subprocess.run(command, cwd=ROOT, capture_output=True,
                                creationflags=FLAGS, timeout=60)
        if check and result.returncode:
            raise RuntimeError(result.stdout.decode('utf-8', errors='replace') +
                               result.stderr.decode('utf-8', errors='replace'))
        return result.returncode
    # File handles avoid pg_ctl descendants retaining a subprocess output pipe.
    with tempfile.TemporaryFile() as output:
        result = subprocess.run([str(PG), '-D', str(DATA), *map(str, args)], cwd=ROOT,
                                stdout=output, stderr=subprocess.STDOUT, creationflags=FLAGS, timeout=45)
        output.seek(0)
        message = output.read().decode('utf-8', errors='replace')
    if check and result.returncode:
        raise RuntimeError(message or f'PostgreSQL : code {result.returncode}.')
    return result.returncode


@contextmanager
def runtime_lock():
    import msvcrt
    LOCAL.mkdir(exist_ok=True)
    with (LOCAL / 'runtime.lock').open('a+b') as lock:
        if lock.tell() == 0:
            lock.write(b'0')
            lock.flush()
        lock.seek(0)
        try:
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        except OSError as exc:
            raise RuntimeError('Un démarrage ou un arrêt est déjà en cours.') from exc
        try:
            yield
        finally:
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)


def start(no_browser=False):
    current = record()
    if current:
        info = health()
        if info.get('app') == 'portique-lab' and info.get('instance') == current['instance']:
            print('Portique Lab est déjà lancé : ' + URL)
            if not no_browser:
                webbrowser.open(URL)
            return
        raise RuntimeError('Le serveur existe mais ne répond pas. Consultez .local/app.log ou utilisez arreter.bat.')
    if not PG.exists() or not (DATA / 'PG_VERSION').exists() or not (ROOT / '.env').exists():
        raise RuntimeError('Installation locale manquante : lancez installer.bat une première fois.')
    with socket.socket() as check:
        if check.connect_ex(('127.0.0.1', 8080)) == 0:
            raise RuntimeError('Le port 8080 est déjà occupé par un autre serveur. Arrêtez-le avant de relancer.')
    if pg_command('status', check=False):
        pg_command('-l', LOCAL / 'postgres.log', '-w', '-t', '30', 'start')
    instance = str(uuid.uuid4())
    env = dict(os.environ, PORTIQUE_INSTANCE_ID=instance, PYTHONUTF8='1', PYTHONUNBUFFERED='1')
    with (LOCAL / 'app.log').open('ab') as log:
        process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'serve'], cwd=ROOT, env=env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log, creationflags=FLAGS, close_fds=True)
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        info = health()
        if info.get('app') == 'portique-lab' and info.get('instance') == instance:
            print('Portique Lab lancé avec PostgreSQL : ' + URL)
            if not no_browser:
                webbrowser.open(URL)
            return
        if process.poll() is not None:
            break
        time.sleep(.25)
    (LOCAL / ('stop-' + instance)).touch()
    raise RuntimeError('Le serveur n’a pas démarré. Consultez .local/app.log. PostgreSQL reste disponible.')


def stop():
    current = record()
    if current:
        (LOCAL / ('stop-' + current['instance'])).touch()
        deadline = time.monotonic() + 20
        while process_stamp(current['pid']) == current['created']:
            if time.monotonic() > deadline:
                raise RuntimeError('Le serveur termine encore une opération ; PostgreSQL reste actif. Réessayez dans quelques secondes.')
            time.sleep(.2)
    if PG.exists() and (DATA / 'PG_VERSION').exists() and not pg_command('status', check=False):
        pg_command('-m', 'fast', '-w', '-t', '20', 'stop')
    print('Portique Lab arrêté. Les données PostgreSQL sont conservées.')


def serve():
    """Hidden wrapper; instance-specific stop file requests graceful shutdown."""
    sys.path.insert(0, str(ROOT))
    import uvicorn
    instance = os.environ['PORTIQUE_INSTANCE_ID']
    stop_file = LOCAL / ('stop-' + instance)
    temporary = PID_FILE.with_suffix('.tmp')
    temporary.write_text(json.dumps(dict(pid=os.getpid(), created=process_stamp(os.getpid()), instance=instance)), encoding='utf-8')
    temporary.replace(PID_FILE)
    import shutil
    folder=ROOT/'projet_portique_ contenaire_claude'
    node=shutil.which('node')
    if not node:raise RuntimeError('Node.js est nécessaire pour la version Claude.')
    env=dict(os.environ,PORTIQUE_STOP_FILE=str(stop_file),PLANNER_PYTHON=sys.executable)
    # Systemd services alone do not keep a WSL distribution alive.
    wsl_keepalive = None
    if (LOCAL / 'postgres-wsl.ready').exists():
        wsl_keepalive = subprocess.Popen(
            ['wsl.exe', '-d', 'Ubuntu-24.04', '-u', 'root', '--', 'sleep', 'infinity'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=FLAGS)
    # The native Claude server handles graceful SSE/database shutdown.
    process=subprocess.Popen([node,'src/server/index.ts'],cwd=folder,env=env,creationflags=FLAGS,stdout=sys.stdout,stderr=sys.stderr)
    try:
        process.wait()
        if process.returncode:raise RuntimeError('Le serveur Claude a quitté avec une erreur. Consultez .local/app.log.')
    finally:
        if wsl_keepalive is not None:
            wsl_keepalive.terminate()
            try:
                wsl_keepalive.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        stop_file.unlink(missing_ok=True)
        try:
            if json.loads(PID_FILE.read_text(encoding='utf-8'))['instance']==instance:PID_FILE.unlink(missing_ok=True)
        except (OSError,ValueError,KeyError):pass



def main():
    parser = argparse.ArgumentParser(description='Portique Lab : démarrage et arrêt locaux')
    parser.add_argument('action', choices=('start', 'stop', 'status', 'serve'))
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    if args.action == 'serve':
        serve()
        return
    with runtime_lock():
        if args.action == 'start':
            start(args.no_browser)
        elif args.action == 'stop':
            stop()
        else:
            current, info = record(), health()
            ok = bool(current and info.get('app') == 'portique-lab' and info.get('instance') == current['instance'])
            print('Application : ' + ('en marche avec PostgreSQL — ' + URL if ok else 'arrêtée ou indisponible'))


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, OSError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
