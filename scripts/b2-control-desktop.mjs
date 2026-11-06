import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { candidateRuntime } from './lib/candidate-runtime.mjs';
import { freshRun, project, writeJson, redact, sha256, commandResult, receipt } from './lib/internal-candidate-utils.mjs';
import { createControlIntentStore } from '../src/core/control-intent-store.mjs';
import { randomBytes, randomUUID } from 'node:crypto';
import { requestDesktopShutdown } from './lib/renderer-cdp.mjs';

const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--desktop-rc2','--desktop-rc21','--case','--grok-program'].includes(process.argv[index]) || !process.argv[index + 1]) throw new Error('Expected both named Desktop paths.');
  options.set(process.argv[index], process.argv[index + 1]);
}
const runtimes = [candidateRuntime(options.get('--desktop-rc2')),candidateRuntime(options.get('--desktop-rc21'))]
  .filter(row => !process.env.DSH_B2_ONLY_VERSION || row.app.version === process.env.DSH_B2_ONLY_VERSION);
const targetVersions = (process.env.DSH_B2_TARGET_VERSIONS ?? '0.2.1-rc.2,0.2.1-rc.3').split(',').map(value => value.trim()).filter(Boolean);
assert.deepEqual(runtimes.map(row=>row.app.version),process.env.DSH_B2_ONLY_VERSION?[process.env.DSH_B2_ONLY_VERSION]:targetVersions);
const testedVersions = runtimes.map(row => row.app.version);
const verificationCase=options.get('--case')??'control';
if(!['control','migration','product','m0-04','ux'].includes(verificationCase))throw new Error('Expected --case control, migration, product, m0-04 or ux.');
if(verificationCase==='m0-04'&&!options.get('--grok-program'))throw new Error('M0-04 requires --grok-program with a grok-search-rs 0.1.26 executable; it is copied into each isolated run.');
const {runId,directory}=freshRun(verificationCase==='ux'?'ux-lifecycle-desktop':verificationCase==='migration'?'b2-migration-desktop':verificationCase==='product'?'b2-product-desktop':verificationCase==='m0-04'?'b2-m0-04-desktop':'b2-control-desktop');
const temporary=join(tmpdir(),'dsh-deferred-desktop-b2-'+runId);
const sources=['src/core/control-intent-store.mjs','src/core/startup-recovery.mjs','fixtures/deferred-release/control.mjs','fixtures/deferred-release/desktop-fixture.mjs','fixtures/internal-candidate/host-fixture.mjs','scripts/deferred-release-desktop-prepare.mjs','scripts/b2-control-desktop.mjs',...(verificationCase==='migration'?['scripts/b2-control-migrate.mjs']:[]),...(['product','m0-04'].includes(verificationCase)?['src/index.mjs','src/control.mjs','src/recovery.mjs','src/route-verifier.mjs','src/core/product-control.mjs','src/core/original-search-counter.mjs','src/core/release-transaction.mjs','cordis.patch.yml']:[])];
if (verificationCase === 'ux') sources.push('src/bundle.mjs', 'src/index.mjs', 'src/provider.mjs', 'src/control.mjs',
  'src/recovery.mjs', 'src/route-verifier.mjs', 'src/settings-ui.mjs', 'src/core/product-control.mjs',
  'src/core/original-search-counter.mjs', 'src/core/release-transaction.mjs', 'src/core/mcp-search.mjs',
  'src/core/session-owner.mjs', 'src/core/search-executor.mjs', 'src/core/result-map.mjs', 'src/program.mjs',
  'src/core/program-discovery.mjs', 'src/core/program-install.mjs', 'src/core/config-path.mjs', 'cordis.patch.yml', 'package.json');
// D-28/D-29: product, m0-04 and ux install the complete aggregate bundle, so
// every shipped runtime file is part of the evidence identity.
const listFiles=folder=>readdirSync(join(project,folder),{withFileTypes:true}).flatMap(row=>row.isDirectory()
  ?listFiles(folder+'/'+row.name):[folder+'/'+row.name]);
