import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {candidateRuntime} from './lib/candidate-runtime.mjs';
import {freshRun,project,writeJson,redact,cleanEnvironment,sha256,commandResult,receipt} from './lib/internal-candidate-utils.mjs';
import {checkDeferredNotice,checkColdPending,checkRecoveredRecord,checkPendingLoad,checkSelectedAcquisition,checkSelectionHistoryPreserved,checkRequiredSearchError,NOTICE_TEXT} from './lib/deferred-release-checks.mjs';

const SEARCH='candidate-controlled-search',RECOVERY='candidate-search-recovery';
let oldDesktop,newDesktop,kind;
for(let index=2;index<process.argv.length;index++){
 const flag=process.argv[index];if(flag==='--desktop-rc2')oldDesktop=process.argv[++index];else if(flag==='--desktop-rc21')newDesktop=process.argv[++index];
 else if(flag==='--case')kind=process.argv[++index];else throw new Error('Unknown deferred verification flag '+flag);
}
if(!oldDesktop||!newDesktop||!['notice','recovery','search-first','intent-evidence','current-selection'].includes(kind))throw new Error('Provide both Desktop versions and --case notice, recovery, search-first or intent-evidence/current-selection.');
const runtimes=[candidateRuntime(oldDesktop),candidateRuntime(newDesktop)];
assert.deepEqual(runtimes.map(runtime=>runtime.app.version),['0.2.0-rc.2','0.2.1-rc.2']);
const{directory,runId}=freshRun('deferred-'+kind);
const sandbox=mkdtempSync(join(tmpdir(),'dsh-deferred-'+kind+'-'));
const secrets=new Set(),hosts=[],results=[];
const replacements=[[sandbox,'<SANDBOX>'],...runtimes.map(runtime=>[dirname(runtime.executable),`<DESKTOP_${runtime.app.version}>`])];
const sanitize=value=>redact(value,replacements,[...secrets]);
const safe=value=>JSON.parse(sanitize(JSON.stringify(value)));
const sourcePaths=['fixtures/deferred-release/control.mjs','scripts/deferred-release-host.mjs','scripts/deferred-release.mjs','scripts/lib/deferred-release-checks.mjs','test/deferred-release.test.mjs'];
const beforeHashes=Object.fromEntries(sourcePaths.map(path=>[path,sha256(join(project,path))]));
const contextSources=runtimes.map(runtime=>{
 const stub=runtime.archive.read('dsh/node_modules/@deepseek-ai/dsh/lib/profile-boot.js').toString('utf8');
 const chunk=stub.match(/"\.\/(profile-boot-[^"]+\.js)"/)[1];
 const file='dsh/node_modules/@deepseek-ai/dsh/lib/'+chunk;
 const lines=runtime.archive.read(file).toString('utf8').split('\n');
 const startedLine=lines.findIndex(line=>line.includes('startedBundles:'))+1;
 return {version:runtime.app.version,file,sha256:runtime.archive.sha256(file),startedBundlesLine:startedLine,
  statement:lines[startedLine-1].trim(),appBootFile:'dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js',
  appBootSha256:runtime.archive.sha256('dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')};
});
let sequence=0;
function start(runtime,root,initialize=true,diagnostic={}){
 const env=cleanEnvironment(root,{DSH_HOME:join(root,'dsh-home'),ELECTRON_RUN_AS_NODE:'1',DSH_DESKTOP_NODE_EXECUTABLE:runtime.executable});
 const command=[runtime.executable,'--expose-internals',join(project,'scripts/deferred-release-host.mjs'),runtime.archivePath,root];
 const child=spawn(command[0],command.slice(1),{cwd:root,env,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
 const state={command:command.map(sanitize),root:sanitize(root),events:[],stdout:'',stderr:'',pending:new Map(),timedOut:false,requests:[]};
 child.stdout.on('data',chunk=>state.stdout+=chunk);child.stderr.on('data',chunk=>state.stderr+=chunk);
 child.on('error',error=>state.spawnError=error.message);
 const timer=setTimeout(()=>{state.timedOut=true;child.kill('SIGKILL');},60000);
 state.closed=new Promise(done=>child.once('close',(code,signal)=>{clearTimeout(timer);state.stopped=true;state.exitCode=code;state.signal=signal;
  for(const pending of state.pending.values()){clearTimeout(pending.timer);pending.reject(new Error('Deferred Host exited before reply'));}state.pending.clear();done();}));
 child.on('message',message=>{if(message.type!=='reply'){state.events.push(message);return;}const pending=state.pending.get(message.id);if(!pending)return;
  clearTimeout(pending.timer);state.pending.delete(message.id);if(message.ok)pending.resolve(message.value);else pending.reject(new Error(message.error.message));});
 const host={runtime,root,index:hosts.length,state,child,
  request(op,args={}){if(state.stopped)return Promise.reject(new Error('Deferred Host closed'));const id='deferred-'+(++sequence);return new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>{state.pending.delete(id);reject(new Error('Deferred Host reply timed out: '+op));},12000);state.pending.set(id,{resolve,reject,timer});child.send({id,op,args});});},
  async event(type){const end=Date.now()+15000;while(Date.now()<end){const fatal=state.events.find(value=>value.type==='fatal');if(fatal)throw new Error(fatal.error.message);
   const event=state.events.find(value=>value.type===type);if(event)return event;if(state.stopped)throw new Error('Host stopped during startup');await new Promise(done=>setTimeout(done,30));}throw new Error('Deferred startup timed out: '+type);},
  async close(){if(!state.stopped)try{await host.request('close');}catch(error){state.closeError=error.message;child.kill('SIGKILL');}await state.closed;}
 };
 hosts.push(host);child.send({initialize,...diagnostic});return host;
}
async function rpc(host,cookie,endpoint,request){
 const origin=(await host.event('listening')).origin;
 const envelope={type:'client-request',rpcId:'deferred-rpc-'+(++sequence),method:endpoint,payload:{args:{request}}};
 const response=await fetch(origin+'/api/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:cookie},body:JSON.stringify(envelope),signal:AbortSignal.timeout(10000)});
 const value=await response.json();host.state.requests.push({endpoint,status:response.status,response:value,authorization:'isolated-test-cookie'});
 assert.equal(response.status,200);assert.equal(value?.result?.ok,true,JSON.stringify(value));return value.result.value;
}
async function open(host){const ready=await host.event('ready');assert.deepEqual(ready.failed,[]);assert.deepEqual(ready.pending,[]);
 const endpoint=await host.event('listening');const response=await fetch(endpoint.authUrl,{redirect:'manual',signal:AbortSignal.timeout(10000)});assert.equal(response.status,303);
 const cookie=response.headers.get('set-cookie')?.split(';',1)[0];assert.ok(cookie);secrets.add(cookie);secrets.add(cookie.split('=').slice(1).join('='));
 const session=await rpc(host,cookie,'session/create',{cwd:ready.workspace});assert.ok(session.sessionId);return{cookie,sessionId:session.sessionId,ready};}
async function turn(host,auth,mode,stage){const before=await host.request('snapshot');await rpc(host,auth.cookie,'session/prompt',{requestId:'deferred-prompt-'+(++sequence),sessionId:auth.sessionId,mode:'queue',content:[{type:'text',text:mode}]});
 const end=Date.now()+10000;while(Date.now()<end){const after=await host.request('snapshot');const events=after.sessionEvents.slice(before.sessionEvents.length).filter(event=>event.sessionId===auth.sessionId);
  const final=events.findLast(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text==='内部候选轮次完成'));
  const ended=final&&events.find(event=>event.type==='turn/end'&&event.data.turn===final.data.turn&&event.data.reason?.kind==='completed');
  const result=final&&events.findLast(event=>event.type==='tool/result'&&event.data.turn===final.data.turn);
  if(after.completed>before.completed&&ended&&(mode==='chat'||result))return{stage,beforeCalls:before.calls,model:{completed:true,isError:result?.data.message.isError===true,text:result?.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')??'',message:result?.data.message??null},state:after};
  await new Promise(done=>setTimeout(done,35));}throw new Error('Controlled model did not finish '+stage);
}
function retainedFields(state){assert.equal(state.runtimeWeb.fetchProviderId,'candidate-fetch');assert.equal(state.webConfig.fetchProvider,'candidate-fetch');
 assert.deepEqual(state.webInject,{candidateExistingDependency:{probe:'retain-existing'}});assert.equal(state.existingDependencyPresent,true);assert.equal(state.existingDisposed,0);}
async function unaffected(host,auth,record,stage){for(const mode of['fetch','echo','chat']){const captured=await turn(host,auth,mode,stage+'-'+mode);record.observations.push(captured);
 assert.equal(captured.model.isError,false);if(mode==='fetch')assert.ok(captured.model.text.includes('离线 fetch 保持'));retainedFields(captured.state);}}
async function captureSearch(host,auth,record,stage){const captured=await turn(host,auth,'search',stage);const seam=await host.request('seam');record.observations.push({...captured,seam});retainedFields(captured.state);return{...captured,seam};}
async function verify(runtime){const record={case:kind,version:runtime.app.version,status:'running',observations:[],hostIndices:[]};results.push(record);
 const root=join(sandbox,runtime.app.version);mkdirSync(root,{recursive:true});let host=start(runtime,root);record.hostIndices.push(host.index);let auth;
 try{auth=await open(host);record.observations.push({stage:'actual-host-start',state:auth.ready});retainedFields(auth.ready);
  const baseline=await captureSearch(host,auth,record,'owner-active-search');assert.equal(baseline.model.isError,false);assert.ok(baseline.model.text.includes('Grok 隔离搜索成功'));assert.equal(baseline.state.calls.original,0);
  await host.request('upstream-failure',{enabled:true});const upstream=await captureSearch(host,auth,record,'upstream-error');assert.equal(upstream.model.isError,true);assert.equal(upstream.seam.error?.code,'CONTROLLED_UPSTREAM_ERROR');assert.equal(upstream.state.calls.original,0);assert.ok(!upstream.model.text.includes(NOTICE_TEXT));await host.request('upstream-failure',{enabled:false});
  await host.request('dispose-owner');await host.request('dispose-recovery');const ordinary=await host.request('snapshot');record.observations.push({stage:'ordinary-disposes',state:ordinary});assert.equal(ordinary.ownerPresent,false);assert.equal(ordinary.recoveryPresent,false);assert.equal(ordinary.record.policy,'required');assert.equal(ordinary.record.release??null,null);
  // The provider's dependency removal owns unregistration; this is an owner fault, not a release.
  const fault=await captureSearch(host,auth,record,'ordinary-dispose-search');assert.equal(fault.model.isError,true);assert.equal(fault.state.calls.original,0);
  await host.request('cancel-both');const after=await captureSearch(host,auth,record,'explicit-exit-with-no-components');
  checkDeferredNotice({model:after.model,seam:after.seam,originalCalls:after.state.calls.original,ownerPresent:after.state.ownerPresent,recoveryPresent:after.state.recoveryPresent});
  const pending=after.state.record;assert.equal(pending.policy,'required');assert.equal(pending.release??null,null);await unaffected(host,auth,record,'before-full-restart');
  await host.close();assert.equal(host.state.exitCode,0);host=start(runtime,root,false);record.hostIndices.push(host.index);auth=await open(host);
  const cold=await captureSearch(host,auth,record,'complete-cold-start');assert.equal(cold.model.isError,false);assert.ok(cold.model.text.includes('作者搜索对照'));assert.ok(!cold.model.text.includes(NOTICE_TEXT));
  checkColdPending({selectedBundles:cold.state.selectedBundles,searchBundle:SEARCH,recoveryBundle:RECOVERY,record:cold.state.record,authorRoute:cold.state.runtimeWeb.searchProviderId==='candidate-original'});
  assert.deepEqual(cold.state.record,pending);await unaffected(host,auth,record,'after-full-restart');
  if(kind==='search-first'){
   const legalLoad=await host.request('load-search');record.observations.push({stage:'first-legal-search-component-load',state:legalLoad});
   const after=await captureSearch(host,auth,record,'search-first-must-not-revive-stale-required');
   checkPendingLoad({before:pending,after:after.state.record,authorRoute:after.state.runtimeWeb.searchProviderId==='candidate-original',
    grokCalls:after.state.calls.grok,diagnosis:after.state.owner?.diagnosis,searchBundle:SEARCH,
    pendingObservation:{selectedBundles:cold.state.selectedBundles,searchBundle:SEARCH,recoveryBundle:RECOVERY,record:cold.state.record,authorRoute:cold.state.runtimeWeb.searchProviderId==='candidate-original'}});
   await unaffected(host,auth,record,'after-search-first-legal-load');
  }
  if(kind==='recovery'){
   const reload=await host.request('load-recovery');record.observations.push({stage:'legally-load-recovery',state:reload});const corrected=await host.request('wait-recovery');record.observations.push({stage:'corrected-record',state:corrected});
   checkRecoveredRecord({before:pending,after:corrected.record,searchBundle:SEARCH});assert.equal(corrected.runtimeWeb.searchProviderId,'candidate-original');retainedFields(corrected);
   const author=await captureSearch(host,auth,record,'author-after-record-correction');assert.equal(author.model.isError,false);assert.ok(author.model.text.includes('作者搜索对照'));
   const ownerReload=await host.request('load-search');record.observations.push({stage:'legal-search-load-does-not-revive-old-required',state:ownerReload});
   const noRevival=await captureSearch(host,auth,record,'no-old-record-reacquisition');assert.equal(noRevival.model.isError,false);assert.ok(noRevival.model.text.includes('作者搜索对照'));assert.equal(noRevival.state.record.policy,'released');
   assert.equal(noRevival.state.runtimeWeb.searchProviderId,'candidate-original');assert.equal(noRevival.state.calls.grok,0);await unaffected(host,auth,record,'after-legal-load');
  }
  record.status='pass';
 }catch(error){record.status=error instanceof assert.AssertionError?'fail':'harnessError';record.error={name:error.name,message:error.message,stack:error.stack};}
 finally{for(const index of record.hostIndices){const instance=hosts[index];await instance.close();if(instance.state.timedOut||instance.state.closeError||instance.state.exitCode!==0){record.status='harnessError';record.cleanup={index,exitCode:instance.state.exitCode,closeError:instance.state.closeError??null};}}}
 console.log(runtime.app.version+' '+kind+': '+record.status);
}
async function verifyIntentEvidence(runtime) {
 const record={case:kind,version:runtime.app.version,status:'running',observations:[],hostIndices:[]};results.push(record);
 const seed={schemaVersion:1,policy:'required',reason:'fresh-selected-owner',acquiredSelection:['candidate-offline-fixture',SEARCH,RECOVERY],release:null,
  lease:{pid:1,uid:18,entryId:'web',moduleName:'@deepseek-ai/dsh-web',provider:'grok-required：控制组件暂不可用；'+NOTICE_TEXT}};
 const projections=[];
 try {
  for(const history of ['unselected','skipped']) {
   const root=join(sandbox,runtime.app.version,history);mkdirSync(root,{recursive:true});
   const host=start(runtime,root,true,{intentEvidence:history,intentRecord:seed});record.hostIndices.push(host.index);const auth=await open(host);
   const before=await host.request('snapshot');record.observations.push({stage:history+'-cold-start',state:before});
   assert.equal(before.ownerPresent,false);assert.equal(before.recoveryPresent,false);assert.equal(before.runtimeWeb.searchProviderId,'candidate-original');
   assert.deepEqual(before.record,seed);assert.deepEqual(before.startedBundles,['candidate-offline-fixture']);retainedFields(before);
   if(history==='unselected')assert.deepEqual(before.selectedBundles,['candidate-offline-fixture']);
   else {
    assert.deepEqual(before.selectedBundles,['candidate-offline-fixture',SEARCH,RECOVERY]);
    for(const bundle of [SEARCH,RECOVERY])assert.ok(host.state.stderr.includes('skipping profile bundle '+JSON.stringify(bundle)), '实际启动必须记录兼容检查跳过');
   }
   const loaded=await host.request('repair-and-load-search');record.observations.push({stage:history+'-first-component-activation',state:loaded});
   const inputs=loaded.controlEvents.find(event=>event.type==='activation-input');assert.ok(inputs);
   assert.deepEqual(inputs.record,seed);
   const projection={startedBundles:inputs.startedBundles,current:inputs.current,record:inputs.record,effectiveWebConfig:inputs.effectiveWebConfig,webInject:inputs.webInject};
   projections.push(projection);record.observations.push({stage:history+'-available-intent-inputs',projection});
   await host.close();assert.equal(host.state.exitCode,0);
  }
  assert.deepEqual(projections[0],projections[1],'读取到的启动加载清单、当前选择、记录与web配置不能区分两个历史');
  record.finding={code:'CONTROL_INTENT_EVIDENCE_AMBIGUOUS',sameAvailableInputs:true,
   histories:['D-21 已退出后留下的历史 pending（合成记录）','仍选中但兼容检查跳过后修复加载（合成记录）'],
   claim:'仅证明当前控制探针实际读取的输入和startedBundles不足；未证明所有宿主机制不可能',
   productGate:'blocked',uiVerified:false};
  record.status='pass';
 } catch(error) {record.status=error instanceof assert.AssertionError?'fail':'harnessError';record.error={name:error.name,message:error.message,stack:error.stack};}
 finally {for(const index of record.hostIndices){const host=hosts[index];await host.close();if(host.state.timedOut||host.state.closeError||host.state.exitCode!==0){record.status='harnessError';record.cleanup={index,exitCode:host.state.exitCode,closeError:host.state.closeError??null};}}}
 console.log(runtime.app.version+' '+kind+': '+record.status);
}

async function verifyCurrentSelection(runtime) {
 const record={case:kind,version:runtime.app.version,status:'running',observations:[],hostIndices:[],scenarioResults:[],historiesUseSyntheticPriorRecord:false};results.push(record);
 let activeScenario;
 const begin=(caseName)=>{activeScenario={case:caseName,status:'running'};record.scenarioResults.push(activeScenario);};
 const passed=()=>{activeScenario.status='pass';};
 const launch=async(root,initialize=true,options={})=>{const host=start(runtime,root,initialize,{currentSelectionAuthorization:true,...options});record.hostIndices.push(host.index);const auth=await open(host);retainedFields(auth.ready);record.observations.push({stage:activeScenario.case+'-host-start',state:auth.ready});return{host,auth};};
 const end=async host=>{await host.close();assert.equal(host.state.exitCode,0);};
 const assertGrok=(captured)=>{assert.equal(captured.model.isError,false);assert.equal(captured.seam.ok,true);assert.ok(captured.model.text.includes('Grok 隔离搜索成功'));assert.equal(captured.state.calls.original,captured.beforeCalls.original);};
 const seed=async(root)=>{const{host,auth}=await launch(root);const initial=await captureSearch(host,auth,record,activeScenario.case+'-initial-takeover');assertGrok(initial);assert.equal(initial.state.record.acquisition.source,'current-selected-search-bundle');await unaffected(host,auth,record,activeScenario.case+'-initial');return{host,auth,initial};};
 const checkCurrent=(before,captured,root)=>{
  const manifest=readFileSync(join(root,'dsh-home','profiles','deferred','package.json'),'utf8');
  checkSelectedAcquisition({before,after:captured.state.record,selectedBundles:captured.state.selectedBundles,searchBundle:SEARCH,
   selectionSha256:createHash('sha256').update(manifest).digest('hex'),ownerPresent:captured.state.ownerPresent,
   requiredRoute:captured.state.runtimeWeb.searchProviderId===captured.state.record.lease.provider,
   originalCallsDelta:captured.seam.calls.original-captured.beforeCalls.original,model:captured.model,seam:captured.seam});
 };
 try {
  begin('explicit-exit-then-current-selection');
  const root=join(sandbox,runtime.app.version,'explicit-exit');mkdirSync(root,{recursive:true});
  let{host,auth}=await seed(root);
  await host.request('dispose-owner');await host.request('dispose-recovery');
  const fault=await captureSearch(host,auth,record,'ordinary-dispose-before-exit');
  checkRequiredSearchError({model:fault.model,seam:fault.seam,expectedCode:'WEB_PROVIDER_CONFIGURED_MISSING',originalCallsDelta:fault.seam.calls.original-fault.beforeCalls.original});
  const prior=fault.state.record;assert.equal(prior.policy,'required');assert.equal(prior.release,null);
  await host.request('cancel-both');const pending=await captureSearch(host,auth,record,'explicit-exit-with-absent-components');
  checkDeferredNotice({model:pending.model,seam:pending.seam,originalCalls:pending.state.calls.original,ownerPresent:pending.state.ownerPresent,recoveryPresent:pending.state.recoveryPresent});assert.deepEqual(pending.state.record,prior);
  await end(host);({host,auth}=await launch(root,false));
  const cold=await captureSearch(host,auth,record,'unselected-full-host-start');
  checkColdPending({selectedBundles:cold.state.selectedBundles,searchBundle:SEARCH,recoveryBundle:RECOVERY,record:cold.state.record,authorRoute:cold.state.runtimeWeb.searchProviderId==='candidate-original'});
  assert.deepEqual(cold.state.record,prior);assert.equal(cold.model.isError,false);assert.ok(cold.model.text.includes('作者搜索对照'));
  await unaffected(host,auth,record,'unselected-full-host-start');
  const selected=await host.request('load-search');record.observations.push({stage:'current-search-selection',state:selected});
  const reacquired=await captureSearch(host,auth,record,'current-selection-reacquires');checkCurrent(prior,reacquired,root);
  await host.request('upstream-failure',{enabled:true});const upstream=await captureSearch(host,auth,record,'reacquired-upstream-error');
  checkRequiredSearchError({model:upstream.model,seam:upstream.seam,expectedCode:'CONTROLLED_UPSTREAM_ERROR',originalCallsDelta:upstream.seam.calls.original-upstream.beforeCalls.original});
  assert.ok(upstream.model.text.includes('未切换搜索来源'));await host.request('upstream-failure',{enabled:false});
  await unaffected(host,auth,record,'reacquired');
  const beforeFetch=await host.request('snapshot');const replacement=await host.request('write-profile-web-config',{config:{fetchProvider:'candidate-fetch'}});record.observations.push({stage:'later-fetch-only-config-replacement',state:replacement});
  const afterFetch=await captureSearch(host,auth,record,'search-after-fetch-only-config-replacement');assertGrok(afterFetch);assert.equal(afterFetch.state.authorConfig.searchProvider,undefined);assert.deepEqual(afterFetch.state.record,beforeFetch.record);
  await unaffected(host,auth,record,'after-fetch-only-config-replacement');
  const restartPrior=afterFetch.state.record;await end(host);({host,auth}=await launch(root,false));
  const restarted=await captureSearch(host,auth,record,'valid-intent-normal-full-host-restart');checkCurrent(restartPrior,restarted,root);
  await unaffected(host,auth,record,'valid-intent-normal-full-host-restart');
  await host.request('dispose-owner');const disposed=await captureSearch(host,auth,record,'ordinary-owner-dispose-does-not-release');
  assert.equal(disposed.state.record.policy,'required');assert.equal(disposed.state.record.release,null);
  checkRequiredSearchError({model:disposed.model,seam:disposed.seam,expectedCode:'WEB_PROVIDER_CONFIGURED_MISSING',originalCallsDelta:disposed.seam.calls.original-disposed.beforeCalls.original});
  await unaffected(host,auth,record,'ordinary-owner-dispose');await end(host);passed();

  begin('selected-skipped-then-repair');
  const skipRoot=join(sandbox,runtime.app.version,'selected-skipped');mkdirSync(skipRoot,{recursive:true});
  let skipped=await seed(skipRoot);const skipPrior=(await skipped.host.request('snapshot')).record;await end(skipped.host);
  skipped=await launch(skipRoot,false,{markSelectedSkipped:true});
  const skipState=await skipped.host.request('snapshot');record.observations.push({stage:'selected-bundles-actually-skipped',state:skipState});
  assert.equal(skipState.ownerPresent,false);assert.equal(skipState.recoveryPresent,false);assert.ok(skipState.selectedBundles.includes(SEARCH));assert.deepEqual(skipState.record,skipPrior);
  for(const bundle of[SEARCH,RECOVERY])assert.ok(skipped.host.state.stderr.includes('skipping profile bundle '+JSON.stringify(bundle)),'必须实际经过兼容检查跳过');
  await unaffected(skipped.host,skipped.auth,record,'selected-skipped');
  const repair=await skipped.host.request('repair-selected-bundles');record.observations.push({stage:'repair-retains-current-selection',state:repair});assert.deepEqual(repair.selectedBundles,skipState.selectedBundles);
  const repaired=await captureSearch(skipped.host,skipped.auth,record,'repaired-current-selection-authorizes');checkCurrent(skipPrior,repaired,skipRoot);
  await unaffected(skipped.host,skipped.auth,record,'repaired-current-selection');await end(skipped.host);passed();

  for(const reason of['explicit-plugin-stop','external-provider-pause']){
   begin(reason+'-wins-over-current-selection');const stopRoot=join(sandbox,runtime.app.version,reason);mkdirSync(stopRoot,{recursive:true});
   let stopped=await seed(stopRoot);const applied=await stopped.host.request('confirm-stop',{reason});record.observations.push({stage:reason+'-live-stop',state:applied});
   assert.equal(applied.record.policy,'released');assert.equal(applied.record.release.explicit,true);assert.ok(applied.selectedBundles.includes(SEARCH));retainedFields(applied);
   const stoppedRecord=applied.record;const author=await captureSearch(stopped.host,stopped.auth,record,reason+'-immediate-author');
   checkSelectionHistoryPreserved({before:stoppedRecord,after:author.state.record,diagnosis:author.state.owner.diagnosis,expectedCode:'CONTROL_CONFIRMED_EXIT',grokCallsDelta:author.state.calls.grok-author.beforeCalls.grok});
   assert.equal(author.model.isError,false);assert.ok(author.model.text.includes('作者搜索对照'));await unaffected(stopped.host,stopped.auth,record,reason+'-live');
   await end(stopped.host);stopped=await launch(stopRoot,false);
   const retained=await captureSearch(stopped.host,stopped.auth,record,reason+'-after-full-host-start');
   checkSelectionHistoryPreserved({before:stoppedRecord,after:retained.state.record,diagnosis:retained.state.owner.diagnosis,expectedCode:'CONTROL_CONFIRMED_EXIT',grokCallsDelta:retained.state.calls.grok});
   assert.equal(retained.model.isError,false);assert.ok(retained.model.text.includes('作者搜索对照'));assert.ok(retained.state.selectedBundles.includes(SEARCH));await unaffected(stopped.host,stopped.auth,record,reason+'-restart');await end(stopped.host);passed();
  }

  begin('search-selection-conflict-retains-author');
  const conflictRoot=join(sandbox,runtime.app.version,'selection-conflict');mkdirSync(conflictRoot,{recursive:true});
  let conflict=await seed(conflictRoot);const conflictPrior=(await conflict.host.request('snapshot')).record;await end(conflict.host);
  // Only isolated test profile mutation; the supported user entry itself was confirmed earlier.
  const conflictFile=join(conflictRoot,'dsh-home','profiles','deferred','cordis.patch.yml');
  const {writeFileSync}=await import('node:fs');writeFileSync(conflictFile,JSON.stringify([{id:'web',config:{searchProvider:'candidate-original-new',fetchProvider:'candidate-fetch'}}],null,2)+'\n');
  conflict=await launch(conflictRoot,false);const conflictSearch=await captureSearch(conflict.host,conflict.auth,record,'search-selection-conflict');
  checkSelectionHistoryPreserved({before:conflictPrior,after:conflictSearch.state.record,diagnosis:conflictSearch.state.owner.diagnosis,expectedCode:'CONTROL_SEARCH_SELECTION_CONFLICT',grokCallsDelta:conflictSearch.state.calls.grok});
  assert.equal(conflictSearch.state.runtimeWeb.searchProviderId,'candidate-original-new');assert.equal(conflictSearch.model.isError,true);assert.equal(conflictSearch.seam.error.code,'WEB_PROVIDER_CONFIGURED_MISSING');
  await unaffected(conflict.host,conflict.auth,record,'search-selection-conflict');await end(conflict.host);passed();

  begin('unknown-owner-is-not-overwritten');
  const ownerRoot=join(sandbox,runtime.app.version,'unknown-owner');mkdirSync(ownerRoot,{recursive:true});
  let other=await seed(ownerRoot);const ownerPrior=(await other.host.request('snapshot')).record;await end(other.host);
  other=await launch(ownerRoot,false,{markSelectedSkipped:true});
  await other.host.request('set-runtime-other-owner');
  const otherRepaired=await other.host.request('repair-selected-bundles');record.observations.push({stage:'unknown-owner-before-selection-authorization',state:otherRepaired});
  const otherSearch=await captureSearch(other.host,other.auth,record,'unknown-owner-is-retained');
  checkSelectionHistoryPreserved({before:ownerPrior,after:otherSearch.state.record,diagnosis:otherSearch.state.owner.diagnosis,expectedCode:'CONTROL_OTHER_OWNER',grokCallsDelta:otherSearch.state.calls.grok});
  assert.equal(otherSearch.state.runtimeWeb.searchProviderId,'candidate-other-search');
  checkRequiredSearchError({model:otherSearch.model,seam:otherSearch.seam,expectedCode:'WEB_PROVIDER_CONFIGURED_MISSING',originalCallsDelta:otherSearch.seam.calls.original-otherSearch.beforeCalls.original,grokCallsDelta:otherSearch.state.calls.grok});
  await unaffected(other.host,other.auth,record,'unknown-owner');await end(other.host);passed();

  begin('corrupt-record-is-explicit-error');
  const corruptRoot=join(sandbox,runtime.app.version,'corrupt-record');mkdirSync(corruptRoot,{recursive:true});
  let corrupt=await seed(corruptRoot);await end(corrupt.host);corrupt=await launch(corruptRoot,false,{corruptControlRecord:true});
  const corrupted=await captureSearch(corrupt.host,corrupt.auth,record,'corrupt-existing-control-record');
  assert.ok(corrupted.state.recordError);assert.equal(corrupted.state.record,null);
  checkRequiredSearchError({model:corrupted.model,seam:corrupted.seam,expectedCode:'CONTROL_RECORD_INVALID',originalCallsDelta:corrupted.seam.calls.original-corrupted.beforeCalls.original,grokCallsDelta:corrupted.state.calls.grok});
  assert.match(readFileSync(join(corruptRoot,'dsh-home','profiles','deferred','control-intent.fixture.json'),'utf8'),/^\{invalid-existing-record/);
  await unaffected(corrupt.host,corrupt.auth,record,'corrupt-record');await end(corrupt.host);passed();
  record.status='pass';
 }catch(error){if(activeScenario){activeScenario.status=error instanceof assert.AssertionError?'fail':'harnessError';activeScenario.error={name:error.name,message:error.message};}record.status=error instanceof assert.AssertionError?'fail':'harnessError';record.error={name:error.name,message:error.message,stack:error.stack};}
 finally{for(const index of record.hostIndices){const host=hosts[index];await host.close();if(host.state.timedOut||host.state.closeError||host.state.exitCode!==0){record.status='harnessError';record.cleanup={index,exitCode:host.state.exitCode,closeError:host.state.closeError??null};}}}
 console.log(runtime.app.version+' '+kind+': '+record.status);
}

let fatal;
try{
 const tests=await commandResult(process.execPath,['--test',join(project,'test/deferred-release.test.mjs')],{cwd:project,sanitize,timeoutMs:60000});writeJson(join(directory,'gate-tests.json'),receipt(tests));assert.equal(tests.exitCode,0);
 for(const runtime of runtimes){if(kind==='intent-evidence')await verifyIntentEvidence(runtime);else if(kind==='current-selection')await verifyCurrentSelection(runtime);else await verify(runtime);if(results.at(-1).status!=='pass')break;}
}catch(error){fatal={message:error.message,stack:error.stack};}
finally{
 for(const host of hosts){if(!host.state.stopped)await host.close();const{pending,closed,...state}=host.state;writeJson(join(directory,'host-'+host.index+'.json'),safe(state));}
 const afterHashes=Object.fromEntries(sourcePaths.map(path=>[path,sha256(join(project,path))]));const hashesUnchanged=JSON.stringify(beforeHashes)===JSON.stringify(afterHashes);
 const counts={pass:results.filter(result=>result.status==='pass').length,fail:results.filter(result=>result.status==='fail').length,harnessErrors:results.filter(result=>result.status==='harnessError').length+(fatal?1:0)};
 const exitCode=counts.fail||counts.harnessErrors||!hashesUnchanged||results.length!==2?1:0;
 writeJson(join(directory,'summary.json'),safe({runId,kind,results,counts,exitCode,fatal,...(kind==='intent-evidence'?{purpose:'限定输入识别诊断；pass仅表示歧义可复现',controlCandidateStatus:'blocked',historiesUseSyntheticPriorRecord:true,contextSources}:kind==='current-selection'?{purpose:'D-26 当前选择授权最小隔离验证',controlCandidateStatus:exitCode===0?'limited-pass':'blocked',b2Frozen:true,historiesUseSyntheticPriorRecord:false,contextSources,scenarioCounts:{pass:results.flatMap(r=>r.scenarioResults??[]).filter(r=>r.status==='pass').length,fail:results.flatMap(r=>r.scenarioResults??[]).filter(r=>r.status==='fail').length,harnessErrors:results.flatMap(r=>r.scenarioResults??[]).filter(r=>r.status==='harnessError').length}}:{}),sourceHashes:{before:beforeHashes,after:afterHashes,unchanged:hashesUnchanged},runtimes:runtimes.map(r=>({desktop:r.app.version,node:r.manifest.release.nodeVersion,selector:r.selectorKind})),
 boundaries:kind==='current-selection'?['两版真实官方 Host/HTTP Session；同一源码的隔离候选，离线模型/provider，无收费查询','旧 required 由实际 Host 产生，退出/加载跳过/修复均独立留观察，不使用合成历史','当前选择授权是用户接受的产品规则，不冒称新点击或过去释放提交','停止/暂停与搜索选择冲突优先；普通 dispose 不释放，有效意图重启 Grok 或错误','fetch 为无网络 stub；已确认选择入口不重测，未验收完整 Desktop renderer/watcher','仅临时 DSH_HOME/profile，不改 ASAR/正式 profile，不增加持久 selector/常驻者','局部通过不解冻 B2；真实提示/释放事务、CAS/写失败/在途/跨Host仍未验收']:kind==='intent-evidence'?['两版真实官方runProfile与reconcile；离线模型/provider，无收费查询','旧意图记录为同一合成输入，不冒称实际历史释放已发生','跳过由临时bundle的peer不兼容触发，修复后对比当前探针读取的真实输入','startedBundles是成功加载清单，不是原始选择/跳过原因的历史证明','无ASAR/正式profile/永久selector修改；未执行UI、完整watcher、释放提交或新授权','歧义诊断通过不等于D-16/D-21/B2通过；不推出所有官方机制不可能']:['真实官方 Host/HTTP Session；离线模型与 provider；无网络 fetch stub','显式取消由夹具一次 manifest 写入和 reconcile 驱动，不重测既有选择入口','提示来自宿主原生 missing-provider 结果，文案采用条件句，不伪报历史释放','完整冷启动无本项目组件时不写记录，后续合法组件加载才校正；旧 required 不单独授权接管','未改 ASAR 或正式 profile，无持久 selector、全局 monkey-patch 或新增常驻者','不是完整 Desktop watcher 或 UI 点击验收；未运行在途/CAS/写失败事务；B2 仍须两项全部满足']}));
 writeJson(join(directory,'execution.json'),safe({runId,command:process.execPath,args:process.argv.slice(1),cwd:project,exitCode,output:results.map(result=>result.version+' '+kind+': '+result.status)}));
 console.log(JSON.stringify({runId,kind,directory:sanitize(directory),counts,exitCode},null,2));process.exitCode=exitCode;
}
