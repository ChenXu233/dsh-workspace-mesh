import { readFileSync, writeFileSync } from 'node:fs'
let anchor = readFileSync('src/api/anchor.ts', 'utf8')
const oldTitle = "  const title = repositoryName(target.remoteCwd, workspaceId)\n"
if (!anchor.includes(oldTitle)) { console.error('A: title anchor missing'); process.exit(1) }
anchor = anchor.replace(oldTitle, "  const title = `${repositoryName(target.remoteCwd, workspaceId)} @${target.nodeLabel}`\n")
writeFileSync('src/api/anchor.ts', anchor)

let t = readFileSync('test/anchor-route.test.ts', 'utf8')
t = t.replace("and a plain titled record', async (t) => {", "and a titled native record', async (t) => {")
t = t.replace("  // The owning machine is a render-time fact, not part of the name: a rename\n  // must not have to re-derive it, and the row draws it from the anchor listing.\n  assert.equal(result.workspace.title, 'blog')", "  assert.equal(result.workspace.title, 'blog @Cloud')")
writeFileSync('test/anchor-route.test.ts', t)
console.log('A done')
