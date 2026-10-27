import fs from 'node:fs';
const src = fs.readFileSync('bt_strategies.mjs', 'utf8').split('// ---------- strategy families ----------')[0];
fs.writeFileSync('/tmp/bt_core.mjs', src.replace('import fs from \'node:fs\';', 'import fs from \'node:fs\';') + '\nexport { sim, W };\n');
