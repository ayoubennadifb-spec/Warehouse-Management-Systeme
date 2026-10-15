import os, asyncio, json, time, logging
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from fastapi import FastAPI, HTTPException, Request, Query
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from . import domain, repository as repo
from .hardware import HardwareGuard, self_test
from .retrieval import plan_retrieval
from .configuration import impact,reconfigure
# Read a simple local .env, without overriding explicit process settings.
ROOT=Path(__file__).resolve().parents[1]
if (ROOT/'.env').exists():
    for line in (ROOT/'.env').read_text(encoding='utf-8').splitlines():
        if line.strip() and not line.lstrip().startswith('#') and '=' in line:
            k,v=line.split('=',1);os.environ.setdefault(k.strip(),v.strip().strip('"').strip("'"))
MODE=os.environ.get('APP_MODE','simulation');speed=1.0
hardware=HardwareGuard()
if MODE not in ('simulation','real'):raise RuntimeError('APP_MODE must be simulation or real')

def snapshot():
    with repo.connect() as db:
        db.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        return repo.public(repo.load(db))

def advance(dt):
    with repo.connect() as db:
        repo.lock(db);s=repo.load(db)
        if s['mission'] and not s['mission']['paused']:
            domain.tick(s,dt,speed);repo.save(db,s)

async def simulation_loop():
    previous=time.monotonic()
    while True:
        await asyncio.sleep(.15)
        current=time.monotonic();dt=min(current-previous,1.0);previous=current
        try:await asyncio.to_thread(advance,dt)
        except Exception:logging.exception('Simulation paused by a database error')

@asynccontextmanager
async def lifespan(app):
    await asyncio.to_thread(repo.initialize)
    task=asyncio.create_task(simulation_loop()) if MODE=='simulation' else None
    yield
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):await task

app=FastAPI(title='Portique Lab local API',version='1.0.0',lifespan=lifespan)
@app.middleware('http')
async def local_write_guard(request,call_next):
    # Same-origin browser writes only; use a reverse proxy/auth before any LAN exposure.
    if request.method not in ('GET','HEAD','OPTIONS'):
        origin=request.headers.get('origin')
        if origin and origin.rstrip('/')!=str(request.base_url).rstrip('/'):
            from fastapi.responses import JSONResponse
            return JSONResponse({'detail':'Origine non autorisée.'},status_code=403)
    return await call_next(request)
@app.get('/api/health')
def health():
    with repo.connect() as db:version=db.execute('SHOW server_version').fetchone()['server_version']
    return dict(status='ok',app='portique-lab',instance=os.environ.get('PORTIQUE_INSTANCE_ID'),database='PostgreSQL',database_version=version,mode=MODE)
@app.get('/api/hardware/status')
def hardware_status():return hardware.status()
@app.post('/api/hardware/self-test')
def hardware_self_test():
    # Fresh software-only mocks; never changes the guard or the working inventory.
    return self_test()
@app.get('/api/state')
def get_state():return snapshot()
@app.post('/api/preview-retrieval')
def preview_retrieval(body:dict):
    try:return plan_retrieval(snapshot(),body.get('id'),body.get('destination'))
    except (ValueError,KeyError,TypeError) as e:raise HTTPException(409,str(e))
@app.post('/api/preview-configuration')
def preview_configuration(body:dict):
    try:return impact(snapshot(),body['config'])
    except (ValueError,KeyError,TypeError) as e:raise HTTPException(409,str(e))
@app.get('/api/history')
def history(before:int|None=None,kind:str='all',limit:int=Query(50,ge=1,le=100)):
    if kind not in ('all','missions','trucks','alerts'):raise HTTPException(400,'Filtre inconnu.')
    with repo.connect() as db:
        cfg=db.execute('SELECT id FROM configurations WHERE active').fetchone()['id']
        rows=db.execute('''SELECT id,event_key AS key,at,kind,message FROM evenements
          WHERE configuration_id=%s AND (%s::bigint IS NULL OR id<%s)
          AND (%s='all' OR (%s='trucks' AND kind LIKE 'truck_%%') OR
               (%s='alerts' AND kind='alert') OR (%s='missions' AND kind IN ('mission_started','picked','deposited','reconciled','mission_cancelled','operation_started','operation_completed')))
          ORDER BY id DESC LIMIT %s''',(cfg,before,before,kind,kind,kind,kind,limit)).fetchall()
        return rows
@app.post('/api/action')
def perform(body:dict):
    global speed
    if MODE!='simulation':raise HTTPException(403,'Les actions de démonstration sont désactivées en mode réel.')
    try:
        if body.get('action')=='speed':
            value=body.get('speed')
            if isinstance(value,bool) or value not in [.5,1,2,4]:raise ValueError('Vitesse invalide.')
            speed=float(value);return snapshot()
        with repo.connect() as db:
            repo.lock(db);s=repo.load(db)
            if body.get('action')=='configure':
                s=repo.create_configuration(db,reconfigure(s,body['config']))
            elif body.get('action')=='reset':
                if s['mission']:raise ValueError('Terminez la mission avant de recréer la scène.')
                s=repo.create_configuration(db,domain.new_state(body.get('config') or s['config']))
            else:domain.action(s,body);repo.save(db,s)
            result=repo.public(s)
        return result
    except (ValueError,KeyError,TypeError) as e:raise HTTPException(409,str(e))
    except (repo.psycopg.IntegrityError,repo.psycopg.errors.RaiseException):raise HTTPException(409,'Conflit de données : opération annulée.')
@app.get('/api/events')
async def stream(request:Request):
    async def generate():
        last=None
        while not getattr(app.state,'shutting_down',False) and not await request.is_disconnected():
            try:
                current=json.dumps(await asyncio.to_thread(snapshot),ensure_ascii=False)
                if current!=last:yield 'event: snapshot\ndata: '+current+'\n\n';last=current
                else:yield 'event: heartbeat\ndata: '+json.dumps({'at':time.time()})+'\n\n'
            except Exception:yield 'event: unavailable\ndata: {}\n\n'
            await asyncio.sleep(.5)
    return StreamingResponse(generate(),media_type='text/event-stream',headers={'Cache-Control':'no-cache'})
app.mount('/',StaticFiles(directory=ROOT/'dist',html=True),name='interface')
