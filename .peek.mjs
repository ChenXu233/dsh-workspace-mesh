import { readFileSync, readdirSync } from 'node:fs'
const dir = '/data/dsh-home/profiles/web/node_modules/dsh-proton-workspace-remote-mesh'
const pkg = JSON.parse(readFileSync(dir + '/package.json', 'utf8'))
console.log('version', pkg.version, '| exports', Object.keys(pkg.exports || {}), '| dsh', JSON.stringify(pkg.dsh))
console.log('files:', readdirSync(dir).join(', '))
