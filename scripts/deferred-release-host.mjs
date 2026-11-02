import {mkdirSync,writeFileSync,readFileSync,copyFileSync,existsSync} from 'node:fs';
import {join,resolve,dirname} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {randomUUID,randomInt} from 'node:crypto';
import {createServer} from 'node:net';
import {createControlIntentStore} from '../src/core/control-intent-store.mjs';

const [archive,directory]=process.argv.slice(2);
const project=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const runtimeRoot=join(archive,'dsh');
const imp=(name,file='lib/index.js')=>import(pathToFileURL(join(runtimeRoot,'node_modules','@deepseek-ai',name,file)).href);
const config=await new Promise(done=>process.once('message',done));
const profile=join(process.env.DSH_HOME,'profiles','deferred');
const basePackage=join(profile,'node_modules','candidate-offline-fixture');
const searchPackage=join(profile,'node_modules','candidate-controlled-search');
const recoveryPackage=join(profile,'node_modules','candidate-search-recovery');
const journalPath=join(profile,'control-intent.fixture.json');
const trace={instanceId:randomUUID(),calls:{original:0,fetch:0,echo:0,grok:0},modelCalls:0,completed:0,existingDisposed:0,sessionEvents:[],toolMessages:[],controlEvents:[]};
globalThis.__DSH_INTERNAL_CANDIDATE__=trace;
trace.currentSelectionAuthorization = config.currentSelectionAuthorization === true;
trace.b2ControlRecord = config.b2ControlRecord === true;
trace.b2RecordFault = config.b2RecordFault ?? null;
const versionedStore = trace.b2ControlRecord ? createControlIntentStore({directory:join(profile,'control-intent.records'),legacyPath:journalPath,trustedRoot:profile}) : null;
let boot,appBoot,closing;
const raw=value=>Object.fromEntries(Object.entries(value??{}).map(([key,item])=>[key,typeof item?.get==='function'?item.get():item]));
function entry(id){const found=[...boot.ctx.loader.entries()].filter(row=>row.options.id===id);if(found.length!==1)throw new Error('Expected one fixture entry '+id);return found[0];}
function selection(){return JSON.parse(readFileSync(join(profile,'package.json'),'utf8')).dsh.profile.bundles;}
function readRecord(){return versionedStore ? versionedStore.read()?.intent ?? null : existsSync(journalPath)?JSON.parse(readFileSync(journalPath,'utf8')):null;}
function recordView(){try{return{record:readRecord(),recordEnvelope:versionedStore?.read()??null,recordError:null};}catch(error){return{record:null,recordError:error.message};}}
function projection(){
 const web=boot?.ctx.get('web');const webFiber=boot?[...boot.ctx.loader.entries()].find(row=>row.options.id==='web'):null;
 return {instanceId:trace.instanceId,calls:trace.calls,modelCalls:trace.modelCalls,completed:trace.completed,sessionEvents:trace.sessionEvents,
  controlEvents:trace.controlEvents,controlError:trace.controlError??null,ownerPresent:Boolean(boot?.ctx.get('candidateControlOwner')),
  recoveryPresent:Boolean(boot?.ctx.get('candidateControlRecovery')),owner:boot?.ctx.get('candidateControlOwner')?.snapshot()??null,recovery:boot?.ctx.get('candidateControlRecovery')?.snapshot()??null,
  startedBundles:[...boot.ctx.profileContext.startedBundles],selectedBundles:selection(),...recordView(),runtimeWeb:web?{searchProviderId:web.searchProviderId??raw(web.config).searchProvider,
   fetchProviderId:web.fetchProviderId??raw(web.config).fetchProvider,searchProviders:[...web.searchProviders.keys()]}:null,
  webConfig:raw(webFiber?.fiber?.config),authorConfig:webFiber?.options.config,webInject:webFiber?.options.inject,
  existingDependencyPresent:Boolean(boot?.ctx.get('candidateExistingDependency')),existingDisposed:trace.existingDisposed};
}
async function reconcile(){const patches=appBoot.readProfilePatches('dsh',boot.ctx.profileContext);await appBoot.reconcileProfilePatches(boot.ctx,patches,'dsh');await boot.ctx.loader.await();return projection();}
function writeSelection(names){const file=join(profile,'package.json');const value=JSON.parse(readFileSync(file,'utf8'));value.dsh.profile.bundles=names;writeFileSync(file,JSON.stringify(value,null,2)+'\n');}
process.on('message',async message=>{
 const{id,op,args={}}=message;if(!id||!op)return;
 try{
  let value;
  if(op==='snapshot')value=projection();
  else if(op==='dispose-owner'){await entry('control-owner').fiber.dispose();await boot.ctx.loader.await();value=projection();}
  else if(op==='dispose-recovery'){await entry('control-recovery').fiber.dispose();await boot.ctx.loader.await();value=projection();}
  else if(op==='cancel-both'){writeSelection(selection().filter(name=>!['candidate-controlled-search','candidate-search-recovery'].includes(name)));value=await reconcile();}
  else if(op==='cancel-search'){writeSelection(selection().filter(name=>name!=='candidate-controlled-search'));value=await reconcile();}
  else if(op==='load-recovery'){writeSelection([...new Set([...selection(),'candidate-search-recovery'])]);value=await reconcile();}
  else if(op==='load-search'){writeSelection([...new Set([...selection(),'candidate-controlled-search'])]);value=await reconcile();}
  else if(op==='repair-and-load-search'){
   for(const packageDir of[searchPackage,recoveryPackage]){const file=join(packageDir,'package.json');const manifest=JSON.parse(readFileSync(file,'utf8'));manifest.peerDependencies['@deepseek-ai/dsh']='0.2.0-rc.2 || 0.2.1-rc.2';writeFileSync(file,JSON.stringify(manifest,null,2));}
   writeSelection(['candidate-offline-fixture','candidate-controlled-search']);value=await reconcile();
  }
  else if(op==='repair-selected-bundles'){
   for(const packageDir of[searchPackage,recoveryPackage]){const file=join(packageDir,'package.json');const manifest=JSON.parse(readFileSync(file,'utf8'));manifest.peerDependencies['@deepseek-ai/dsh']='0.2.0-rc.2 || 0.2.1-rc.2';writeFileSync(file,JSON.stringify(manifest,null,2));}
   value=await reconcile();
  }
  else if(op==='confirm-stop'){
   const owner=boot.ctx.get('candidateControlOwner');if(!owner?.stop)throw new Error('Current selection owner missing');
   await owner.stop(args.reason??'explicit-plugin-stop');value=projection();
  }
  else if(op==='write-profile-web-config'){
   writeFileSync(join(profile,'cordis.patch.yml'),JSON.stringify([{id:'web',config:args.config}],null,2)+'\n');
   value=await reconcile();
  }
  else if(op==='set-runtime-other-owner'){
   entry('web').fiber.update({...raw(entry('web').fiber.config),searchProvider:'candidate-other-search'},true);
   await entry('web').fiber.await();value=projection();
  }
  else if(op==='rebuild-web-from-author'){
   const target=entry('web');target.fiber.update({...target.options.config},true);await target.fiber.await();value=projection();
  }
  else if(op==='wait-recovery'){const service=boot.ctx.get('candidateControlRecovery');if(!service)throw new Error('Recovery fixture absent');await service.retry();value=projection();}
  else if(op==='record-fault'){
   if(!trace.b2ControlRecord || ![null,'before-stage-write','before-publish','after-publish'].includes(args.stage))throw new Error('Invalid record fault stage');
   trace.b2RecordFault=args.stage;value=projection();
  }
  else if(op==='upstream-failure'){trace.upstreamFailure=args.enabled;value=true;}
  else if(op==='seam'){
   try{value={ok:true,result:await boot.ctx.web.search({query:'独立控制查询',maxResults:5})};}
   catch(error){value={ok:false,error:{name:error.name,code:error.code??null,message:error.message}};}
   value.calls={...trace.calls};
  }else if(op==='close'){
   if(!closing)closing=boot.shutdown.shutdown(0);await closing;process.send?.({type:'reply',id,ok:true,value:true});process.disconnect();return;
  }else throw new Error('Unknown deferred fixture operation '+op);
  process.send?.({type:'reply',id,ok:true,value});
 }catch(error){process.send?.({type:'reply',id,ok:false,error:{message:error.message,stack:error.stack}});}
});
try{
 const workspace=join(directory,'workspace');mkdirSync(workspace,{recursive:true});
 let port;
 for(let attempt=0;attempt<20&&port===undefined;attempt++){
  const server=createServer(),candidate=randomInt(20000,60000);
  const bound=await new Promise((done,fail)=>{server.once('error',error=>error.code==='EADDRINUSE'?done(false):fail(error));server.listen(candidate,'127.0.0.1',()=>done(true));});
  if(!bound)continue;await new Promise((done,fail)=>server.close(error=>error?fail(error):done()));port=candidate;
 }
 if(!port)throw new Error('Could not reserve local fixture port');
 const version=JSON.parse(readFileSync(join(runtimeRoot,'package.json'),'utf8')).version;
 if(config.initialize!==false){
  for(const path of[profile,basePackage,searchPackage,recoveryPackage])mkdirSync(path,{recursive:true});
  copyFileSync(join(project,'fixtures/internal-candidate/host-fixture.mjs'),join(basePackage,'fixture.mjs'));
  const exports={};
  for(const[label,apply,inject]of[['model','applyModel',['llm','tools']],['providers','applyProviders',['web']],['existing','applyExisting',[]],['observer','applyObserver',['sessionController','connection','webServer','typertGateway']]]){
   writeFileSync(join(basePackage,label+'.mjs'),`export {${apply} as apply} from './fixture.mjs';export const name='deferred-${label}';export const inject=${JSON.stringify(inject)};\n`);exports['./'+label]='./'+label+'.mjs';
  }
  writeFileSync(join(basePackage,'package.json'),JSON.stringify({name:'candidate-offline-fixture',version:'0.0.0',private:true,type:'module',exports:{'./package.json':'./package.json','./cordis.patch.yml':'./cordis.patch.yml',...exports},dsh:{bundle:{patch:'./cordis.patch.yml'}}},null,2));
  for(const[path,name,kind]of[[searchPackage,'candidate-controlled-search','search'],[recoveryPackage,'candidate-search-recovery','recovery']]){
   for (const module of ['control-intent-store.mjs','startup-recovery.mjs']) copyFileSync(join(project,'src/core',module),join(path,module));
   writeFileSync(join(path,'control.mjs'),readFileSync(join(project,'fixtures/deferred-release/control.mjs'),'utf8').replaceAll('../../src/core/','./'));
   const extra={};
   for(const[label,apply,inject]of kind==='search'?[['owner','applyOwner',['loader','profileContext']],['provider','applyProvider',['web','candidateControlOwner']]]:[['recovery','applyRecovery',['loader','profileContext']]]){
    writeFileSync(join(path,label+'.mjs'),`export {${apply} as apply} from './control.mjs';export const name='deferred-${label}';export const inject=${JSON.stringify(inject)};\n`);extra['./'+label]='./'+label+'.mjs';
   }
   writeFileSync(join(path,'package.json'),JSON.stringify({name,version:'0.0.0',private:true,type:'module',exports:{'./package.json':'./package.json','./cordis.patch.yml':'./cordis.patch.yml',...extra},peerDependencies:{'@deepseek-ai/dsh':'0.2.0-rc.2 || 0.2.1-rc.2'},dsh:{bundle:{patch:'./cordis.patch.yml'}}},null,2));
   writeFileSync(join(path,'cordis.patch.yml'),JSON.stringify([{insert:kind==='search'?[{id:'control-owner',name:name+'/owner'},{id:'control-provider',name:name+'/provider'}]:[{id:'control-recovery',name:name+'/recovery'}]}],null,2));
  }
  writeFileSync(join(profile,'package.json'),JSON.stringify({name:'deferred-fixture-profile',version:'0.0.0',private:true,type:'module',dependencies:{'candidate-offline-fixture':'0.0.0','candidate-controlled-search':'0.0.0','candidate-search-recovery':'0.0.0'},dsh:{profile:{bundles:['candidate-offline-fixture','candidate-controlled-search','candidate-search-recovery']}}},null,2));
  writeFileSync(join(profile,'cordis.patch.yml'),'[]\n');
 }
 if(config.markSelectedSkipped){
  for(const packageDir of[searchPackage,recoveryPackage]){const file=join(packageDir,'package.json');const manifest=JSON.parse(readFileSync(file,'utf8'));manifest.peerDependencies['@deepseek-ai/dsh']='0.0.0';writeFileSync(file,JSON.stringify(manifest,null,2));}
 }
 if(config.corruptControlRecord){
  if(!existsSync(journalPath))throw new Error('Cannot corrupt an absent control record');
  writeFileSync(journalPath,'{invalid-existing-record\n');
 }
 if(config.intentEvidence){
  if(!['unselected','skipped'].includes(config.intentEvidence))throw new Error('Invalid intent-evidence history');
  writeFileSync(journalPath,JSON.stringify(config.intentRecord,null,2)+'\n',{flag:'wx'});
  if(config.intentEvidence==='unselected')writeSelection(['candidate-offline-fixture']);
  else for(const packageDir of[searchPackage,recoveryPackage]){const file=join(packageDir,'package.json');const manifest=JSON.parse(readFileSync(file,'utf8'));manifest.peerDependencies['@deepseek-ai/dsh']='0.0.0';writeFileSync(file,JSON.stringify(manifest,null,2));}
 }
 const index=join(profile,'index.html');writeFileSync(index,'<!doctype html><html lang="zh-CN"><body>隔离控制验证</body></html>');
 const row=(id,name,options={})=>({id,name:'@deepseek-ai/'+name,config:options});
 const rows=[
  row('timer','cordis-plugin-timer'),row('config-editor','dsh-config-editor'),
  row('llm','dsh-llm'),row('sessions','dsh-session'),row('agents','dsh-agent'),row('session-projections','dsh-session-projection'),row('system-prompt','dsh-system-prompt'),
  row('tools','dsh-tools',{mode:'native'}),row('agent-loop','dsh-agent-loop',{agents:[]}),row('default-model','dsh-agent-default-model',{provider:'candidate-offline',model:'fixture-native'}),
  row('fs','dsh-fs-local',{cwd:workspace}),row('attachments','dsh-attachment-local',{dshHome:process.env.DSH_HOME}),
  row('session-persistence','dsh-session-persistence-jsonl',{root:join(directory,'sessions')}),row('session-query','dsh-session-query-sqlite',{path:join(directory,'session-index.sqlite'),openAt:'never'}),
  row('storage','dsh-storage'),row('storage-json','dsh-storage-json',{root:join(directory,'storage')}),row('storage-domain','dsh-storage-domain',{backend:'json'}),row('workspace','dsh-workspace'),
  row('credentials','dsh-credentials-local',{dshHome:process.env.DSH_HOME,watch:false}),row('connection','dsh-client-connection'),row('commands','dsh-commands'),row('file-upload','dsh-client-file-upload'),
  row('typert','dsh-typert-registry'),row('typert-loader','dsh-typert-loader'),...(version==='0.2.1-rc.2'?[row('remote-access','dsh-api-remote-access')]:[]),
  row('gateway','dsh-api-gateway'),row('session-controller','dsh-api-session-controller',{nativeOpen:false}),row('webserver','dsh-host-webserver',{host:'127.0.0.1',port,compression:'none'}),
  row('frontend','dsh-host-frontend-static',{distIndex:index}),{...row('web','dsh-web',{searchProvider:'candidate-original',fetchProvider:'candidate-fetch'}),inject:{candidateExistingDependency:{probe:'retain-existing'}}},
  row('tool-web','dsh-tool-web',{searchTimeoutMs:120000,fetchTimeoutMs:30000}),
  {id:'fixture-model',name:'candidate-offline-fixture/model'},{id:'fixture-providers',name:'candidate-offline-fixture/providers'},
  {id:'fixture-existing',name:'candidate-offline-fixture/existing'},{id:'fixture-observer',name:'candidate-offline-fixture/observer'},
 ];
 writeFileSync(join(basePackage,'cordis.patch.yml'),JSON.stringify([{insert:rows}],null,2));
 appBoot=await imp('dsh-app-boot');const{runProfile}=await imp('dsh','lib/profile-boot.js');
 boot=await runProfile({environment:appBoot.loadLayeredEnv('dsh',directory),profile:'deferred',patchFiles:[],args:[]});
 await boot.ctx.loader.await();
 const failed=[...boot.ctx.loader.entries()].filter(row=>row.fiber?.error).map(row=>({id:row.options.id,error:String(row.fiber.error)}));
 const pending=[...boot.ctx.loader.entries()].filter(row=>row.fiber?.state!==2).map(row=>({id:row.options.id,state:row.fiber?.state??null}));
 process.send?.({type:'ready',workspace,failed,pending,versions:{node:process.versions.node,electron:process.versions.electron},...projection()});
}catch(error){process.send?.({type:'fatal',error:{message:error.message,stack:error.stack}});if(boot)await boot.shutdown.shutdown(1);process.exitCode=1;process.disconnect();}
