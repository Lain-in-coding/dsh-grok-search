import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = fileURLToPath(new URL('..',import.meta.url));
const dependencies = resolve(process.argv[2] ?? join(root,'artifacts/chat-browser-runtime/node_modules'));
// Optional immutable installed candidate for before/after comparisons. This
// preview reads it; it never installs or rewrites that profile.
const clientPath=resolve(process.argv[3] ?? join(root,'src/client.js'));
const routes = new Map([
  ['/',[join(root,'fixtures/ui-chat-harness.html'),'text/html; charset=utf-8']],
  ['/client.js',[clientPath,'text/javascript; charset=utf-8']],
  ['/fixture.mjs',[join(root,'test/ui-chat-browser.mjs'),'text/javascript; charset=utf-8']],
  ['/tool-route.css',[join(root,'src/ui/tool-route.css'),'text/css; charset=utf-8']],
  ['/react.js',[join(dependencies,'react/umd/react.production.min.js'),'text/javascript; charset=utf-8']],
  ['/react-dom.js',[join(dependencies,'react-dom/umd/react-dom.production.min.js'),'text/javascript; charset=utf-8']],
]);
const jsx = readFileSync(join(dependencies,'react/cjs/react-jsx-runtime.production.min.js'),'utf8');
const candidate = readFileSync(clientPath,'utf8');
let definition;
const context = vm.createContext({ window: { __ModuleLoader__: { load(value) { definition = value; } } } });
vm.runInContext('globalThis.structuredClone = value => JSON.parse(JSON.stringify(value));', context);
vm.runInContext(candidate, context, { filename: clientPath });
const data = definition.factory(name => {
  if (name === 'react') return { useEffect() {}, useRef: () => ({ current: null }) };
  if (name === 'react/jsx-runtime') return { jsx() {} };
  throw new Error(`Unexpected preview dependency: ${name}`);
}).__test;
// Older frozen candidates predate __test assets, but expose the same lexical
// constants. Never mix a candidate's JavaScript with current working-tree CSS.
const logos = data.LOGOS ?? vm.runInContext('LOGOS', context);
const toolRouteCss = data.TOOL_ROUTE_CSS ?? vm.runInContext('TOOL_ROUTE_CSS', context);
const server = createServer((req,res)=>{
  if(req.method!=='GET'||req.headers.host!==`127.0.0.1:${server.address().port}`){res.writeHead(403);res.end();return;}
  const url = new URL(req.url,'http://localhost');
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  if(url.pathname==='/logos'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(logos));return;}
  if(url.pathname==='/tool-route.css'){
    res.setHeader('Content-Type','text/css; charset=utf-8');
    res.end(toolRouteCss);return;
  }
  if(url.pathname==='/jsx.js'){
    res.setHeader('Content-Type','text/javascript');
    res.end(`(()=>{const exports={},require=name=>{if(name==='react')return window.React;throw new Error(name);};${jsx}\nwindow.__jsx=exports;})();`);
    return;
  }
  const route=routes.get(url.pathname);
  if(!route){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',route[1]);res.end(readFileSync(route[0]));
});
server.listen(0,'127.0.0.1',()=>console.log(`CHAT_CARD_PREVIEW=http://127.0.0.1:${server.address().port}/`));
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>server.close(()=>process.exit(0)));
