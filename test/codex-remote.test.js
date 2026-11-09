'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const adapter = path.resolve(__dirname, '../src/codex-remote.py');
const fixture = path.resolve(__dirname, 'helpers/codex-rpc-fixture.py');
const python = process.env.PYTHON || 'python3';
const pythonProbe = process.platform === 'win32' ? {} : spawnSync(python, ['-I', '-c', 'import fcntl']);
const available = process.platform !== 'win32' && pythonProbe.status === 0;
if (process.platform !== 'win32' && !available) {
  test('Codex adapter tests require Python 3 on POSIX hosts', () => {
    assert.equal(pythonProbe.status, 0, pythonProbe.error?.message || pythonProbe.stderr?.toString());
  });
}
if (available) fs.chmodSync(fixture, 0o700);
const preamble = `
import contextlib,io,json,os,runpy,shutil,signal,socket,stat,subprocess,sys,tempfile,time
module=runpy.run_path(${JSON.stringify(adapter)})
Adapter=module['Adapter']; Error=module['AdapterError']; Rpc=module['Rpc']; PROVIDER=module['PROVIDER']
fixture=${JSON.stringify(fixture)}
owner='a'*32
other='b'*32
sandbox=tempfile.mkdtemp(prefix='mpbt-',dir='/tmp')
os.chmod(sandbox,0o700)
os.mkdir(os.path.join(sandbox,'temporary'))
tempfile.tempdir=os.path.join(sandbox,'temporary')
home=os.path.join(sandbox,'account');os.mkdir(home,0o700)
codex_home=os.path.join(home,'.codex')
os.environ['CODEX_HOME']=codex_home
os.environ.pop('MAGPIE_CODEX_FIXTURE_MODE',None)
a=Adapter(home=home,binary=fixture,codex_home=codex_home)
# Most adapter checks isolate config RPC; dedicated tests below run real watchers.
a.start_watchdog=lambda state: None
def invoke(operation,**fields):
    return a.dispatch(dict(operation=operation,owner=owner,**fields))
def expect(code,func):
    try:func()
    except Error as e:
        assert e.code==code,(e.code,code)
        assert 'SECRET' not in e.message
    else:raise AssertionError('Expected '+code)
def read_config():
    try:
        with open(os.path.join(codex_home,'config.toml')) as f:return json.load(f)
    except FileNotFoundError:return {}
def write_config(value):
    os.makedirs(codex_home,mode=0o700,exist_ok=True)
    path=os.path.join(codex_home,'config.toml')
    with open(path,'w') as f:json.dump(value,f)
    os.chmod(path,0o600)
def state():
    with open(a.state_path) as f:return json.load(f)
def prepare():return invoke('prepare')
def forward(prepared):
    sock=socket.socket(socket.AF_UNIX)
    sock.bind(prepared['socketPath'])
    return sock
def apply(prepared,**overrides):
    fields=dict(model='vendor/model',remotePort=13425,socketPath=prepared['socketPath']);fields.update(overrides)
    return invoke('apply',**fields)
`;
function check(name, body, options = {}) {
  test(name, { skip: !available, ...options }, () => {
    const source = preamble + '\ntry:\n' + body.split('\n').map(line => '    ' + line).join('\n') + '\nfinally:\n    shutil.rmtree(sandbox)\n';
    const result = spawnSync(python, ['-I', '-'], { input: source, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  });
}

check('Codex prepare holds a private account lease without changing user configuration', `
original={'model':'original','model_provider':'openai','model_providers':{'personal':{'env_key':'SECRET_VALUE'}},'unrelated':{'api_key':'SECRET_VALUE'}}
write_config(original)
p=prepare()
assert p['binary']==fixture and p['version']=='0.164.0-alpha.11.1'
assert read_config()==original
assert stat.S_IMODE(os.stat(a.state_path).st_mode)==0o600
assert stat.S_IMODE(os.stat(os.path.dirname(p['socketPath'])).st_mode)==0o700
assert os.path.basename(p['socketPath'])=='credentials.sock'
assert 'SECRET_VALUE' not in open(a.state_path).read()
assert 'original' not in state()
assert invoke('prepare')==p
expect('LEASE_BUSY',lambda:a.dispatch({'operation':'prepare','owner':other}))
expect('LEASE_BUSY',lambda:a.dispatch({'operation':'cleanup','owner':other}))
assert invoke('cleanup')=={'cleaned':True,'retained':False}
assert not os.path.exists(a.state_path) and not os.path.exists(os.path.dirname(p['socketPath']))
`);

check('Codex apply writes only the managed provider and restore uses raw user layer values', `
original={'model':'old-model','model_provider':'old-provider','model_providers':{'personal':{'api_key':'SECRET_VALUE'}},'other':'keep'}
write_config(original)
p=prepare()
with forward(p):
    result=apply(p)
    assert result=={'applied':True,'model':'vendor/model','provider':PROVIDER}
    config=read_config()
    provider=config['model_providers'][PROVIDER]
    assert config['other']=='keep' and config['model_providers']['personal']==original['model_providers']['personal']
    assert provider['base_url']=='http://127.0.0.1:13425/v1'
    assert provider['model_catalog_url']=='http://127.0.0.1:13425/v1/codex/models'
    assert provider['wire_api']=='responses'
    assert provider['requires_openai_auth'] is False and provider['supports_websockets'] is False
    auth=provider['auth']
    assert os.path.isabs(auth['command']) and os.path.basename(auth['command'])=='curl'
    assert auth['args']==['--disable','--silent','--show-error','--fail','--max-time','3','--noproxy','*','--unix-socket',p['socketPath'],'http://localhost/token']
    assert auth['timeout_ms']==5000 and auth['refresh_interval_ms']==1000
    s=state()
    assert s['original']=={'model':'old-model','model_provider':'old-provider'}
    assert s['applied']['model_providers.'+PROVIDER]==provider
    assert 'SECRET_VALUE' not in open(a.state_path).read()
    assert invoke('cleanup')=={'cleaned':False,'retained':True}
    assert os.path.exists(a.state_path)
    restored=invoke('restore')
    assert set(restored['restored'])=={'model','model_provider','model_providers.'+PROVIDER}
assert read_config()==original and not os.path.exists(a.state_path)
`);

check('Codex restore deletes originally absent fields through official null edits', `
p=prepare()
with forward(p):
    apply(p)
    assert state()['original']=={'model':None,'model_provider':None}
    invoke('restore')
config=read_config()
assert 'model' not in config and 'model_provider' not in config
assert PROVIDER not in config.get('model_providers',{})
`);

check('Codex restore preserves user edits independently across all three fields', `
write_config({'model':'before','model_provider':'before-provider'})
p=prepare()
with forward(p):
    apply(p)
    config=read_config();config['model']='user-new';config['model_providers'][PROVIDER]['name']='User renamed';write_config(config)
    result=invoke('restore')
assert set(result['preserved'])=={'model','model_providers.'+PROVIDER}
assert result['restored']==['model_provider']
config=read_config()
assert config['model']=='user-new' and config['model_provider']=='before-provider'
assert config['model_providers'][PROVIDER]['name']=='User renamed'
`);

check('Codex detached watchdog retains a live lease then restores after channel loss and preserves user edits', `
import socketserver,threading
a=Adapter(home=home,binary=fixture,codex_home=codex_home,watchdog_policy={'interval':0.02,'grace':0.2})
original={'model':'before','model_provider':'before-provider','unrelated':'keep','model_providers':{}}
write_config(original)
p=prepare()
requests=[]
class Health(socketserver.BaseRequestHandler):
    def handle(self):
        request=self.request.recv(4096);requests.append(request)
        self.request.sendall(b'HTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n')
server=socketserver.ThreadingUnixStreamServer(p['socketPath'],Health)
thread=threading.Thread(target=lambda:server.serve_forever(poll_interval=0.01),daemon=True);thread.start()
try:
    apply(p)
    time.sleep(0.35)
    assert read_config()['model_provider']==PROVIDER and os.path.exists(a.state_path)
    assert requests and all(request.startswith(b'GET /health ') for request in requests)
    config=read_config();config['model']='user-edited';write_config(config)
finally:
    server.shutdown();server.server_close();thread.join()
deadline=time.monotonic()+5
while os.path.exists(a.state_path) and time.monotonic()<deadline:time.sleep(0.02)
assert not os.path.exists(a.state_path)
assert read_config()==dict(original,model='user-edited'),read_config()
assert not os.path.exists(os.path.dirname(p['socketPath']))
`);

check('Codex watchdog failure prevents provider writes', `
original={'model':'before','model_provider':'before-provider'}
write_config(original)
def unavailable(state):module['fail']('WATCHDOG_FAILED','watchdog unavailable')
a.start_watchdog=unavailable
expect('WATCHDOG_FAILED',prepare)
assert read_config()==original and not os.path.exists(a.state_path)
`);

check('Codex watchdog survives its setup process exiting without disconnect cleanup', `
import textwrap
original={'model':'before','model_provider':'before-provider','model_providers':{}}
write_config(original)
settings={'home':home,'binary':fixture,'codex_home':codex_home,'watchdog_policy':{'interval':0.02,'grace':0.4}}
encoded=module['base64'].b64encode(json.dumps(settings).encode()).decode()
source=textwrap.dedent('''
import base64,json,os,runpy,socket
m=runpy.run_path(${JSON.stringify(adapter)})
a=m['Adapter'](**json.loads(base64.b64decode('''+repr(encoded)+''')))
owner='a'*32
p=a.dispatch({'operation':'prepare','owner':owner})
sock=socket.socket(socket.AF_UNIX);sock.bind(p['socketPath'])
a.dispatch({'operation':'apply','owner':owner,'model':'vendor/model','remotePort':13425,'socketPath':p['socketPath']})
os._exit(0)
''')
# Compile explicitly: newer Python -c can dedent implicitly, masking the failure
# on the older Python versions used by Linux runners.
compile(source,'<watchdog-setup>','exec')
parent=subprocess.run([sys.executable,'-I','-c',source],stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=10)
assert parent.returncode==0,parent.stderr
deadline=time.monotonic()+5
while os.path.exists(a.state_path) and time.monotonic()<deadline:time.sleep(0.02)
assert not os.path.exists(a.state_path)
assert read_config()==original,read_config()
`);

check('Codex expired watchdog cannot restore a replacement window lease', `
p=prepare()
with forward(p):apply(p)
s=state();s['owner']=other
with a.locked():a.write_state(s)
module['watch'](a,owner,interval=0.01,grace=0)
assert state()['owner']==other and read_config()['model_provider']==PROVIDER
a.dispatch({'operation':'restore','owner':other})
assert not os.path.exists(a.state_path)
`);

check('Codex explicit ownerless recovery survives window reload and cannot be claimed by another owner', `
p=prepare()
with forward(p):
    apply(p)
    expect('LEASE_BUSY',lambda:a.dispatch({'operation':'restore','owner':other}))
    expect('LEASE_BUSY',lambda:a.dispatch({'operation':'prepare','owner':other}))
    replacement=Adapter(home=home,binary=fixture,codex_home=codex_home)
    result=replacement.dispatch({'operation':'restore'})
    assert result['active'] is False and not os.path.exists(a.state_path)
`);

check('Codex apply validates preparation, model, port and an established socket forward', `
expect('INVALID_REQUEST',lambda:a.dispatch({'operation':'prepare','owner':'bad'}))
expect('NOT_PREPARED',lambda:invoke('apply',model='m',remotePort=1,socketPath='/tmp/no'))
p=prepare()
expect('SOCKET_MISSING',lambda:apply(p))
for changes in [{'model':''},{'model':'   '},{'remotePort':True},{'remotePort':0},{'remotePort':65536},{'socketPath':'/tmp/no'}]:
    expect('INVALID_REQUEST',lambda:apply(p,**changes))
with open(p['socketPath'],'w') as f:f.write('not a socket')
expect('UNSAFE_SOCKET',lambda:apply(p))
os.unlink(p['socketPath']);invoke('cleanup')
`);

check('Codex refuses preexisting reserved providers without copying user provider credentials', `
write_config({'model_providers':{PROVIDER:{'api_key':'SECRET_VALUE'}}})
expect('PROVIDER_EXISTS',prepare)
assert not os.path.exists(a.state_path)
write_config({})
p=prepare()
write_config({'model_providers':{PROVIDER:{'api_key':'SECRET_VALUE'}}})
with forward(p):expect('PROVIDER_EXISTS',lambda:apply(p))
assert state()['phase']=='prepared'
invoke('cleanup')
`);

check('Codex failed writes retain durable recovery intent and never forward raw RPC errors', `
write_config({'model':'before'})
p=prepare()
with forward(p):
    os.environ['MAGPIE_CODEX_FIXTURE_MODE']='write-conflict'
    expect('CONFIG_WRITE_FAILED',lambda:apply(p))
    assert state()['phase']=='applied' and state()['original']['model']=='before'
    assert read_config()=={'model':'before'}
    assert invoke('cleanup')['retained'] is True
    os.environ.pop('MAGPIE_CODEX_FIXTURE_MODE')
    restored=invoke('restore')
    assert restored['restored']==[] and set(restored['preserved'])=={'model','model_provider','model_providers.'+PROVIDER}
assert not os.path.exists(a.state_path)
`);

check('Codex restore write conflicts retain state for a later safe retry', `
p=prepare()
with forward(p):
    apply(p)
    os.environ['MAGPIE_CODEX_FIXTURE_MODE']='write-error'
    expect('CONFIG_WRITE_FAILED',lambda:invoke('restore'))
    assert state()['phase']=='applied' and read_config()['model']=='vendor/model'
    os.environ.pop('MAGPIE_CODEX_FIXTURE_MODE')
    invoke('restore')
`);

check('Codex lease and home reject symlinks, hard links and unsafe permissions', `
os.mkdir(codex_home,0o700)
target=os.path.join(sandbox,'target');open(target,'w').write('sentinel')
os.symlink(target,a.state_path)
expect('UNSAFE_STATE',prepare)
os.unlink(a.state_path)
open(a.state_path,'w').write('{}');os.chmod(a.state_path,0o644)
expect('UNSAFE_STATE',prepare)
os.chmod(a.state_path,0o600)
os.link(a.state_path,os.path.join(sandbox,'hardlink'))
expect('UNSAFE_STATE',prepare)
os.unlink(a.state_path)
os.chmod(codex_home,0o777)
expect('UNSAFE_PATH',prepare)
os.chmod(codex_home,0o700);os.rmdir(codex_home)
os.symlink(sandbox,codex_home)
expect('UNSAFE_PATH',prepare)
assert open(target).read()=='sentinel'
`);

check('Codex rebind removes only the same owner Unix socket in its recorded private directory', `
p=prepare()
with forward(p):
    expect('LEASE_BUSY',lambda:a.dispatch({'operation':'rebind','owner':other,'socketPath':p['socketPath']}))
    expect('INVALID_REQUEST',lambda:invoke('rebind',socketPath='/tmp/no'))
    assert invoke('rebind',socketPath=p['socketPath'])=={'socketPath':p['socketPath']}
assert not os.path.lexists(p['socketPath'])
for kind in ('file','symlink'):
    if kind=='file':open(p['socketPath'],'w').close()
    else:os.symlink(os.path.join(sandbox,'victim'),p['socketPath'])
    expect('UNSAFE_SOCKET',lambda:invoke('rebind',socketPath=p['socketPath']))
    expect('UNSAFE_SOCKET',lambda:invoke('cleanup'))
    os.unlink(p['socketPath'])
invoke('cleanup')
`);

check('Codex cleanup does not recursively remove user files or replaced socket directories', `
p=prepare();directory=os.path.dirname(p['socketPath'])
extra=os.path.join(directory,'user-file');open(extra,'w').write('keep')
expect('CLEANUP_BLOCKED',lambda:invoke('cleanup'))
assert open(extra).read()=='keep' and os.path.exists(a.state_path)
os.unlink(extra)
os.rename(directory,directory+'-saved');os.mkdir(directory,0o700)
expect('UNSAFE_PATH',lambda:invoke('cleanup'))
os.rmdir(directory);os.rename(directory+'-saved',directory)
os.chmod(directory,0o755)
expect('UNSAFE_PATH',lambda:invoke('cleanup'))
os.chmod(directory,0o700);invoke('cleanup')
`);

check('Codex rejects ignored or unsupported auth configuration using a strict negative probe', `
for mode in ('ignore-strict','unsupported-auth'):
    os.environ['MAGPIE_CODEX_FIXTURE_MODE']=mode
    expect('UNSUPPORTED_AUTH',prepare)
    assert not os.path.exists(a.state_path)
`);

check('Codex official extension discovery prefers installed manifest records and rejects PATH impostors', `
root=os.path.join(home,'.vscode-server','extensions');os.makedirs(root)
arch={'arm64':'aarch64','aarch64':'aarch64','x86_64':'x64','amd64':'x64'}[module['platform'].machine().lower()]
def install(name,publisher='OpenAI'):
    folder=os.path.join(root,name);os.makedirs(os.path.join(folder,'bin','linux-'+arch))
    with open(os.path.join(folder,'package.json'),'w') as f:json.dump({'name':'chatgpt','publisher':publisher},f)
    binary=os.path.join(folder,'bin','linux-'+arch,'codex');shutil.copyfile(fixture,binary);os.chmod(binary,0o700)
    return binary
old=install('openai.chatgpt-1');new=install('openai.chatgpt-999')
with open(os.path.join(root,'extensions.json'),'w') as f:json.dump([{'identifier':{'id':'openai.chatgpt'},'relativeLocation':'openai.chatgpt-1'}],f)
assert module['discover_binary'](home)==old
os.unlink(old)
assert module['discover_binary'](home)==new
os.unlink(new)
install('openai.chatgpt-impostor','someone-else')
expect('CODEX_NOT_FOUND',lambda:module['discover_binary'](home))
`);

check('Codex main emits exactly one sanitized JSON line and ignores request binary/home injection', `
out=io.StringIO()
with contextlib.redirect_stdout(out):module['main']({'operation':'unknown','token':'SECRET_VALUE'})
lines=out.getvalue().splitlines();assert len(lines)==1
result=json.loads(lines[0]);assert result['ok'] is False and result['code']=='INVALID_REQUEST'
assert 'SECRET' not in lines[0]
os.environ['HOME']=home
out=io.StringIO()
with contextlib.redirect_stdout(out):module['main']({'operation':'inspect','binary':fixture,'home':home})
result=json.loads(out.getvalue());assert result['code']=='CODEX_NOT_FOUND'
`);

check('Codex app-server enforces bounded stdout and terminates/reaps its process', `
os.mkdir(codex_home,0o700)
os.environ['MAGPIE_CODEX_FIXTURE_MODE']='flood'
rpc=Rpc(fixture,codex_home)
with rpc:
    expect('RPC_OUTPUT_LIMIT',rpc.initialize)
assert rpc.child.process.poll() is not None
os.environ['MAGPIE_CODEX_FIXTURE_MODE']='hang'
module['RPC_TIMEOUT']=0.2
rpc=Rpc(fixture,codex_home)
# Classes retain their runpy globals; lower the actual deadline constant too.
Rpc.call.__globals__['RPC_TIMEOUT']=0.2
with rpc:expect('RPC_TIMEOUT',rpc.initialize)
assert rpc.child.process.poll() is not None
`);

for (const termination of ['SIGTERM', 'SIGHUP', 'SIGINT']) check(`Codex parent ${termination} kills and reaps an app-server that ignores termination`, `
os.mkdir(codex_home,0o700)
os.environ['MAGPIE_CODEX_FIXTURE_MODE']='ignore-term'
source="import runpy,sys,time\\nm=runpy.run_path(sys.argv[1]);rpc=m['Rpc'](sys.argv[2],sys.argv[3])\\ntry:\\n    with rpc:\\n        rpc.child.line(time.monotonic()+5)\\n        print(rpc.child.process.pid,flush=True)\\n        rpc.initialize()\\nfinally:\\n    print('child-exit:'+str(rpc.child.process.returncode),flush=True)\\n"
process=subprocess.Popen([sys.executable,'-I','-c',source,${JSON.stringify(adapter)},fixture,codex_home],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
try:
    selector=module['selectors'].DefaultSelector();selector.register(process.stdout,module['selectors'].EVENT_READ)
    assert selector.select(5),'Child process did not start'
    line=process.stdout.readline()
    assert line,process.stderr.read()
    pid=int(line)
    process.send_signal(getattr(signal,${JSON.stringify(termination)}))
    out,err=process.communicate(timeout=6)
    assert process.returncode==128+getattr(signal,${JSON.stringify(termination)}),(process.returncode,out,err)
    assert 'child-exit:-9' in out,(out,err)
finally:
    if process.poll() is None:process.kill();process.wait()
`);

for (const termination of ['SIGTERM', 'SIGHUP', 'SIGINT']) check(`Codex ${termination} during a buffered write defers pipe cleanup until unwinding`, `
os.mkdir(codex_home,0o700)
os.environ['MAGPIE_CODEX_FIXTURE_MODE']='ignore-term'
rpc=Rpc(fixture,codex_home)
original=None
class InterruptedWriter(io.RawIOBase):
    fired=False
    def writable(self):return True
    def write(self,data):
        if not self.fired:
            self.fired=True
            signal.raise_signal(getattr(signal,${JSON.stringify(termination)}))
        return len(data)
try:
    try:
        with rpc:
            rpc.child.line(time.monotonic()+5)
            original=rpc.child.process.stdin
            rpc.child.process.stdin=io.BufferedWriter(InterruptedWriter())
            rpc.initialize()
    except SystemExit as error:
        assert error.code==128+getattr(signal,${JSON.stringify(termination)})
    else:raise AssertionError('Signal did not stop the RPC')
    assert rpc.child.process.returncode==-9,rpc.child.process.returncode
    for pipe in (rpc.child.process.stdin,rpc.child.process.stdout,rpc.child.process.stderr):assert pipe.closed
    rpc.child.close()
finally:
    if original:original.close()
`);

check('Codex account directory lock rejects concurrent mutations', `
os.mkdir(codex_home,0o700)
fd=os.open(codex_home,os.O_RDONLY|os.O_DIRECTORY)
module['fcntl'].flock(fd,module['fcntl'].LOCK_EX|module['fcntl'].LOCK_NB)
try:expect('LEASE_BUSY',prepare)
finally:os.close(fd)
`);

const realBinary = process.env.MAGPIE_TEST_CODEX_BINARY;
check('Codex optional local official binary validates strict auth and complete apply/restore RPC', `
a=Adapter(home=home,binary=${JSON.stringify(realBinary || '')},codex_home=codex_home)
os.mkdir(codex_home,0o700)
with open(os.path.join(codex_home,'config.toml'),'w') as f:f.write('model="original"\\nmodel_provider="openai"\\n')
os.chmod(os.path.join(codex_home,'config.toml'),0o600)
p=prepare()
with forward(p):
    apply(p)
    result=invoke('restore')
    assert len(result['restored'])==3
assert not os.path.exists(a.state_path)
`, { skip: !available || !realBinary });