if(['product','m0-04','ux'].includes(verificationCase))sources.push(...listFiles('src'),'cordis.patch.yml','package.json');
sources.splice(0,sources.length,...[...new Set(sources)].sort());
const sourceHashesBefore = sources.map(file => ({ file, sha256: sha256(join(project, file)) }));
const beforeHashes=Object.fromEntries(runtimes.map(row=>[row.app.version,{exe:sha256(row.executable),asar:sha256(row.archivePath)}]));
const secrets=new Set();
const sanitize=value=>redact(String(value),[[temporary,'<TEMPORARY_RUN>'],...runtimes.map(row=>[dirname(row.executable),`<DESKTOP_${row.app.version}>`])],[...secrets]);
const safe=value=>JSON.parse(sanitize(JSON.stringify(value)));
const sleep=milliseconds=>new Promise(done=>setTimeout(done,milliseconds));
const results=[],children=[],preparationResults=[];
let serial=0;
async function unusedPort() {
  const {createServer}=await import('node:net');const server=createServer();
  await new Promise((done,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',done);});
  const port=server.address().port;await new Promise((done,reject)=>server.close(error=>error?reject(error):done()));return port;
}

async function startDeepseekSearchStub() {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { if (body.length < 1024 * 1024) body += chunk; });
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, bodyLength: body.length });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ content: [
        { type: 'web_search_tool_result', content: [{
          type: 'web_search_result', url: 'https://example.invalid/official-counter',
          title: 'Official counter fixture', page_age: '2026-10-24',
        }] },
        { type: 'text', text: '本地官方搜索派发探针', citations: [{
          type: 'web_search_result_location', url: 'https://example.invalid/official-counter',
          cited_text: 'Official counter fixture',
        }] },
      ] }));
    });
  });
  await new Promise((done, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', done);
  });
  const { port } = server.address();
  return {
    requests,
    baseURL: `http://127.0.0.1:${port}/anthropic/v1`,
    close: () => new Promise((done, reject) => server.close(error => error ? reject(error) : done())),
  };
}
// M0-04 runs the real grok-search-rs 0.1.26 against this loopback Responses
// stub. The key is synthetic and per run; nothing reaches the network.
async function startGrokResponsesStub(key) {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { if (body.length < 1024 * 1024) body += chunk; });
    request.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      const authorized = request.headers.authorization === 'Bearer ' + key;
      requests.push({ method: request.method, url: request.url, authorizedWithSyntheticKey: authorized,
        model: parsed?.model ?? null, tools: Array.isArray(parsed?.tools) ? parsed.tools.map(tool => tool?.type).filter(Boolean) : [] });
      if (request.method !== 'POST' || request.url !== '/v1/responses' || !authorized) {
        response.writeHead(401, { 'content-type': 'application/json', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify({ error: { message: 'local test authorization rejected' } }));
        return;
      }
      const text = 'offline-fixture grok-search-rs 0.1.26 real MCP search succeeded.';
      response.writeHead(200, { 'content-type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ id: 'resp-' + randomBytes(6).toString('hex'), object: 'response', status: 'completed',
        model: parsed?.model ?? null, output_text: text, output: [
          { type: 'web_search_call', action: { sources: [{ url: 'https://example.invalid/offline-fixture-grok',
            title: 'offline-fixture Grok Responses Fixture',
            description: 'Response served by the isolated local Responses API stub.' }] } },
          { type: 'message', content: [{ type: 'output_text', text }] },
        ] }));
    });
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    close: () => new Promise((done, reject) => server.close(error => error ? reject(error) : done())) };
}
const grokKey = verificationCase === 'm0-04' ? 'dsh-m004-' + randomBytes(12).toString('hex') : null;
if (grokKey) secrets.add(grokKey);
let grokStub = null;
async function start(runtime,folder,phase,fault=null,versioned=true,productCounter=true) {
  const control=JSON.parse(readFileSync(join(folder,'local-control.json'),'utf8'));
  assert.equal(control.versionedControlRecord,true);secrets.add(control.token);
  const debuggerPort=await unusedPort(),hostInspectPort=await unusedPort();
  const addressPath=join(folder,'address-'+(++serial)+'.json');
  const args=[control.archive,'--user-data-dir='+control.userData,'--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port='+debuggerPort,'--lang=zh-CN'];
  const env={...process.env};
  if(process.platform==='darwin'){const isolatedUser=join(folder,'user');mkdirSync(isolatedUser,{recursive:true});Object.assign(env,{HOME:isolatedUser,TMPDIR:folder});}
  for(const name of ['ELECTRON_RUN_AS_NODE','ELECTRON_FORCE_IS_PACKAGED','DSH_DESKTOP_DEV_APP','DSH_DESKTOP_MANDATORY_UPDATE_CONFIG','DSH_B2_RECORD_FAULT'])delete env[name];
  Object.assign(env,{DSH_HOME:control.dshHome,DSH_DESKTOP_DSH_DIR:control.runtime,
    DSH_DESKTOP_PRIMARY_RUNTIME_DIR:control.primaryRuntime,DSH_DESKTOP_PNPM_ENTRY:control.pnpmEntry,
    DSH_DESKTOP_OPEN_DEVTOOLS:'0',DSH_DESKTOP_HOST_INSPECT_PORT:String(hostInspectPort),
    DSH_DESKTOP_FIXTURE_TOKEN:control.token,DSH_DESKTOP_FIXTURE_ADDRESS_FILE:addressPath,
    DSH_B2_CONTROL_RECORD:versioned?'1':'0',DSH_B2_PRODUCT_COUNTER:productCounter?'1':'0',...(verificationCase==='m0-04'?{DSH_TOOLS_MODE:runtime.app.version==='0.2.0-rc.2'?'both':'ptc'}:{}),...(fault?{DSH_B2_RECORD_FAULT:fault}:{}),DSH_DESKTOP_OFFLINE_SENTINEL:'offline-test-sentinel-not-a-real-key',
    DSH_PRODUCT_ANALYTICS_OTLP_URL:'http://127.0.0.1:9',NODE_OPTIONS:'--dns-result-order=ipv4first'});
  const prefix=runtime.app.version+'-'+phase+'-'+serial;
  const stdoutPath=join(directory,prefix+'-stdout.log'),stderrPath=join(directory,prefix+'-stderr.log');
  const stdout=openSync(stdoutPath,'wx'),stderr=openSync(stderrPath,'wx');
  const command={executable:control.electron,args,cwd:folder,environment:Object.fromEntries(Object.entries(env).filter(([name])=>name.startsWith('DSH_')||name==='NODE_OPTIONS')),
    originalAsar:true,isolatedUserData:true,packagedStartupValidated:false,startedAt:new Date().toISOString()};
  writeJson(join(directory,prefix+'-command.json'),safe(command));
  const child=spawn(control.electron,args,{cwd:folder,env,windowsHide:true,shell:false,stdio:['ignore',stdout,stderr]});
  closeSync(stdout);closeSync(stderr);
  const state={prefix,child,folder,control,debuggerPort,exited:false,spawnError:null};
  state.closed=new Promise(done=>{child.once('error',error=>{state.spawnError=error.message;});child.once('close',(code,signal)=>{state.exited=true;state.exitCode=code;state.signal=signal;done();});});
  children.push(state);
  try {
    const until=Date.now()+65000;
    while(Date.now()<until){
      if(state.exited)throw new Error('Desktop exited during startup: '+state.spawnError+' '+readFileSync(stderrPath,'utf8').slice(-2500));
      if(existsSync(addressPath)){
        const address=JSON.parse(readFileSync(addressPath,'utf8'));
        state.address=address;
        state.probe=async(op,args={})=>{
          const response=await fetch(`http://127.0.0.1:${address.port}/probe`,{method:'POST',headers:{Authorization:control.token,'Content-Type':'application/json'},
            body:JSON.stringify({op,args}),signal:AbortSignal.timeout(15000)});
          const result=await response.json();if(response.status!==200||!result.ok)throw new Error(result.error?.message??'Desktop probe failed.');return result.value;
        };
        const snapshot=await state.probe('snapshot');state.initial=snapshot;
        if(snapshot.existingDependencyPresent&&snapshot.runtimeWeb){writeJson(join(directory,prefix+'-initial.json'),safe(snapshot));return state;}
      }
      await sleep(200);
    }
    const startupDiagnostic=safe({
      pid:child.pid,
      exited:state.exited,
      exitCode:state.exitCode??null,
      signal:state.signal??null,
      spawnError:state.spawnError??null,
      addressFileExists:existsSync(addressPath),
      debuggerPort,
      hostInspectPort,
      stdoutTail:readFileSync(stdoutPath,'utf8').slice(-6000),
      stderrTail:readFileSync(stderrPath,'utf8').slice(-6000),
    });
    throw new Error('Desktop startup did not produce an isolated probe: '+JSON.stringify(startupDiagnostic));
  } catch(error){await close(state);throw error;}
}
async function close(state) {
  if(!state.exited){
    try {
      await requestDesktopShutdown(state.debuggerPort, state.closed, { timeoutMs: 15000 });
    } catch(error){state.closeError=error.message;if(!state.exited){state.forced=true;state.child.kill('SIGKILL');await state.closed;}}
  }
  const identity={prefix:state.prefix,pid:state.child.pid,exitCode:state.exitCode,signal:state.signal,forced:state.forced??false,
    closeError:state.closeError??null,finishedAt:new Date().toISOString()};
  if(!state.exitSaved){writeJson(join(directory,state.prefix+'-exit.json'),safe(identity));state.exitSaved=true;}
  return identity;
}
function store(folder){const profile=join(folder,'dsh-home/profiles/desktop');return createControlIntentStore({directory:join(profile,'control-intent.records'),legacyPath:join(profile,'control-intent.fixture.json'),trustedRoot:profile});}
function selection(folder,keepRecovery){
  const path=join(folder,'dsh-home/profiles/desktop/package.json');const value=JSON.parse(readFileSync(path,'utf8'));
  value.dsh.profile.bundles=value.dsh.profile.bundles.filter(name=>name!=='candidate-controlled-search'&&(keepRecovery||name!=='candidate-search-recovery'));
  writeFileSync(path,JSON.stringify(value,null,2)+'\n');
}
function selectionProduct(folder, keepRecovery) {
  const path=join(folder,'dsh-home/profiles/desktop/package.json');const value=JSON.parse(readFileSync(path,'utf8'));
  // D-28 single bundle: recovery entries ship inside the product, so deselecting it leaves no executor.
  value.dsh.profile.bundles=value.dsh.profile.bundles.filter(name=>name!=='dsh-grok-search');
  writeFileSync(path,JSON.stringify(value,null,2)+'\n');
}async function fetchModelAuth(host, url) {
  let lastError = null;
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
      host.authRetries = attempt - 1;
      return response;
    } catch (error) {
      lastError = error;
      if (host.exited) break;
      await sleep(250);
    }
  }
  throw new Error('Model auth endpoint did not become ready: ' + (lastError?.message ?? 'unknown error'));
}
async function modelTurn(host,mode) {
  if(!host.modelSession) {
    const auth=await host.probe('model-auth');secrets.add(auth.url);
    const response=await fetchModelAuth(host,auth.url);
    assert.equal(response.status,303);
    const cookie=response.headers.get('set-cookie')?.split(';',1)[0];assert.ok(cookie);secrets.add(cookie);secrets.add(cookie.split('=').slice(1).join('='));
    host.cookie=cookie;
    host.rpc=async(endpoint,request)=>{
      const envelope={type:'client-request',rpcId:'b2-rpc-'+(++serial),method:endpoint,payload:{args:{request}}};
      const response=await fetch(host.address.hostOrigin+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:host.address.hostOrigin,Cookie:host.cookie},body:JSON.stringify(envelope),signal:AbortSignal.timeout(15000)});
      const result=await response.json();assert.equal(response.status,200);assert.equal(result?.result?.ok,true,JSON.stringify(result));return result.result.value;
    };
    const created=await host.rpc('session/create',{cwd:host.control.workspace});assert.ok(created.sessionId);host.modelSession=created.sessionId;
  }
  const before=await host.probe('snapshot');
  await host.rpc('session/prompt',{requestId:'b2-prompt-'+(++serial),sessionId:host.modelSession,mode:'queue',content:[{type:'text',text:mode}]});
  const deadline=Date.now()+15000;
  while(Date.now()<deadline) {
    const after=await host.probe('snapshot');
    const events=after.sessionEvents.slice(before.sessionEvents.length).filter(event=>event.sessionId===host.modelSession);
    const final=events.findLast(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text==='内部候选轮次完成'));
    const ended=final&&events.find(event=>event.type==='turn/end'&&event.data.turn===final.data.turn&&event.data.reason?.kind==='completed');
    const toolResult=final&&events.findLast(event=>event.type==='tool/result'&&event.data.turn===final.data.turn);
    if(after.completed>before.completed&&ended&&(mode==='chat'||toolResult)) {
      return {mode,isError:toolResult?.data.message.isError===true,text:toolResult?.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')??'',
        toolResult:toolResult?.data.message??null,ptcDispatch:events.findLast(event=>event.type==='tool/ptc-dispatch')??null,beforeCalls:before.calls,afterCalls:after.calls,events,authRetries:host.authRetries??0,
        controlState:{ownerPresent:after.ownerPresent,selectedBundles:after.selectedBundles,recordEnvelope:after.recordEnvelope,controlEvents:after.controlEvents,modelCommands:after.modelCommands??null}};
    }
    await sleep(100);
  }
  throw new Error('Actual Desktop model turn did not complete: '+mode);
}
async function authenticateModel(host) {
  if (host.cookie && host.rpc) return;
  const auth = await host.probe('model-auth'); secrets.add(auth.url);
  const response = await fetchModelAuth(host, auth.url);
  assert.equal(response.status, 303);
  const cookie = response.headers.get('set-cookie')?.split(';', 1)[0]; assert.ok(cookie);
  secrets.add(cookie); secrets.add(cookie.split('=').slice(1).join('='));
  host.cookie = cookie;
  host.rpc = async (endpoint, request) => {
    const envelope = { type: 'client-request', rpcId: 'b2-rpc-' + (++serial), method: endpoint, payload: { args: { request } } };
    const result = await fetch(host.address.hostOrigin + '/api/' + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: host.address.hostOrigin, Cookie: host.cookie }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(30000) });
    const body = await result.json(); assert.equal(result.status, 200); assert.equal(body?.result?.ok, true, JSON.stringify(body)); return body.result.value;
  };
}
async function modelTurnOnSession(host, mode, sessionId) {
  assert.ok(sessionId, 'A target session id is required.');
  await authenticateModel(host);
  const before = await host.probe('snapshot');
  await host.rpc('session/prompt', { requestId: 'b2-prompt-' + (++serial), sessionId, mode: 'queue', content: [{ type: 'text', text: mode }] });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const after = await host.probe('snapshot');
    const events = after.sessionEvents.slice(before.sessionEvents.length).filter(event => event.sessionId === sessionId);
    const final = events.findLast(event => event.type === 'assistant/message' && event.data.message.content.some(block => block.type === 'text' && block.text === '内部候选轮次完成'));
    const ended = final && events.find(event => event.type === 'turn/end' && event.data.turn === final.data.turn && event.data.reason?.kind === 'completed');
    const toolResult = final && events.findLast(event => event.type === 'tool/result' && event.data.turn === final.data.turn);
    if (after.completed > before.completed && ended && (mode === 'chat' || toolResult)) {
      return { mode, sessionId, isError: toolResult?.data.message.isError === true,
        text: toolResult?.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '',
        toolResult: toolResult?.data.message ?? null, ptcDispatch: events.findLast(event => event.type === 'tool/ptc-dispatch') ?? null, authRetries: host.authRetries ?? 0,
        beforeCalls: before.calls, afterCalls: after.calls, events,
        controlState: { ownerPresent: after.ownerPresent, selectedBundles: after.selectedBundles, recordEnvelope: after.recordEnvelope, controlEvents: after.controlEvents, modelCommands: after.modelCommands ?? null } };
    }
    await sleep(100);
  }
  throw new Error('Actual Desktop model turn did not complete: ' + mode + ' on ' + sessionId);
}
async function openFollow(host, sessionId) {
  await authenticateModel(host);
  const opened = await host.probe('websocket', { origin: host.address.hostOrigin, cookie: host.cookie, sessionId });
  assert.equal(opened.opened, true, 'Official WebSocket follow did not open: ' + JSON.stringify(opened));
  return opened.id;
}
async function waitForSocketEvent(host, id, type, startIndex = 0, timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const snapshot = await host.probe('snapshot');
    const socket = snapshot.sockets.find(row => row.id === id);
    if (!socket) throw new Error('WebSocket probe disappeared: ' + id);
    const event = socket.frames.slice(startIndex).map(frame => frame?.value?.event).find(row => row?.type === type);
    if (event) return { socket, event };
    await sleep(100);
  }
  throw new Error('Official WebSocket follow did not receive ' + type + ' on ' + id);
}async function waitForProduct(host, { control = true, recovery = true, verifier = true } = {}) {
  const until=Date.now()+20000;
  while(Date.now()<until){
    const snapshot=await host.probe('snapshot');
    if((!control||snapshot.productControl)&&(!recovery||snapshot.productRecovery)&&(!verifier||snapshot.productRouteVerifier)) return snapshot;
    await sleep(100);
  }
  const snapshot=await host.probe('snapshot');
  throw new Error('Product entries did not become active: '+JSON.stringify(snapshot.entries.filter(entry=>entry.id.startsWith('grok-search'))));
}
// The aggregate bundle prepares and identity-checks the program asynchronously;
// a query before `ready` correctly fails closed, so M0-04 waits for it.
async function waitForProgram(host, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  let snapshot = null;
  while (Date.now() < until) {
    snapshot = await host.probe('snapshot');
    const phase = snapshot.productProgram?.phase;
    if (phase === 'ready') return snapshot;
    if (phase === 'error') throw new Error('Grok program preparation failed: ' + JSON.stringify(snapshot.productProgram.error));
    await sleep(100);
  }
  throw new Error('Grok program did not become ready: ' + JSON.stringify(snapshot?.productProgram ?? null));
}
async function preserved(host){
 const snapshot=await host.probe('snapshot');assert.equal(snapshot.runtimeWeb.fetchProviderId,'candidate-fetch');
 assert.equal(snapshot.existingDependencyPresent,true);assert.ok(Object.hasOwn(snapshot.webInject,'candidateExistingDependency'));
 return snapshot;
}
async function prepare(runtime,folder,m004BudgetMs=120000){
 if(verificationCase==='m0-04'&&!grokStub)grokStub=await startGrokResponsesStub(grokKey);
 const args=[join(project,'scripts/deferred-release-desktop-prepare.mjs'),'--desktop',runtime.executable,
   '--run-root',folder,'--control-record-mode','versioned',...(['product','m0-04','ux'].includes(verificationCase)?['--entry-mode',verificationCase]:[]),...(verificationCase==='m0-04'?['--m004-budget',String(m004BudgetMs),
     '--grok-program',options.get('--grok-program'),'--grok-responses-url',grokStub.baseUrl,'--grok-key',grokKey]:[])];
 const execution=await commandResult(process.execPath,args,{cwd:project,timeoutMs:120000,sanitize});
 writeJson(join(directory,runtime.app.version+'-'+(++serial)+'-prepare.json'),receipt(execution));
 assert.equal(execution.exitCode,0,execution.stderr);assert.equal(execution.timedOut,false);
 const result=JSON.parse(execution.rawStdout);assert.equal(result.dependencyInstall,false);assert.equal(result.originalAsarUnmodified,true);
 if(verificationCase==='m0-04'){assert.equal(result.grokProgramValidation?.version,'0.1.26');assert.equal(result.grokProgramValidation.configIsolated,true);}
 preparationResults.push({version:runtime.app.version,macAppBundleValidation:result.macAppBundleValidation??null,
   grokProgramValidation:result.grokProgramValidation??null});
}
async function migrateProfile(folder) {
  const profile=join(folder,'dsh-home/profiles/desktop');
  const inspected=await commandResult(process.execPath,[join(project,'scripts/b2-control-migrate.mjs'),'--profile',profile,'--mode','inspect'],{cwd:project,timeoutMs:20000,sanitize});
  writeJson(join(directory,'migration-inspect-'+(++serial)+'.json'),receipt(inspected));assert.equal(inspected.exitCode,0,inspected.stderr);
  const inspection=JSON.parse(inspected.rawStdout),operationId=randomUUID();
  const args=[join(project,'scripts/b2-control-migrate.mjs'),'--profile',profile,'--mode','migrate','--expected-revision','0','--expected-sha256',inspection.sourceSha256,'--operation-id',operationId];
  const execution=await commandResult(process.execPath,args,{cwd:project,timeoutMs:20000,sanitize});
  writeJson(join(directory,'migration-commit-'+(++serial)+'.json'),receipt(execution));assert.equal(execution.exitCode,0,execution.stderr);
  const repeated=await commandResult(process.execPath,args,{cwd:project,timeoutMs:20000,sanitize});
  writeJson(join(directory,'migration-repeat-'+(++serial)+'.json'),receipt(repeated));assert.equal(repeated.exitCode,0,repeated.stderr);
  const result=JSON.parse(execution.rawStdout),again=JSON.parse(repeated.rawStdout);
  assert.equal(result.kind,'migrated');assert.equal(result.authorizationEstablished,false);assert.equal(result.routeChanged,false);
  assert.equal(again.kind,'already-migrated');assert.equal(again.recordCommitted,false);
  return {inspection,result,again};
}
async function seedPending(runtime,folder){
 await prepare(runtime,folder);const initial=await start(runtime,folder,'selected-owner');const before=store(folder).read();
 assert.equal(before.revision,1);assert.equal(before.intent.lease.hostId,initial.initial.instanceId);
 await initial.probe('upstream-failure',{enabled:true});const failure=await initial.probe('seam');
 const failedModel=await modelTurn(initial,'search');assert.equal(failedModel.isError,true);assert.equal(failedModel.afterCalls.original,0);
 assert.equal(failure.ok,false);assert.equal(failure.error.code,'CONTROLLED_UPSTREAM_ERROR');assert.equal(failure.calls.original,0);
 await initial.probe('upstream-failure',{enabled:false});
 const disposed=await initial.probe('dispose-owner');assert.deepEqual(disposed.recordEnvelope,before);
 const error=await initial.probe('seam');assert.equal(error.ok,false);assert.equal(error.error.code,'WEB_PROVIDER_CONFIGURED_MISSING');assert.equal(error.calls.original,0);
 const pendingModel=await modelTurn(initial,'search');
 writeJson(join(directory,initial.prefix+'-ordinary-dispose-model.json'),safe(pendingModel));
 assert.equal(pendingModel.afterCalls.original,0);
 assert.equal(pendingModel.controlState.recordEnvelope.intent.policy,'required');
 assert.equal(pendingModel.controlState.recordEnvelope.intent.release,null);
 if(pendingModel.isError)assert.ok(pendingModel.text.includes('需要完整退出并重启宿主才能完成退出'));
 else {
   assert.equal(pendingModel.controlState.ownerPresent,true);
   assert.ok(pendingModel.controlState.selectedBundles.includes('candidate-controlled-search'));
   assert.ok(pendingModel.afterCalls.grok>pendingModel.beforeCalls.grok);
   assert.equal(pendingModel.controlState.recordEnvelope.intent.acquisition.source,'current-selected-search-bundle');
   assert.equal(pendingModel.controlState.recordEnvelope.intent.lease.hostId,before.intent.lease.hostId);
 }
 const fetch=await modelTurn(initial,'fetch'),echo=await modelTurn(initial,'echo'),chat=await modelTurn(initial,'chat');assert.equal(fetch.isError,false);assert.equal(echo.isError,false);assert.equal(chat.isError,false);
 await preserved(initial);const exit=await close(initial);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);
 const finalPending=store(folder).read();
 assert.equal(finalPending.intent.policy,'required');assert.equal(finalPending.intent.release,null);
 assert.equal(finalPending.intent.lease.hostId,before.intent.lease.hostId);
 assert.ok(finalPending.revision>=before.revision);
 let ancestor=finalPending.intent,originalPreserved=false;
 for(let depth=0;ancestor&&depth<64;depth++,ancestor=ancestor.priorIntent) {
   if(JSON.stringify(ancestor)===JSON.stringify(before.intent)){originalPreserved=true;break;}
 }
 assert.equal(originalPreserved,true);
 return{before:finalPending,originalBeforeShutdown:before,shutdownAppendedRequiredRevision:finalPending.revision!==before.revision,
   failure,failedModel,disposed,error,pendingModel,fetch,echo,chat,exit};
}
async function scenario(runtime,name,work){
 const folder=join(temporary,runtime.app.version+'-'+name);const evidence={version:runtime.app.version,scenario:name};
 try{Object.assign(evidence,await work(folder),{status:'pass'});}catch(error){Object.assign(evidence,{status:'fail',error:{message:error.message,stack:error.stack}});}
 results.push(evidence);writeJson(join(directory,runtime.app.version+'-'+name+'.json'),safe(evidence));
 if(evidence.status!=='pass')throw new Error(evidence.error.message);
}
let fatal=null;
try{
 for(const runtime of runtimes){
  if (verificationCase === 'ux') {
    await scenario(runtime, 'native-hmr-toggle-and-reacquire', async folder => {
      await prepare(runtime, folder);
      const host = await start(runtime, folder, 'ux-hmr');
      await waitForProduct(host, { recovery: true, verifier: true });
      const initial = await preserved(host);
      assert.equal(initial.runtimeWeb.searchProviderId, 'grok-search');
      const manager = await host.probe('plugin-manager-state');
      assert.equal(manager.plugins.length, 1);
      assert.equal(manager.plugins[0].moduleName, 'dsh-grok-search');
      const blocked = await modelTurn(host, 'search');
      assert.equal(blocked.isError, true);
      assert.equal(blocked.afterCalls.original, 0);
      const disabled = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: false });
      assert.equal(disabled.application, 'applied', JSON.stringify(disabled));
      const restored = await preserved(host);
      assert.equal(restored.runtimeWeb.searchProviderId, 'candidate-original');
      assert.equal(restored.productControl, null);
      assert.equal(restored.record.releaseCompletion?.routeVerified, true);
      const original = await modelTurn(host, 'search');
      assert.equal(original.isError, false);
      const enabled = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: true });
      assert.equal(enabled.application, 'applied', JSON.stringify(enabled));
      await waitForProduct(host, { recovery: true, verifier: true });
      const reacquired = await preserved(host);
      assert.equal(reacquired.runtimeWeb.searchProviderId, 'grok-search');
      assert.equal(reacquired.record.policy, 'required');
      const blockedAgain = await modelTurn(host, 'search');
      assert.equal(blockedAgain.isError, true);
      assert.equal(blockedAgain.afterCalls.original, original.afterCalls.original);
      const fetch = await modelTurn(host, 'fetch');
      const chat = await modelTurn(host, 'chat');
      assert.equal(fetch.isError, false);
      assert.equal(chat.isError, false);
      const exit = await close(host);
      assert.equal(exit.exitCode, 0);
      assert.equal(exit.forced, false);
      return { initial, manager, blocked, disabled, restored, original, enabled, reacquired, blockedAgain, fetch, chat, exit };
    });
    await scenario(runtime, 'sources-only-shared-budget-and-native-stop', async folder => {
      const requests = [];
      let invalidFirstSource = false;
      const server = createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { if (body.length < 65536) body += chunk; });
        request.on('end', () => {
          const tavily = request.url === '/tavily/search';
          const valid = request.method === 'POST' && (tavily
            ? request.headers.authorization === 'Bearer tavily-offline-synthetic-key'
            : request.url === '/search' && request.headers['x-api-key'] === 'exa-offline-synthetic-key');
          requests.push({ valid, method: request.method, path: request.url, bodyLength: body.length });
          response.writeHead(valid ? 200 : 400, { 'content-type': 'application/json' });
          response.end(valid ? JSON.stringify({ results: [{
            url: invalidFirstSource && !tavily ? 'https://[invalid-source'
              : tavily ? 'https://example.invalid/source-failover' : 'https://example.invalid/source-budget', title: '隔离补充来源',
            summary: '来源内容'.repeat(20000),
          }] }) : '{}');
        });
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      try {
        await prepare(runtime, folder);
        const profile = join(folder, 'dsh-home/profiles/desktop');
        const grokFolder = join(profile, 'grok-search');
        mkdirSync(grokFolder, { recursive: true });
        writeFileSync(join(grokFolder, 'preferences.json'), JSON.stringify({
          schemaVersion: 1, grokEnabled: false, githubEnabled: true,
          sourceOrder: ['tavily', 'exa', 'tinyfish', 'firecrawl'],
          sourceEnabled: { tavily: true, exa: true, tinyfish: true, firecrawl: true },
        }) + '\n', { flag: 'wx' });
        const configPath = join(folder, 'isolated-grok.toml');
        writeFileSync(configPath, [
          'source_providers = ["exa", "tavily"]',
          'exa_enabled = true',
          `exa_api_url = "http://127.0.0.1:${server.address().port}"`,
          'exa_api_key = "exa-offline-synthetic-key"',
          `tavily_api_url = "http://127.0.0.1:${server.address().port}/tavily"`,
          'tavily_api_key = "tavily-offline-synthetic-key"',
          'tavily_enabled = true',
          'response_max_chars = 5000',
          '',
        ].join('\n'), { flag: 'wx', mode: 0o600 });
        const host = await start(runtime, folder, 'ux-sources-only');
        await waitForProduct(host, { recovery: true, verifier: true });
        const fallback = await modelTurn(host, 'search');
        assert.equal(fallback.isError, false);
        assert.equal(fallback.afterCalls.original, 0);
        // The official Session tool formats Markdown and omits meta from the
        // persisted message. Assert the actual per-query public web seam, not
        // a made-up JSON envelope around the formatter's model-facing text.
        assert.match(fallback.text, /example\.invalid\/source-budget/);
        const output = await host.probe('product-query-result');
        const encoded = JSON.stringify(output);
        assert.ok(encoded.length <= 5000);
        assert.equal(output.sources[0].url, 'https://example.invalid/source-budget');
        assert.equal(output.truncated, true);
        assert.equal(output.content, '');
        assert.ok(requests.length > 0 && requests.every(row => row.valid));
        invalidFirstSource = true;
        const failoverStart = requests.length;
        const recovered = await host.probe('product-query-result');
        assert.equal(recovered.sources[0]?.url, 'https://example.invalid/source-failover');
        assert.deepEqual(requests.slice(failoverStart).map(row => row.path), ['/search', '/tavily/search']);
        assert.equal((await host.probe('snapshot')).calls.original, 0);
        // Corrupting a live shared config is not an explicit release. The next
        // search must fail and must not reach either fallback HTTP or official.
        const requestsBeforeCorruption = requests.length;
        writeFileSync(configPath, 'exa_api_key = invalid-TOML\n');
        const broken = await modelTurn(host, 'search');
        assert.equal(broken.isError, true);
        assert.equal(broken.afterCalls.original, 0);
        assert.equal(requests.length, requestsBeforeCorruption);
        const disabled = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: false });
        assert.equal(disabled.application, 'applied');
        const restored = await preserved(host);
        assert.equal(restored.runtimeWeb.searchProviderId, 'candidate-original');
        const original = await modelTurn(host, 'search');
        assert.equal(original.isError, false);
        assert.equal(requests.length, requestsBeforeCorruption);
        const fetch = await modelTurn(host, 'fetch'), chat = await modelTurn(host, 'chat');
        assert.equal(fetch.isError, false); assert.equal(chat.isError, false);
        const exit = await close(host);
        assert.equal(exit.exitCode, 0); assert.equal(exit.forced, false);
        return { fallback, broken, disabled, restored, original, fetch, chat, requests, exit,
          sharedResultBudget: 5000, serializedToolResultChars: encoded.length,
          sourceOnlyValidated: true, invalidSourceUrlFailoverValidated: true,
          corruptConfigFailClosed: true, realUpstreamValidated: false };
      } finally { await new Promise(resolve => server.close(resolve)); }
    });
    await scenario(runtime, 'aggregated-canonical-counter-and-reload-transition', async folder => {
      const stub = await startDeepseekSearchStub();
      try {
        await prepare(runtime, folder);
        writeFileSync(join(folder, 'dsh-home/profiles/desktop/cordis.patch.yml'), JSON.stringify([
          { id: 'web-search-deepseek', disabled: false, config: {
            apiKey: 'offline-test-sentinel-not-a-real-key', baseURL: stub.baseURL,
            model: 'fixture-search', maxTokens: 1, maxUses: 1,
          } },
          { id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'candidate-fetch' } },
        ], null, 2) + '\n');
        const host = await start(runtime, folder, 'ux-canonical-reload', null, true, false);
        await waitForProduct(host, { recovery: true, verifier: true });
        await authenticateModel(host);
        const session = await host.rpc('session/create', { cwd: host.control.workspace });
        const reloaded = await host.probe('reload-web-with-session-search', {
          origin: host.address.hostOrigin, cookie: host.cookie, sessionId: session.sessionId,
          requestId: 'ux-reload-' + randomUUID(),
        });
        assert.equal(reloaded.reloadProbe.overlappedReload, true);
        assert.equal(reloaded.reloadProbe.toolResult?.isError, true);
        assert.equal(reloaded.originalSearchCounter.source, 'dsh-session/web-deepseek-search-llm-request');
        assert.equal(reloaded.originalSearchCounter.calls, 0);
        assert.equal(stub.requests.length, 0);
        assert.equal(reloaded.runtimeWeb.searchProviderId, 'grok-search');
        // Keep the observer loaded for a positive control of the real official
        // provider. Then separately verify native bundle teardown with that
        // canonical observer, not the fixture's original-provider counter.
        const stopped = await host.probe('product-stop', { reason: 'canonical-positive-control' });
        assert.equal(stopped.productStopOutcome.kind, 'released');
        assert.equal(stopped.runtimeWeb.searchProviderId, 'deepseek-official');
        const baseline = stopped.originalSearchCounter.calls;
        const official = await modelTurnOnSession(host, 'search', session.sessionId);
        assert.equal(official.isError, false);
        const observed = await host.probe('snapshot');
        assert.ok(observed.originalSearchCounter.calls > baseline);
        assert.ok(stub.requests.length > 0);
        const disabled = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: false });
        assert.equal(disabled.application, 'applied');
        const enabled = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: true });
        assert.equal(enabled.application, 'applied');
        await waitForProduct(host, { recovery: true, verifier: true });
        const requestsBeforeDisable = stub.requests.length;
        const finalDisable = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: false });
        assert.equal(finalDisable.application, 'applied');
        const released = store(folder).read();
        assert.equal(released.intent.policy, 'released');
        assert.equal(released.intent.releaseCompletion.routeVerified, true);
        assert.equal(released.intent.releaseCompletion.routeEvidence.counterSource, 'dsh-session/web-deepseek-search-llm-request');
        assert.equal(released.intent.releaseCompletion.routeEvidence.originalSearchDelta, 0);
        assert.equal(stub.requests.length, requestsBeforeDisable);
        const restored = await host.probe('snapshot');
        assert.equal(restored.runtimeWeb.searchProviderId, 'deepseek-official');
        assert.equal(restored.runtimeWeb.fetchProviderId, 'candidate-fetch');
        const exit = await close(host);
        assert.equal(exit.exitCode, 0);
        assert.equal(exit.forced, false);
        return { reloaded, stopped, official, observed, disabled, enabled, finalDisable, released,
          restored, requestCount: stub.requests.length, exit };
      } finally { await stub.close(); }
    });
    if (runtime.app.version === '0.2.2-rc.1') {
      await scenario(runtime, 'deepseek-search-api-takeover-and-native-restore', async folder => {
        let requests = 0;
        const server = createServer((request, response) => {
          request.resume();
          request.on('end', () => {
            assert.equal(request.url, '/v1/tools/search');
            requests++;
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ results: [{ url: 'https://example.invalid/deepseek-api',
              title: 'Official API fixture', snippet: 'Isolated search API result', date: null }] }));
          });
        });
        await new Promise(done => server.listen(0, '127.0.0.1', done));
        try {
          await prepare(runtime, folder);
          writeFileSync(join(folder, 'dsh-home/profiles/desktop/cordis.patch.yml'), JSON.stringify([
            { id: 'web-deepseek-api', config: { apiKey: 'isolated-search-api-key',
              baseURL: `http://127.0.0.1:${server.address().port}/v1/tools` } },
            { id: 'web', config: { searchProvider: 'deepseek-search-api', fetchProvider: 'candidate-fetch' } },
          ]) + '\n');
          const host = await start(runtime, folder, 'ux-search-api', null, true, false);
          await waitForProduct(host, { recovery: true, verifier: true });
          const blocked = await modelTurn(host, 'search');
          assert.equal(blocked.isError, true);
          assert.equal(requests, 0);
          await host.probe('rebuild-web-from-author');
          await waitForProduct(host);
          assert.equal((await host.probe('snapshot')).runtimeWeb.searchProviderId, 'grok-search');
          const blockedAfterReload = await modelTurn(host, 'search');
          assert.equal(blockedAfterReload.isError, true);
          assert.equal(requests, 0);
          const disabled = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: false });
          assert.equal(disabled.application, 'applied');
          const restored = await preserved(host);
          assert.equal(restored.runtimeWeb.searchProviderId, 'deepseek-search-api');
          const original = await modelTurn(host, 'search');
          assert.equal(original.isError, false);
          assert.equal(requests, 1);
          const enabled = await host.probe('plugin-manager-set-bundle', { name: 'dsh-grok-search', enabled: true });
          assert.equal(enabled.application, 'applied');
          await waitForProduct(host);
          assert.equal((await modelTurn(host, 'search')).isError, true);
          assert.equal(requests, 1);
          assert.equal((await modelTurn(host, 'fetch')).isError, false);
          const exit = await close(host);
          assert.equal(exit.exitCode, 0);
          assert.equal(exit.forced, false);
          return { requests, originalSearchCounterScope: 'legacy-session-event-only',
            directApiHttpCountVerified: true, blocked, blockedAfterReload, restored, original, exit };
        } finally { await new Promise(done => server.close(done)); }
      });
    }
    continue;
  }
  if (verificationCase === 'product') {
    await scenario(runtime, 'config-reload-transition-no-official-fallback', async folder => {
      const stub = await startDeepseekSearchStub();
      try {
        await prepare(runtime, folder);
        const profile = join(folder, 'dsh-home/profiles/desktop');
        writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
          { id: 'web-search-deepseek', disabled: false, config: {
            apiKey: 'offline-test-sentinel-not-a-real-key', baseURL: stub.baseURL,
            model: 'fixture-search', maxTokens: 1, maxUses: 1,
          } },
          { id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'candidate-fetch' } },
        ], null, 2) + '\n');
        const host = await start(runtime, folder, 'reload-transition', null, true, false);
        await waitForProduct(host, { recovery: true, verifier: true });
        await authenticateModel(host);
        const session = await host.rpc('session/create', { cwd: host.control.workspace });
        const state = await host.probe('reload-web-with-session-search', {
          origin: host.address.hostOrigin, cookie: host.cookie, sessionId: session.sessionId,
          requestId: 'reload-search-' + randomUUID(),
        });
        writeJson(join(directory, runtime.app.version + '-config-reload-transition.json'),
          safe({ requests: stub.requests, state }));
        assert.equal(stub.requests.length, 0, 'Official provider was called during config reload.');
        assert.equal(state.originalSearchCounter.calls, 0);
        assert.equal(state.runtimeWeb.searchProviderId, 'grok-search');
        assert.equal(state.reloadProbe.overlappedReload, true, 'Search tool call did not overlap the web reload.');
        assert.ok(state.reloadProbe.toolResult);
        if (state.reloadProbe.toolResult.isError) {
          if (runtime.app.version === '0.2.2-rc.1' && state.reloadProbe.toolErrorCode === 'UNKNOWN_TOOL') {
            // Per-step admission cannot retain the tool definition after its
            // owning WebRuntime unloads. The new host refuses this in-flight
            // call; it must not substitute the newly registered definition.
            assert.match(JSON.stringify(state.reloadProbe.toolResult), /unknown tool.*web_search/i);
            const next = await modelTurn(host, 'search');
            assert.equal(next.afterCalls.original, 0);
            assert.equal(next.toolResult?.isError, true);
            assert.doesNotMatch(JSON.stringify(next.toolResult), /unknown tool/i);
          } else assert.match(JSON.stringify(state.reloadProbe.toolResult), /CONTROL_|WEB_PROVIDER_|Grok/i);
        }
        const exit = await close(host);
        assert.equal(exit.exitCode, 0);
        assert.equal(exit.forced, false);
        return { requests: stub.requests, reloadProbe: state.reloadProbe, runtimeWeb: state.runtimeWeb, exit };
      } finally {
        await stub.close();
      }
    });
    await scenario(runtime, 'canonical-counter-real-official-provider-path', async folder => {
      const stub = await startDeepseekSearchStub();
      try {
        await prepare(runtime, folder);
        const profile = join(folder, 'dsh-home/profiles/desktop');
        writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
          { id: 'web-search-deepseek', disabled: false, config: {
            apiKey: 'offline-test-sentinel-not-a-real-key', baseURL: stub.baseURL,
            model: 'fixture-search', maxTokens: 1, maxUses: 1,
          } },
          { id: 'web', config: { searchProvider: 'deepseek-official', fetchProvider: 'candidate-fetch' } },
        ], null, 2) + '\n');
        const host = await start(runtime, folder, 'official-counter', null, true, false);
        // D-28 single bundle: the route verifier and its canonical counter ship in the product
        // bundle, so the official provider path is exercised after an explicit stop returns the
        // author route while the bundle stays selected.
        await waitForProduct(host);
        const required = await host.probe('retry-product-control');
        assert.equal(required.productControl.phase, 'required');
        assert.equal(required.runtimeWeb.searchProviderId, 'grok-search');
        const stopped = await host.probe('product-stop', { reason: 'explicit-product-release' });
        writeJson(join(directory, runtime.app.version + '-canonical-stop-state.json'), safe(stopped));
        const stopOutcome = stopped.productStopOutcome ?? stopped.productControl.releaseOutcome;
        assert.equal(stopped.productControl.phase, 'released');
        assert.equal(stopOutcome.kind, 'released');
        assert.equal(stopOutcome.routeVerified, true);
        assert.equal(stopped.runtimeWeb.searchProviderId, 'deepseek-official');
        assert.equal(stopped.runtimeWeb.fetchProviderId, 'candidate-fetch');
        assert.equal(stub.requests.length, 0, 'Official provider was called before the explicit stop completed.');
        const baseline = stopped.originalSearchCounter;
        assert.equal(baseline.source, 'dsh-session/web-deepseek-search-llm-request');
        const released = store(folder).read();
        // Restoring the web route restarts the control fiber; the bundled recovery entry must
        // leave a release committed by this process to the owner's own release task (D-28).
        assert.equal(released.intent.policy, 'released');
        assert.equal(released.intent.release.explicit, true);
        assert.equal(released.intent.releaseCompletion.releaseOperationId, stopOutcome.operationId);
        assert.equal(released.intent.releaseCompletion.recordCommit.kind, 'explicit-release-completion');
        assert.equal(released.intent.recovery, undefined);
        assert.equal(released.intent.releaseCompletion.routeVerified, true);
        assert.equal(released.intent.releaseCompletion.routeEvidence.counterSource,
          'dsh-session/web-deepseek-search-llm-request');
        assert.equal(released.intent.releaseCompletion.routeEvidence.originalSearchDelta, 0);
        await authenticateModel(host);
        const session = await host.rpc('session/create', { cwd: host.control.workspace });
        host.modelSession = session.sessionId;
        const result = await modelTurnOnSession(host, 'search', session.sessionId);
        assert.equal(result.isError, false);
        const state = await host.probe('snapshot');
        assert.ok(stub.requests.length > 0);
        assert.equal(state.runtimeWeb.searchProviderId, 'deepseek-official');
        assert.ok(state.originalSearchCounter);
        assert.equal(state.originalSearchCounter.source, 'dsh-session/web-deepseek-search-llm-request');
        assert.equal(state.originalSearchCounter.eventType, 'web/deepseek-search-llm-request');
        assert.ok(state.originalSearchCounter.calls > baseline.calls);
        const recheck = await host.probe('retry-product-recovery');
        assert.equal(recheck.productRecovery.phase, 'still-selected');
        assert.deepEqual(store(folder).read(), released);
        const exit = await close(host);
        assert.equal(exit.exitCode, 0);
        assert.equal(exit.forced, false);
        return { requestCount: stub.requests.length, baseline, counter: state.originalSearchCounter,
          stopOutcome, released, recoveryPhaseAfterStop: state.productRecovery?.phase ?? null,
          recheck: recheck.productRecovery, result, exit };
      } finally {
        await stub.close();
      }
    });
    await scenario(runtime, 'product-entry-and-record', async folder => {
      await prepare(runtime, folder);
      const host = await start(runtime, folder, 'product-entry');
      await waitForProduct(host);
      await preserved(host);
      const snapshot = await host.probe('retry-product-control');
      await host.probe('retry-product-recovery');
      const state = await host.probe('snapshot');
      assert.ok(state.productControl);
      assert.ok(state.productRecovery);
      assert.equal(state.productControl.phase, 'required');
      assert.equal(state.productRecovery.phase, 'still-selected');
      const record = store(folder).read();
      assert.equal(record.revision, 1);
      assert.equal(record.intent.policy, 'required');
      assert.equal(record.intent.release, null);
      assert.equal(record.intent.acquisition.source, 'current-selected-search-bundle');
      assert.equal(record.intent.acquisition.searchBundle, 'dsh-grok-search');
      assert.equal(record.intent.lease.provider, 'grok-search');
      assert.equal(state.productControl.hostId, record.intent.lease.hostId);
      assert.equal(state.runtimeWeb.searchProviderId, 'grok-search');
      assert.equal(state.runtimeWeb.fetchProviderId, 'candidate-fetch');
      assert.equal(state.existingDependencyPresent, true);
      assert.ok(state.runtimeWeb.searchProviders.includes('grok-search'));
      const fetch = await modelTurn(host, 'fetch');
      const chat = await modelTurn(host, 'chat');
      writeJson(join(directory, runtime.app.version + '-product-entry-fetch.json'), safe(fetch));
      assert.equal(fetch.isError, false);
      const disposed = await host.probe('dispose-product-control');
      assert.equal(disposed.productControl, null);
      const afterDispose = store(folder).read();
      assert.equal(afterDispose.intent.policy, 'required');
      assert.equal(afterDispose.intent.release, null);
      writeJson(join(directory, runtime.app.version + '-product-entry-chat.json'), safe(chat));
      assert.equal(chat.isError, false);
      const exit = await close(host);
      assert.equal(exit.exitCode, 0);
      assert.equal(exit.forced, false);
      const final = store(folder).read();
      assert.equal(final.intent.policy, 'required');
      assert.equal(final.intent.release, null);
      return { snapshot, state, record, fetch, chat, disposed, afterDispose, exit, final };
    });
    await scenario(runtime, 'product-owner-explicit-release', async folder => {
      await prepare(runtime, folder);
      const host = await start(runtime, folder, 'product-release-owner');
      await waitForProduct(host);
      const requiredState = await host.probe('retry-product-control');
      writeJson(join(directory, runtime.app.version + '-product-entry-required.json'), safe(requiredState));
      await preserved(host);
      assert.equal(requiredState.productControl.phase, 'required');
      assert.equal(requiredState.runtimeWeb.searchProviderId, 'grok-search');
      const before = store(folder).read();
      const releasedState = await host.probe('product-stop', { reason: 'explicit-product-release' });
      writeJson(join(directory, runtime.app.version + '-product-release-state.json'), safe(releasedState));
      const releaseOutcome = releasedState.productStopOutcome ?? releasedState.productControl.releaseOutcome;
      assert.equal(releasedState.productControl.phase, 'released');
      assert.equal(releaseOutcome.kind, 'released');
      assert.equal(releaseOutcome.routeChanged, true);
      assert.equal(releaseOutcome.routeVerified, true);
      assert.equal(releasedState.runtimeWeb.searchProviderId, 'candidate-original');
      assert.equal(releasedState.runtimeWeb.fetchProviderId, 'candidate-fetch');
      assert.equal(releasedState.existingDependencyPresent, true);
      const after = store(folder).read();
      assert.equal(after.revision, before.revision + 2);
      assert.equal(after.intent.policy, 'released');
      assert.equal(after.intent.release.explicit, true);
      assert.equal(after.intent.releaseCompletion.recordCommit.kind, 'explicit-release-completion');
      assert.equal(after.intent.recovery, undefined);
      assert.equal(typeof after.intent.releaseCompletion.routeChanged, 'boolean');
      assert.equal(after.intent.releaseCompletion.routeVerified, true);
      assert.equal(after.intent.priorIntent.policy, 'required');
      const fetch = await modelTurn(host, 'fetch');
      const chat = await modelTurn(host, 'chat');
      const authorSearch = await modelTurn(host, 'search');
      assert.equal(fetch.isError, false);
      assert.equal(chat.isError, false);
      assert.equal(authorSearch.isError, false);
      assert.ok(authorSearch.afterCalls.original > authorSearch.beforeCalls.original);
      assert.equal(authorSearch.afterCalls.grok, authorSearch.beforeCalls.grok);
      const exit = await close(host);
      assert.equal(exit.exitCode, 0);
      assert.equal(exit.forced, false);
      const restarted = await start(runtime, folder, 'product-release-restart');
      // D-29: the native PluginManager switch is the only user stop entry and a
      // release is no longer remembered permanently. A full restart with the
      // bundle still selected is a new current-selection takeover: one new
      // required revision whose prior intent is the completed release.
      await waitForProduct(restarted);
      const restartedState = await restarted.probe('retry-product-control');
      assert.equal(restartedState.productControl.phase, 'required');
      assert.equal(restartedState.recordEnvelope.revision, after.revision + 1);
      assert.equal(restartedState.recordEnvelope.intent.policy, 'required');
      assert.equal(restartedState.recordEnvelope.intent.release, null);
      assert.equal(restartedState.recordEnvelope.intent.acquisition.source, 'current-selected-search-bundle');
      assert.equal(restartedState.recordEnvelope.intent.priorIntent.policy, 'released');
      assert.equal(restartedState.recordEnvelope.intent.priorIntent.release.operationId, after.intent.release.operationId);
      assert.notEqual(restartedState.recordEnvelope.intent.lease.hostId, after.intent.lease.hostId);
      assert.equal(restartedState.runtimeWeb.searchProviderId, 'grok-search');
      assert.equal(restartedState.runtimeWeb.fetchProviderId, 'candidate-fetch');
      assert.equal(restartedState.existingDependencyPresent, true);
      const restartFetch = await modelTurn(restarted, 'fetch');
      const restartChat = await modelTurn(restarted, 'chat');
      const restartSearch = await modelTurn(restarted, 'search');
      assert.equal(restartFetch.isError, false);
      assert.equal(restartChat.isError, false);
      // The program is intentionally unconfigured here: the retaken route must
      // fail closed and never dispatch the author's original provider.
      assert.equal(restartSearch.isError, true);
      assert.equal(restartSearch.afterCalls.original, restartSearch.beforeCalls.original);
      const restartExit = await close(restarted);
      assert.equal(restartExit.exitCode, 0);
      assert.equal(restartExit.forced, false);
      return { requiredState, before, releasedState, after, fetch, chat, authorSearch, exit, restartedState, restartFetch, restartChat, restartSearch, restartExit };
    });
    // D-28 single bundle: deselecting the product removes every entry, including recovery.
    // A full restart must return the author route, keep fetch/dependencies, and leave the
    // record as a pending history without any executor rewriting it.
    await scenario(runtime, 'product-deselect-restores-author-without-executor', async folder => {
      await prepare(runtime, folder);
      const first = await start(runtime, folder, 'product-selected');
      await first.probe('retry-product-control');
      const before = store(folder).read();
      assert.equal(before.intent.policy, 'required');
      const firstExit = await close(first);
      assert.equal(firstExit.exitCode, 0);
      assert.equal(firstExit.forced, false);
      selectionProduct(folder, false);
      const deselected = await start(runtime, folder, 'product-deselected');
      await preserved(deselected);
      const state = await deselected.probe('snapshot');
      assert.equal(state.productControl, null);
      assert.equal(state.productRecovery, null);
      assert.equal(state.productRouteVerifier, null);
      assert.equal(state.runtimeWeb.searchProviderId, 'candidate-original');
      assert.equal(state.runtimeWeb.fetchProviderId, 'candidate-fetch');
      assert.deepEqual(store(folder).read(), before);
      const authorSearch = await modelTurn(deselected, 'search');
      const fetch = await modelTurn(deselected, 'fetch');
      const chat = await modelTurn(deselected, 'chat');
      assert.equal(authorSearch.isError, false);
      assert.ok(authorSearch.afterCalls.original > authorSearch.beforeCalls.original);
      assert.equal(authorSearch.afterCalls.grok, authorSearch.beforeCalls.grok);
      assert.equal(fetch.isError, false);
      assert.equal(chat.isError, false);
      assert.deepEqual(store(folder).read(), before);
      const exit = await close(deselected);
      assert.equal(exit.exitCode, 0);
      assert.equal(exit.forced, false);
      return { before, firstExit, state, authorSearch, fetch, chat, exit };
    });
    // D-28 + D-26: re-selecting the bundle re-establishes the current takeover intent from the
    // pending record, and the canonical Session counter proves no official dispatch while active.
    await scenario(runtime, 'product-reselect-retakes-with-canonical-counter', async folder => {
      await prepare(runtime, folder);
      const first = await start(runtime, folder, 'product-canonical-baseline');
      await first.probe('retry-product-control');
      const before = store(folder).read();
      const firstExit = await close(first);
      assert.equal(firstExit.exitCode, 0);
      assert.equal(firstExit.forced, false);
      selectionProduct(folder, false);
      const deselected = await start(runtime, folder, 'product-canonical-deselected', null, true, false);
      const deselectedState = await deselected.probe('snapshot');
      assert.equal(deselectedState.productControl, null);
      assert.equal(deselectedState.runtimeWeb.searchProviderId, 'candidate-original');
      const deselectedExit = await close(deselected);
      assert.equal(deselectedExit.exitCode, 0);
      assert.equal(deselectedExit.forced, false);
      const path = join(folder, 'dsh-home/profiles/desktop/package.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      value.dsh.profile.bundles = [...value.dsh.profile.bundles, 'dsh-grok-search'];
      writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
      const reselected = await start(runtime, folder, 'product-canonical-reselected', null, true, false);
      await waitForProduct(reselected);
      await preserved(reselected);
      const state = await reselected.probe('retry-product-control');
      assert.equal(state.productControl.phase, 'required');
      assert.equal(state.runtimeWeb.searchProviderId, 'grok-search');
      const recovery = await reselected.probe('retry-product-recovery');
      assert.equal(recovery.productRecovery.phase, 'still-selected');
      const after = store(folder).read();
      assert.equal(after.intent.policy, 'required');
      assert.equal(after.intent.release, null);
      assert.deepEqual(after.intent.priorIntent, before.intent);
      assert.notEqual(after.intent.lease.hostId, before.intent.lease.hostId);
      const counter = recovery.originalSearchCounter;
      assert.equal(counter.source, 'dsh-session/web-deepseek-search-llm-request');
      const fetch = await modelTurn(reselected, 'fetch');
      const chat = await modelTurn(reselected, 'chat');
      assert.equal(fetch.isError, false);
      assert.equal(chat.isError, false);
      const counterAfter = (await reselected.probe('snapshot')).originalSearchCounter;
      assert.equal(counterAfter.calls, counter.calls);
      const exit = await close(reselected);
      assert.equal(exit.exitCode, 0);
      assert.equal(exit.forced, false);
      return { before, firstExit, deselectedState, state, after, counter, counterAfter, fetch, chat, exit };
    });
    continue;
  }
  if (verificationCase === 'm0-04') {
    await scenario(runtime, 'multi-session-ptc-restart', async folder => {
      await prepare(runtime, folder);
      let host = await start(runtime, folder, 'm0-04-initial');
      await waitForProduct(host);
      const initial = await waitForProgram(host);
      assert.equal(initial.runtimeWeb.searchProviderId, 'grok-search');
      assert.equal(initial.productProgram.program.version, '0.1.26');
      await authenticateModel(host);
      const created = await host.rpc('session/create', { cwd: host.control.workspace });
      assert.ok(created.sessionId);
      host.modelSession = created.sessionId;
      const firstSession = created.sessionId;
      const followId = await openFollow(host, firstSession);
      const first = await modelTurn(host, 'search');
      assert.equal(first.isError, false);
      assert.equal(first.afterCalls.original, 0);
      assert.match(JSON.stringify(first.toolResult ?? {}), /offline-fixture|Fixture|内部候选/);
      if (runtime.app.version.startsWith('0.2.1-')) assert.match(JSON.stringify(first.ptcDispatch ?? {}), /web_search/);
      const firstFollow = await waitForSocketEvent(host, followId, 'tool/result');
      assert.equal(firstFollow.socket.opened, true);
      assert.equal(firstFollow.socket.closed, false);
      const beforeReloadFrames = firstFollow.socket.frames.length;
      const reloaded = await host.probe('rebuild-web-from-author');
      await waitForProduct(host);
      const reloadState = await host.probe('snapshot');
      writeJson(join(directory, runtime.app.version + '-m0-04-reload.json'), safe(reloadState));
      assert.equal(reloadState.runtimeWeb.searchProviderId, 'grok-search');
      const afterReload = await modelTurnOnSession(host, 'search', firstSession);
      assert.equal(afterReload.isError, false);
      assert.equal(afterReload.afterCalls.original, 0);
      const reloadFollow = await waitForSocketEvent(host, followId, 'tool/result', beforeReloadFrames);
      writeJson(join(directory, runtime.app.version + '-m0-04-first.json'), safe({ text: first.text, toolResult: first.toolResult, calls: { before: first.beforeCalls, after: first.afterCalls }, follow: firstFollow.socket.frames, reload: { route: reloaded.runtimeWeb, calls: { before: afterReload.beforeCalls, after: afterReload.afterCalls }, follow: reloadFollow.socket.frames } }));
      assert.equal(first.controlState.recordEnvelope.intent.policy, 'required');
      assert.equal(first.controlState.recordEnvelope.intent.release, null);

      const standard = await host.rpc('session/create', { cwd: host.control.workspace, agentPreset: 'standard' });
      assert.ok(standard.sessionId);
      assert.match(String(standard.agentPreset ?? ''), /standard/);
      const second = await modelTurnOnSession(host, 'search', standard.sessionId);
      assert.equal(second.isError, false);
      assert.equal(second.afterCalls.original, 0);
      assert.match(JSON.stringify(second.toolResult ?? {}), /offline-fixture|Fixture|内部候选/);
      if (runtime.app.version.startsWith('0.2.1-')) assert.match(JSON.stringify(second.ptcDispatch ?? {}), /web_search/);

      const ptcSession = await host.rpc('session/create', { cwd: host.control.workspace, agentPreset: 'ptc' });
      assert.ok(ptcSession.sessionId);
      assert.match(String(ptcSession.agentPreset ?? ''), /ptc/);
      const ptc = await modelTurnOnSession(host, 'ptc', ptcSession.sessionId);
      writeJson(join(directory, runtime.app.version + '-m0-04-ptc.json'), safe({ text: ptc.text, toolResult: ptc.toolResult, ptcDispatch: ptc.ptcDispatch, calls: { before: ptc.beforeCalls, after: ptc.afterCalls }, controlState: ptc.controlState, events: ptc.events }));
      assert.equal(ptc.isError, false);
      assert.equal(ptc.afterCalls.original, 0);
      const ptcText = JSON.stringify(ptc.ptcDispatch ?? {});
      assert.match(ptcText, /web_search/);
      assert.doesNotMatch(ptcText, /"isError":true/);

      const cordisSession = await host.rpc('session/create', { cwd: host.control.workspace, agentPreset: 'cordis' });
      assert.ok(cordisSession.sessionId);
      assert.match(String(cordisSession.agentPreset ?? ''), /cordis/);
      const cordis = await modelTurnOnSession(host, 'search', cordisSession.sessionId);
      assert.equal(cordis.isError, false);
      assert.equal(cordis.afterCalls.original, 0);
      assert.match(JSON.stringify(cordis.toolResult ?? {}), /offline-fixture|Fixture|内部候选/);

      const fetch = await modelTurnOnSession(host, 'fetch', standard.sessionId);
      assert.equal(fetch.isError, false);
      assert.equal(fetch.afterCalls.fetch - fetch.beforeCalls.fetch, 1);
      if (runtime.app.version.startsWith('0.2.1-')) assert.match(JSON.stringify(fetch.ptcDispatch ?? {}), /web_fetch/);
      const chat = await modelTurnOnSession(host, 'chat', firstSession);
      assert.equal(chat.isError, false);
      await preserved(host);
      const firstExit = await close(host);
      assert.equal(firstExit.exitCode, 0);
      assert.equal(firstExit.forced, false);

      host = await start(runtime, folder, 'm0-04-restart');
      await waitForProduct(host);
      const restarted = await waitForProgram(host);
      const restartFollowId = await openFollow(host, firstSession);
      const old = await modelTurnOnSession(host, 'search', firstSession);
      assert.equal(old.isError, false);
      assert.equal(old.afterCalls.original, 0);
      assert.match(JSON.stringify(old.toolResult ?? {}), /offline-fixture|Fixture|内部候选/);
      const restartFollow = await waitForSocketEvent(host, restartFollowId, 'tool/result');
      assert.equal(restartFollow.socket.opened, true);
      await preserved(host);
      const finalExit = await close(host);
      assert.equal(finalExit.exitCode, 0);
      assert.equal(finalExit.forced, false);

      return {
        first: { sessionId: firstSession, beforeCalls: first.beforeCalls, afterCalls: first.afterCalls, isError: first.isError, ptcDispatch: first.ptcDispatch },
        standard: { sessionId: standard.sessionId, agentPreset: standard.agentPreset, beforeCalls: second.beforeCalls, afterCalls: second.afterCalls, isError: second.isError, ptcDispatch: second.ptcDispatch },
        ptc: { sessionId: ptcSession.sessionId, agentPreset: ptcSession.agentPreset, beforeCalls: ptc.beforeCalls, afterCalls: ptc.afterCalls, isError: ptc.isError, dispatch: ptc.ptcDispatch },
        cordis: { sessionId: cordisSession.sessionId, agentPreset: cordisSession.agentPreset, beforeCalls: cordis.beforeCalls, afterCalls: cordis.afterCalls, isError: cordis.isError, ptcDispatch: cordis.ptcDispatch },
        fetch: { beforeCalls: fetch.beforeCalls, afterCalls: fetch.afterCalls, isError: fetch.isError, ptcDispatch: fetch.ptcDispatch },
        chat: { beforeCalls: chat.beforeCalls, afterCalls: chat.afterCalls, isError: chat.isError },
        reload: { beforeCalls: afterReload.beforeCalls, afterCalls: afterReload.afterCalls, isError: afterReload.isError, searchProviderId: reloadState.runtimeWeb.searchProviderId, followFrames: reloadFollow.socket.frames.length },
        follow: { firstFrames: firstFollow.socket.frames.length, restartFrames: restartFollow.socket.frames.length, restartId: restartFollowId },
        restart: { sessionId: firstSession, beforeCalls: old.beforeCalls, afterCalls: old.afterCalls, isError: old.isError, searchProviderId: restarted.runtimeWeb.searchProviderId, followFrames: restartFollow.socket.frames.length },
        exits: [firstExit, finalExit],
      };
    });
    for (const budgetMs of [60000, 90000, 120000]) {
      await scenario(runtime, 'budget-' + budgetMs, async folder => {
        await prepare(runtime, folder, budgetMs);
        const host = await start(runtime, folder, 'm0-04-budget-' + budgetMs);
        await waitForProduct(host);
        await waitForProgram(host);
        await authenticateModel(host);
        const session = await host.rpc('session/create', { cwd: host.control.workspace });
        assert.ok(session.sessionId);
        await modelTurnOnSession(host, 'chat', session.sessionId);
        const definition = await host.probe('tool-definition', { sessionId: session.sessionId });
        const search = definition.definitions.find(row => row?.name === 'web_search');
        const fetch = definition.definitions.find(row => row?.name === 'web_fetch');
        assert.ok(search, 'web_search definition must be visible');
        assert.ok(fetch, 'web_fetch definition must be visible');
        assert.equal(search.timeoutMs, budgetMs);
        assert.equal(fetch.timeoutMs, 30000);
        assert.equal(definition.coreBudgetMs, budgetMs);
        await preserved(host);
        const exit = await close(host);
        assert.equal(exit.exitCode, 0);
        assert.equal(exit.forced, false);
        return { budgetMs, sessionId: session.sessionId, definition, exit };
      });
    }
    continue;
  }
  if(verificationCase==='migration') {
   await scenario(runtime,'legacy-required-preserved-no-invented-provenance',async folder=>{
    await prepare(runtime,folder);
    const legacyOwner=await start(runtime,folder,'legacy-owner',null,false);
    const original=await preserved(legacyOwner);assert.equal(original.recordEnvelope,null);assert.equal(original.record.policy,'required');
    assert.equal(Object.hasOwn(original.record.lease,'hostId'),false);
    const legacyFailure=await modelTurn(legacyOwner,'search');assert.equal(legacyFailure.isError,false);assert.equal(legacyFailure.afterCalls.original,0);
    const oldExit=await close(legacyOwner);assert.equal(oldExit.exitCode,0);assert.equal(oldExit.forced,false);
    const path=join(folder,'dsh-home/profiles/desktop/control-intent.fixture.json'),raw=readFileSync(path),prior=JSON.parse(raw);
    selection(folder,true);const migration=await migrateProfile(folder),before=store(folder).read();
    assert.deepEqual(Buffer.from(before.intent.migration.sourceBase64,'base64'),raw);
    const {migration:_migration,...imported}=before.intent;assert.deepEqual(imported,prior);
    const restored=await start(runtime,folder,'migrated-required');
    const state=await preserved(restored);assert.equal(state.recovery.phase,'incomplete');assert.equal(state.recovery.error.code,'CONTROL_RECOVERY_PROVENANCE_REQUIRED');
    assert.deepEqual(state.recordEnvelope,before);assert.equal(state.record.release,null);assert.equal(state.runtimeWeb.searchProviderId,'candidate-original');
    const authorModel=await modelTurn(restored,'search'),fetchModel=await modelTurn(restored,'fetch'),chatModel=await modelTurn(restored,'chat');
    assert.equal(authorModel.isError,false);assert.equal(fetchModel.isError,false);assert.equal(chatModel.isError,false);assert.equal(authorModel.afterCalls.grok,0);
    const exit=await close(restored);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);assert.deepEqual(readFileSync(path),raw);assert.deepEqual(store(folder).read(),before);
    return{legacyGenerated:true,original,legacyFailure,oldExit,prior,migration,before,state,authorModel,fetchModel,chatModel,exit,sourcePreserved:true,newAuthorization:false};
   });
   await scenario(runtime,'migrated-required-current-selection-is-new-authorization',async folder=>{
    await prepare(runtime,folder);const legacy=await start(runtime,folder,'legacy-still-selected',null,false);
    const original=await preserved(legacy);assert.equal(original.record.policy,'required');
    const oldExit=await close(legacy);assert.equal(oldExit.exitCode,0);assert.equal(oldExit.forced,false);
    const path=join(folder,'dsh-home/profiles/desktop/control-intent.fixture.json'),raw=readFileSync(path),prior=JSON.parse(raw),migration=await migrateProfile(folder);
    const imported=store(folder).read(),selected=await start(runtime,folder,'migrated-current-selection'),state=await preserved(selected);
    assert.ok(state.recordEnvelope.revision>imported.revision);
    assert.equal(state.record.policy,'required');assert.equal(state.record.release,null);
    assert.deepEqual(state.record.migration,imported.intent.migration);assert.deepEqual(state.record.priorIntent,imported.intent);
    assert.equal(state.record.acquisition.source,'current-selected-search-bundle');
    assert.equal(state.record.acquisition.hostId,state.instanceId);assert.equal(state.record.lease.hostId,state.instanceId);
    assert.equal(state.record.migration.authorizationEstablished,false);
    const searchModel=await modelTurn(selected,'search'),fetchModel=await modelTurn(selected,'fetch'),chatModel=await modelTurn(selected,'chat');
    assert.equal(searchModel.isError,false);assert.ok(searchModel.afterCalls.grok>searchModel.beforeCalls.grok);assert.equal(searchModel.afterCalls.original,0);
    assert.equal(fetchModel.isError,false);assert.equal(chatModel.isError,false);
    const exit=await close(selected);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);assert.deepEqual(readFileSync(path),raw);
    const finalRecord=store(folder).read();assert.deepEqual(finalRecord.intent.migration,imported.intent.migration);assert.equal(finalRecord.intent.release,null);
    return{legacyGenerated:true,original,oldExit,prior,migration,imported,state,searchModel,fetchModel,chatModel,exit,finalRecord,
      sourcePreserved:true,newAuthorizationSource:'current-selected-search-bundle',migrationEstablishedAuthorization:false};
   });
   await scenario(runtime,'legacy-explicit-release-remains-released',async folder=>{
    await prepare(runtime,folder);const legacy=await start(runtime,folder,'legacy-live-stop',null,false);await legacy.probe('confirm-stop');
    const stopped=await preserved(legacy);assert.equal(stopped.record.policy,'released');assert.equal(stopped.record.release.explicit,true);
    const oldExit=await close(legacy);assert.equal(oldExit.exitCode,0);
    const path=join(folder,'dsh-home/profiles/desktop/control-intent.fixture.json'),raw=readFileSync(path),prior=JSON.parse(raw),migration=await migrateProfile(folder);
    const before=store(folder).read(),restored=await start(runtime,folder,'migrated-released'),state=await preserved(restored);
    assert.deepEqual(state.recordEnvelope,before);assert.deepEqual(state.record.release,prior.release);assert.deepEqual(state.record.pause,prior.pause);
    assert.equal(state.runtimeWeb.searchProviderId,'candidate-original');
    const authorModel=await modelTurn(restored,'search'),fetchModel=await modelTurn(restored,'fetch');assert.equal(authorModel.isError,false);assert.equal(fetchModel.isError,false);assert.equal(authorModel.afterCalls.grok,0);
    const exit=await close(restored);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);assert.deepEqual(readFileSync(path),raw);assert.deepEqual(store(folder).read(),before);
    return{legacyGenerated:true,stopped,oldExit,prior,migration,before,state,authorModel,fetchModel,exit,sourcePreserved:true,historicReleaseUnchanged:true};
   });
   continue;
  }
  await scenario(runtime,'selected-recovery-startup',async folder=>{
   const seed=await seedPending(runtime,folder);selection(folder,true);
   const next=await start(runtime,folder,'startup-recovery');
   await next.probe('wait-recovery');const corrected=await preserved(next);
   assert.equal(corrected.recordEnvelope.revision,seed.before.revision+1);assert.equal(corrected.record.recovery.action,'startup-state-correction');
   assert.deepEqual(corrected.record.priorIntent,seed.before.intent);assert.deepEqual(corrected.record.recovery.originalLease,seed.before.intent.lease);
   assert.equal(corrected.record.release,null);assert.equal(corrected.record.recovery.historicReleaseCommitted,false);
   assert.equal(corrected.runtimeWeb.searchProviderId,'candidate-original');const authorSearch=await next.probe('seam');assert.equal(authorSearch.ok,true);
   const authorModel=await modelTurn(next,'search'),fetchModel=await modelTurn(next,'fetch'),chatModel=await modelTurn(next,'chat');assert.equal(authorModel.isError,false);assert.equal(fetchModel.isError,false);assert.equal(chatModel.isError,false);
   await next.probe('wait-recovery');assert.deepEqual(store(folder).read(),corrected.recordEnvelope);
   const exit=await close(next);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);
   return{seed,initial:next.initial,corrected,authorSearch,authorModel,fetchModel,chatModel,idempotent:true,exit};
  });
  await scenario(runtime,'all-unselected-legal-load',async folder=>{
   const seed=await seedPending(runtime,folder);selection(folder,false);
   const cold=await start(runtime,folder,'no-components');const pending=await preserved(cold);
   assert.equal(pending.ownerPresent,false);assert.equal(pending.recoveryPresent,false);assert.deepEqual(pending.recordEnvelope,seed.before);
   assert.equal(pending.runtimeWeb.searchProviderId,'candidate-original');const authorSearch=await cold.probe('seam');assert.equal(authorSearch.ok,true);
   const coldSearch=await modelTurn(cold,'search'),coldFetch=await modelTurn(cold,'fetch');assert.equal(coldSearch.isError,false);assert.equal(coldFetch.isError,false);
   const coldExit=await close(cold);assert.equal(coldExit.exitCode,0);
   const path=join(folder,'dsh-home/profiles/desktop/package.json');const value=JSON.parse(readFileSync(path,'utf8'));value.dsh.profile.bundles.push('candidate-search-recovery');writeFileSync(path,JSON.stringify(value,null,2)+'\n');
   const legal=await start(runtime,folder,'legal-load');await legal.probe('wait-recovery');const corrected=await preserved(legal);
   assert.equal(corrected.recordEnvelope.revision,seed.before.revision+1);assert.deepEqual(corrected.record.priorIntent,seed.before.intent);
   const exit=await close(legal);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);return{seed,pending,authorSearch,coldSearch,coldFetch,coldExit,corrected,exit};
  });
  for(const stage of ['before-publish','after-publish']) await scenario(runtime,'startup-'+stage,async folder=>{
   const seed=await seedPending(runtime,folder);selection(folder,true);
   const interrupted=await start(runtime,folder,'startup-fault',stage);const failed=await preserved(interrupted);
   const commitError=failed.controlEvents.find(event=>event.type==='record-commit-incomplete');
   assert.ok(commitError);assert.equal(commitError.outcome.recordCommitted,stage==='after-publish'?null:false);
   assert.equal(commitError.outcome.routeVerified,true);
   if(stage==='before-publish')assert.equal(failed.recovery.phase,'incomplete');
   else if(failed.recovery.phase==='already-corrected')assert.equal(failed.recovery.outcome.resolution,'same-operation-readback');
   else assert.equal(failed.recovery.phase,'incomplete');
   assert.equal(failed.runtimeWeb.searchProviderId,'candidate-original');
   assert.equal(store(folder).read().revision,stage==='after-publish'?seed.before.revision+1:seed.before.revision);
   const authorModel=await modelTurn(interrupted,'search'),fetchModel=await modelTurn(interrupted,'fetch');assert.equal(authorModel.isError,false);assert.equal(fetchModel.isError,false);
   const faultExit=await close(interrupted);assert.equal(faultExit.exitCode,0);assert.equal(faultExit.forced,false);
   const retry=await start(runtime,folder,'startup-retry');await retry.probe('wait-recovery');const recovered=await preserved(retry);
   assert.equal(recovered.recordEnvelope.revision,seed.before.revision+1);assert.deepEqual(recovered.record.priorIntent,seed.before.intent);
   const exit=await close(retry);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);return{seed,failed,commitError,authorModel,fetchModel,faultExit,recovered,exit};
  });
  await scenario(runtime,'owner-immediate-stop',async folder=>{
   await prepare(runtime,folder);const owner=await start(runtime,folder,'live-owner');const before=await preserved(owner);
   await owner.probe('record-fault',{stage:'before-publish'});
   await assert.rejects(()=>owner.probe('confirm-stop'),/Control write did not publish/);
   const incomplete=await preserved(owner);assert.deepEqual(incomplete.recordEnvelope,before.recordEnvelope);
   assert.equal(incomplete.runtimeWeb.searchProviderId,before.record.lease.provider);
   const failedStopSearch=await modelTurn(owner,'search');assert.equal(failedStopSearch.isError,true);assert.equal(failedStopSearch.afterCalls.original,0);
   const rebound=await owner.probe('rebuild-web-from-author');
   assert.equal(rebound.runtimeWeb.searchProviderId,before.record.lease.provider);
   assert.deepEqual(rebound.recordEnvelope,before.recordEnvelope);
   const reboundModel=await modelTurn(owner,'search');assert.equal(reboundModel.isError,true);assert.equal(reboundModel.afterCalls.original,0);
   await owner.probe('record-fault',{stage:null});
   const stopped=await owner.probe('confirm-stop');assert.equal(stopped.runtimeWeb.searchProviderId,'candidate-original');
   assert.equal(stopped.recordEnvelope.revision,before.recordEnvelope.revision+1);assert.equal(stopped.record.release.explicit,true);
   assert.deepEqual(stopped.ownerPresent,true);assert.equal(stopped.record.release.kind,'intent-release-commit');assert.equal(Object.hasOwn(stopped.record.release,'routeVerified'),false);assert.deepEqual(stopped.webInject,before.webInject);
   const authorModel=await modelTurn(owner,'search'),fetchModel=await modelTurn(owner,'fetch'),chatModel=await modelTurn(owner,'chat');assert.equal(authorModel.isError,false);assert.equal(fetchModel.isError,false);assert.equal(chatModel.isError,false);
   const after=await preserved(owner),exit=await close(owner);assert.equal(exit.exitCode,0);assert.equal(exit.forced,false);return{before,incomplete,failedStopSearch,rebound,reboundModel,stopped,authorModel,fetchModel,chatModel,after,exit};
  });
 }
}catch(error){fatal={message:error.message,stack:error.stack};}
finally{
 for(const child of children)await close(child);
 let grokStubEvidence=null;
 if(grokStub){
   await grokStub.close();
   grokStubEvidence={baseUrl:grokStub.baseUrl,loopbackOnly:true,requestCount:grokStub.requests.length,
     allResponsesPath:grokStub.requests.every(row=>row.method==='POST'&&row.url==='/v1/responses'),
     allAuthorizedWithSyntheticKey:grokStub.requests.every(row=>row.authorizedWithSyntheticKey),
     webSearchToolRequested:grokStub.requests.length>0&&grokStub.requests.every(row=>row.tools.includes('web_search')),
     requests:grokStub.requests};
   writeJson(join(directory,'grok-responses-stub.json'),safe(grokStubEvidence));
   if(!fatal&&(!grokStubEvidence.requestCount||!grokStubEvidence.allResponsesPath||!grokStubEvidence.allAuthorizedWithSyntheticKey))
     fatal={message:'The real Grok program did not use only the isolated Responses stub with the synthetic key.'};
 }
 // Every run copies the program under its own temporary root; any surviving
 // copy after all Desktop exits is an orphan owned by this gate.
 let orphanPrograms=[];
 if(verificationCase==='m0-04'&&process.platform==='win32'){
   // Match on the ASCII run marker: console output encoding can mangle the
   // non-ASCII user directory in the full temporary path.
   const query=await commandResult('powershell.exe',['-NoProfile','-NonInteractive','-Command',
     "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Where-Object Name -eq 'grok-search-rs.exe' | ForEach-Object ExecutablePath"],{timeoutMs:30000});
   const marker=('dsh-deferred-desktop-b2-'+runId).toLowerCase();
   orphanPrograms=query.rawStdout.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&line.toLowerCase().includes(marker));
   writeJson(join(directory,'grok-program-orphans.json'),safe({queryExitCode:query.exitCode,orphanCount:orphanPrograms.length,orphans:orphanPrograms}));
   if(!fatal&&orphanPrograms.length)fatal={message:'A gate-owned grok-search-rs process survived Desktop exit.'};
 }
 const afterHashes=Object.fromEntries(runtimes.map(row=>[row.app.version,{exe:sha256(row.executable),asar:sha256(row.archivePath)}]));
 const unchanged=JSON.stringify(beforeHashes)===JSON.stringify(afterHashes);
 const sourcesUnchanged = sourceHashesBefore.every(row => sha256(join(project, row.file)) === row.sha256);
 if (!sourcesUnchanged) fatal ??= { message: 'Source changed during the run; evidence is not a current-source gate.' };
 const summary={runId,status:fatal?'fail':'pass',counts:{pass:results.filter(row=>row.status==='pass').length,fail:results.filter(row=>row.status==='fail').length},fatal,
  scope:verificationCase==='migration'?'actual-official-Desktop-legacy-record-explicit-migration-no-new-authorization':verificationCase==='product'?'actual-official-Desktop-product-owner-release-and-recovery-with-fixture-and-canonical-session-counters':verificationCase==='m0-04'?'actual-official-Desktop-multi-session-preset-matrix-websocket-reconnect-config-reload-old-session-restart-with-fixture-route-counter':'actual-official-Desktop-development-load-original-ASAR-with-versioned-control-fixture',desktopBehaviorValidated:true,desktopModelEventsValidated:true,desktopUiDomValidated:false,entryWiringValidated:['product','m0-04'].includes(verificationCase),routeVerifierValidated:['product','m0-04'].includes(verificationCase),routeCounterAdapter:verificationCase==='product'?'fixture-and-canonical-session-event':verificationCase==='m0-04'?'fixture-only':null,realHostCounterAdapterValidated:verificationCase==='product'&&!fatal&&targetVersions.every(version=>results.some(row=>row.version===version&&row.scenario==='canonical-counter-real-official-provider-path'&&row.status==='pass')),configReloadNoFallbackValidated:verificationCase==='product'&&!fatal&&targetVersions.every(version=>results.some(row=>row.version===version&&row.scenario==='config-reload-transition-no-official-fallback'&&row.status==='pass')),hostReleaseCompletionReceiptValidated:false,releaseControllerWired:verificationCase==='product',releaseTransactionDesktopValidated:verificationCase==='product',m0_04DesktopValidated:verificationCase==='m0-04'&&!fatal&&results.length>0&&results.every(row=>row.status==='pass'),m0_04MultiSessionValidated:verificationCase==='m0-04'&&!fatal,m0_04PtcPresetValidated:verificationCase==='m0-04'&&!fatal,m0_04OldSessionRestartValidated:verificationCase==='m0-04'&&!fatal,m0_04PresetMatrixValidated:verificationCase==='m0-04'&&!fatal&&results.length>0&&results.every(row=>row.status==='pass'),m0_04OldConnectionReconnectValidated:verificationCase==='m0-04'&&!fatal&&results.length>0&&results.every(row=>row.status==='pass'),m0_04ConfigReloadValidated:verificationCase==='m0-04'&&!fatal&&results.length>0&&results.every(row=>row.status==='pass'),m0_04BudgetMatrixValidated:verificationCase==='m0-04'&&!fatal&&results.filter(row=>row.scenario.startsWith('budget-')).length===6&&results.filter(row=>row.scenario.startsWith('budget-')).every(row=>row.status==='pass'),productIntegrated:false,packagedInstallValidated:false,
  nativeHmrToggleValidated: verificationCase === 'ux' && !fatal && results.length === runtimes.length,
  results:results.map(({version,scenario,status})=>({version,scenario,status})),preparationResults,originalHashes:{before:beforeHashes,after:afterHashes,unchanged},
  sourceHashes: sourceHashesBefore, sourcesUnchanged, exits:children.map(row=>({prefix:row.prefix,exitCode:row.exitCode,signal:row.signal,forced:row.forced??false}))};
 if (verificationCase === 'ux') Object.assign(summary, {
   // Only the explicit positive-control scenario establishes the canonical
   // counter; the native-toggle scenario uses the fixture's original provider.
   scope: 'actual-official-Desktop-aggregated-bundle-native-hmr-toggle-canonical-counter-and-reload-transition',
   entryWiringValidated: !fatal && testedVersions.every(version => results.filter(row => row.version === version && row.status === 'pass').length >= 3),
   routeVerifierValidated: !fatal && testedVersions.every(version => results.filter(row => row.version === version && row.status === 'pass').length >= 3),
   releaseControllerWired: true,
   releaseTransactionDesktopValidated: !fatal && testedVersions.every(version => results.filter(row => row.version === version && row.status === 'pass').length >= 3),
   sourceOnlyDesktopValidated: !fatal && testedVersions.every(version => results.some(row => row.version === version
     && row.scenario === 'sources-only-shared-budget-and-native-stop' && row.status === 'pass')),
   nativeHmrToggleValidated: !fatal && testedVersions.every(version => results.some(row => row.version === version && row.scenario === 'native-hmr-toggle-and-reacquire' && row.status === 'pass')),
   routeCounterAdapter: 'fixture-and-canonical-session-event',
   realHostCounterAdapterValidated: !fatal && testedVersions.every(version => results.some(row => row.version === version && row.scenario === 'aggregated-canonical-counter-and-reload-transition' && row.status === 'pass')),
   configReloadNoFallbackValidated: !fatal && testedVersions.every(version => results.some(row => row.version === version && row.scenario === 'aggregated-canonical-counter-and-reload-transition' && row.status === 'pass')),
   deepSeekSearchApiRoutingValidated: !fatal && results.some(row => row.scenario === 'deepseek-search-api-takeover-and-native-restore' && row.status === 'pass'),
   pluginManagerUiDomValidated: false,
   packagedInstallValidated: false,
   realGrokQueryValidated: false,
 });
 if (verificationCase === 'm0-04') Object.assign(summary, {
   scope: 'actual-official-Desktop-aggregated-bundle-real-grok-search-rs-0.1.26-loopback-responses-stub-multi-session-preset-matrix-websocket-reconnect-config-reload-old-session-restart-with-fixture-route-counter',
   grokProgram: preparationResults.find(row => row.grokProgramValidation)?.grokProgramValidation ?? null,
   realGrokProgramValidated: !fatal && (grokStubEvidence?.requestCount ?? 0) > 0,
   // The upstream is a loopback stub with a synthetic key; this is not a paid
   // xAI query and does not validate real upstream behaviour.
   realGrokUpstreamValidated: false,
   m0_04BudgetMatrixValidated: !fatal && testedVersions.every(version => [60000, 90000, 120000].every(budget =>
     results.some(row => row.version === version && row.scenario === 'budget-' + budget && row.status === 'pass'))),
   grokResponsesStub: grokStubEvidence && { requestCount: grokStubEvidence.requestCount,
     allResponsesPath: grokStubEvidence.allResponsesPath,
     allAuthorizedWithSyntheticKey: grokStubEvidence.allAuthorizedWithSyntheticKey,
     webSearchToolRequested: grokStubEvidence.webSearchToolRequested },
   orphanGrokPrograms: orphanPrograms.length,
 });
 writeJson(join(directory,'summary.json'),safe(summary));console.log(JSON.stringify(safe(summary),null,2));process.exitCode=fatal||!unchanged?1:0;
}
