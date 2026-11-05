import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'
const FILE = '/data/dsh-home/profiles/web/package.json'
const pkg = JSON.parse(readFileSync(FILE, 'utf8'))
copyFileSync(FILE, FILE + '.bak-remote-mesh')
console.log('before:', JSON.stringify({ deps: Object.keys(pkg.dependencies || {}), bundles: pkg.dsh?.profile?.bundles }))
pkg.dependencies = pkg.dependencies || {}
delete pkg.dependencies['dsh-proton-workspace-seat']
pkg.dependencies['dsh-proton-workspace-remote-mesh'] = 'link:/opt/dev-plugins/dsh-proton-workspace-remote-mesh'
const bundles = (pkg.dsh?.profile?.bundles || []).filter((b) => b !== 'dsh-proton-workspace-seat')
if (!bundles.includes('dsh-proton-workspace-remote-mesh')) bundles.push('dsh-proton-workspace-remote-mesh')
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = { ...(pkg.dsh.profile || {}), bundles }
writeFileSync(FILE, JSON.stringify(pkg, null, 2) + '\n')
console.log('after:', JSON.stringify({ deps: Object.keys(pkg.dependencies), bundles: pkg.dsh.profile.bundles }))
