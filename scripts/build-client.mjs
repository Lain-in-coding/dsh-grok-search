import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_DESCRIPTORS } from '../src/settings-ui.mjs';
import { createSettingsCodec } from '../src/core/settings-codec.mjs';
import { createSourceChain } from '../src/core/source-chain.mjs';
import { createRouteController } from '../src/ui/route-controller.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const logoDir = join(root, 'src', 'assets', 'logos');
const data = {
  harness: `data:image/png;base64,${readFileSync(join(logoDir, 'deepseek-harness.png')).toString('base64')}`,
  deepseek: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'deepseek-whale.svg')).toString('base64')}`,
  grok: `data:image/png;base64,${readFileSync(join(logoDir, 'grok.png')).toString('base64')}`,
  tavily: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'tavily-mark-black.svg')).toString('base64')}`,
  tavilyDark: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'tavily-mark-offwhite.svg')).toString('base64')}`,
  exa: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'exa-logomark-blue.svg')).toString('base64')}`,
  exaDark: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'exa-logomark-white.svg')).toString('base64')}`,
  tinyfish: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'tinyfish-icon.svg')).toString('base64')}`,
  firecrawl: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'firecrawl-logo.svg')).toString('base64')}`,
  github: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'github-invertocat-black.svg')).toString('base64')}`,
  githubDark: `data:image/svg+xml;base64,${readFileSync(join(logoDir, 'github-invertocat-white.svg')).toString('base64')}`,
};
const template = readFileSync(join(root, 'src', 'client.template.js'), 'utf8');
// Serialize the wire contract, then revive codec functions in the browser.
// JSON.stringify includes jsonSchema getters but never embeds host services.
const descriptors = JSON.stringify(SETTINGS_DESCRIPTORS);
writeFileSync(join(root, 'src', 'client.js'), template
  .replace('__LOGOS__', () => JSON.stringify(data))
  .replace('__CODEC_FACTORY__', () => createSettingsCodec.toString())
  .replace('__SOURCE_CHAIN_FACTORY__', () => createSourceChain.toString())
  .replace('__ROUTE_CONTROLLER_FACTORY__', () => createRouteController.toString())
  .replace('__ROUTE_CSS__', () => JSON.stringify(readFileSync(join(root, 'src/ui/route.css'), 'utf8')))
  .replace('__ROUTE_CARD__', () => JSON.stringify(readFileSync(join(root, 'src/ui/route-card.html'), 'utf8')))
  .replace('__ROUTE_LAYER__', () => JSON.stringify(readFileSync(join(root, 'src/ui/route-layer.html'), 'utf8')))
  .replace('__SETTINGS_DESCRIPTORS__', () => descriptors));
