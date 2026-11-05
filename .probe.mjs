import { readFileSync } from 'node:fs'
const root = '/data/dsh-home/profiles/web/node_modules'
for (const name of ['dsh-proton-workspace', 'dsh-proton-workspace-remote-mesh']) {
  try {
    const path = readFileSync(root + '/' + name + '/package.json', 'utf8')
    const pkg = JSON.parse(path)
    const lib = readFileSync(root + '/' + name + '/lib/client.js', 'utf8')
    console.log(name, 'version', pkg.version, '| addSection in lib:', lib.includes('addSection'), '| applySection:', lib.includes('workspace section'))
  } catch (e) { console.log(name, 'MISSING', String(e).slice(0, 80)) }
}
