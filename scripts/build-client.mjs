import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifact = join(root, 'src', 'client.js');
const logoFiles = {
  harness: 'deepseek-harness-settings.png',
  harnessChat: 'deepseek-harness-chat-light.png',
  harnessChatDark: 'deepseek-harness-chat-dark.png',
  deepseek: 'deepseek-whale.svg',
  grok: 'grok.png',
  tavily: 'tavily-mark-black.svg',
  tavilyDark: 'tavily-mark-offwhite.svg',
  exa: 'exa-logomark-blue.svg',
  exaDark: 'exa-logomark-white.svg',
  tinyfish: 'tinyfish-icon.svg',
  firecrawl: 'firecrawl-logo.svg',
  github: 'github-invertocat-black.svg',
  githubDark: 'github-invertocat-white.svg',
};

function clientData() {
  const text = name => readFileSync(join(root, 'src', 'ui', name), 'utf8');
  const LOGOS = Object.fromEntries(Object.entries(logoFiles).map(([key, file]) => [key,
    `data:image/${file.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${readFileSync(join(root, 'src', 'assets', 'logos', file)).toString('base64')}`,
  ]));
  // Only wire JSON crosses this boundary. Host services are never browser inputs.
  const data = { LOGOS, SETTINGS_DESCRIPTORS, TOOL_ROUTE_CSS: text('tool-route.css'),
    ROUTE_CSS: text('route.css') + '\n' + text('search-log.css'),
    ROUTE_CARD: text('route-card.html'), ROUTE_LAYER: text('route-layer.html') };
  return Object.entries(data).map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`).join('\n');
}

export async function buildClient() {
  const data = clientData();
  const result = await build({
    absWorkingDir: root,
    entryPoints: ['src/client.template.js'],
    outfile: 'src/client.js',
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    metafile: true,
    write: false,
    plugins: [{
      name: 'dsh-client-inputs',
      setup(builder) {
        builder.onResolve({ filter: /^dsh:client-data$/ }, () => ({ path: 'data', namespace: 'dsh-client' }));
        builder.onLoad({ filter: /^data$/, namespace: 'dsh-client' }, () => ({ contents: data, loader: 'js' }));
        builder.onResolve({ filter: /^(?:node:|react(?:\/|$)|react-dom(?:\/|$)|@deepseek-ai\/)/ }, args => ({
          errors: [{ text: `Browser inputs cannot import ${args.path}; host React must stay inside ModuleLoader.factory.` }],
        }));
      },
    }],
  });
  if (result.outputFiles.length !== 1) throw new Error('Expected exactly one client JavaScript artifact.');
  return { code: result.outputFiles[0].text, metafile: result.metafile };
}

export function checkClientArtifact(code, path = artifact) {
  if (!readFileSync(path).equals(Buffer.from(code))) throw new Error('src/client.js is stale. Run npm run build:client.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length > 1 || args.length === 1 && args[0] !== '--check') {
    throw new Error('Usage: node scripts/build-client.mjs [--check]');
  }
  const { code } = await buildClient();
  if (args[0] === '--check') {
    checkClientArtifact(code);
    console.log('Client artifact matches current browser inputs.');
  } else {
    writeFileSync(artifact, code);
    console.log('Built src/client.js from browser ESM inputs.');
  }
}
