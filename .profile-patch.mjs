import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
const FILE = '/data/dsh-home/profiles/web/cordis.patch.yml'
const text = readFileSync(FILE, 'utf8')
if (text.includes('proton-workspace-remote-mesh')) { console.log('already inserted'); process.exit(0) }
copyFileSync(FILE, FILE + '.bak-remote-mesh')
const anchor = '    - id: proton-workspace\n      name: dsh-proton-workspace\n'
if (!text.includes(anchor)) { console.error('insert anchor missing'); process.exit(1) }
writeFileSync(FILE, text.replace(anchor, anchor + '    - id: proton-workspace-remote-mesh\n      name: dsh-proton-workspace-remote-mesh\n'))
console.log('inserted')
