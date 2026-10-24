import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { AssignmentFileError, loadAssignmentTable, parseAssignment } from '../src/assignments/index.js'
import type { AssignmentTable } from '../src/assignments/index.js'
import { createInMemoryBoard } from '../src/board/index.js'
import type { TaskBoard } from '../src/board/index.js'
import * as plugin from '../src/index.js'
import { createSelfRestartController } from '../src/lifecycle/index.js'
import { createMockTransport } from '../src/transport/mock.js'
import type { MockTransport } from '../src/transport/mock.js'
import { registerMeshTools } from '../src/tools/index.js'
import type { MeshToolConfig, MeshToolDefinition, MeshToolRuntime } from '../src/tools/index.js'

const ASSIGNMENT_YAML = `nodes:
  node-a: { label: Node A, endpoint: mock://a }
  node-c:
    label: Node C
    endpoint: mock://c

assignments:
  - { workspaceId: ws-1, nodeId: node-a }
  - workspaceId: ws-9
    nodeId: node-c
`

function makeAssignment(): AssignmentTable {
  return parseAssignment(ASSIGNMENT_YAML, 'test-assignment.yml')
}

function makeRuntime(options: {
  board?: TaskBoard
  transport?: MockTransport
  assignment?: AssignmentTable
  config?: Partial<MeshToolConfig>
  newTaskId?: () => string
} = {}): MeshToolRuntime {
  const runtime: MeshToolRuntime = {
    board: options.board ?? createInMemoryBoard(() => 1_000),
    lifecycle: createSelfRestartController({ now: () => 1_000, exit: () => {} }),
    config: {
      transportMode: 'auto',
      leaseMs: 60_000,
      leaseOwner: 'mesh-lead',
      dispatchTimeoutMs: 1_000,
      ...options.config,
    },
    now: () => 1_000,
  }
  if (options.transport !== undefined) runtime.transport = options.transport
  if (options.assignment !== undefined) runtime.assignment = options.assignment
  if (options.newTaskId !== undefined) runtime.newTaskId = options.newTaskId
  return runtime
}

function capture(runtime: MeshToolRuntime): MeshToolDefinition[] {
  const definitions: MeshToolDefinition[] = []
  registerMeshTools(
    {
      tools: {
        register(definition: MeshToolDefinition) {
          definitions.push(definition)
          return () => {}
        },
      },
    },
    runtime,
  )
  return definitions
}

function tool(definitions: readonly MeshToolDefinition[], name: string): MeshToolDefinition {
  const found = definitions.find((definition) => definition.name === name)
  assert.ok(found, 'expected tool ' + name + ' to be registered')
  return found
}

async function invoke(
  definition: MeshToolDefinition,
  args: unknown,
  exec: { signal?: AbortSignal } = {},
): Promise<Record<string, unknown>> {
  return (await definition.execute(args, exec)) as Record<string, unknown>
}

function makeDispatchTransport(autoRespond: boolean): MockTransport {
  return createMockTransport({
    now: () => 1_000,
    nodes: [
      {
        nodeId: 'node-a',
        label: 'Node A',
        endpoint: 'mock://a',
        workspaces: [{ workspaceId: 'ws-1', name: 'One', path: '/w/1' }],
      },
      {
        nodeId: 'node-b',
        label: 'Node B',
        endpoint: 'mock://b',
        online: false,
        workspaces: [{ workspaceId: 'ws-2', name: 'Two', path: '/w/2' }],
      },
    ],
    ...(autoRespond
      ? { autoRespond: () => [{ type: 'assistant/message', text: 'final reply', final: true }] }
      : {}),
  })
}

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-t5-'))
  try {
    run(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- assignment

test('loadAssignmentTable reads the SPEC 5.4 example (nodes + assignments)', () => {
  const file = fileURLToPath(new URL('../../examples/assignment.yml', import.meta.url))
  const table = loadAssignmentTable(file)

  assert.equal(table.file, file)
  assert.deepEqual(
    table.nodes.map((node) => node.nodeId),
    ['local-win', 'shanghai', 'tencent'],
  )
  assert.equal(table.nodes[0]!.label, '本机')
  assert.equal(table.nodes[1]!.endpoint, 'wss://100.x.x.2:7700')
  assert.deepEqual(
    table.assignments.map((route) => [route.workspaceId, route.nodeId]),
    [
      ['ws-blog', 'shanghai'],
      ['ws-newapi', 'shanghai'],
      ['ws-lobe', 'tencent'],
      ['ws-dev', 'local-win'],
    ],
  )
})

test('parseAssignment accepts block and flow mappings, comments, quotes and CRLF', () => {
  const text = [
    '# leading comment',
    'nodes:',
    '  node-a:',
    '    label: "Node A, primary"   # trailing comment',
    "    endpoint: 'mock://a'",
    '  node-b: { label: 节点B, endpoint: wss://x:1 }',
    '',
    'assignments:',
    '  - workspaceId: ws-1',
    '    nodeId: node-a',
    '  - { workspaceId: ws-2, nodeId: node-b }',
  ].join('\r\n')
  const table = parseAssignment(text, 'inline.yml')

  assert.deepEqual(
    table.nodes.map((node) => [node.nodeId, node.label, node.endpoint]),
    [
      ['node-a', 'Node A, primary', 'mock://a'],
      ['node-b', '节点B', 'wss://x:1'],
    ],
  )
  assert.deepEqual(
    table.assignments.map((route) => [route.workspaceId, route.nodeId, route.line]),
    [
      ['ws-1', 'node-a', 9],
      ['ws-2', 'node-b', 11],
    ],
  )
})

test('a missing assignment file fails loudly with its absolute path', () => {
  withTempDir((dir) => {
    const file = join(dir, 'assignment.yml')
    assert.throws(
      () => loadAssignmentTable(file),
      (err) => {
        assert.ok(err instanceof AssignmentFileError)
        assert.equal(err.code, 'missing-file')
        assert.equal(err.line, undefined)
        assert.ok(err.message.includes(file), 'message must include the path')
        assert.ok(err.message.includes('file not found'))
        return true
      },
    )
  })
})

test('a malformed assignment file reports the file path and the failing line', () => {
  const file = 'C:/tmp/assignment.yml'
  const text = ['nodes:', '  node-a:', '    label: A', '    endpoint = http://no-colon'].join('\n')
  assert.throws(
    () => parseAssignment(text, file),
    (err) => {
      assert.ok(err instanceof AssignmentFileError)
      assert.equal(err.line, 4)
      assert.ok(err.message.includes(file), 'message must include the path')
      assert.match(err.message, /line 4/)
      return true
    },
  )
})

test('duplicate workspace assignments fail with the duplicate and first line numbers', () => {
  const text = ['assignments:', '  - { workspaceId: ws-1, nodeId: a }', '  - { workspaceId: ws-1, nodeId: b }'].join('\n')
  assert.throws(
    () => parseAssignment(text, 'dup.yml'),
    (err) => {
      assert.ok(err instanceof AssignmentFileError)
      assert.equal(err.line, 3)
      assert.match(err.message, /assigned more than once/)
      assert.match(err.message, /first at line 2/)
      return true
    },
  )
})

test('unknown sections/keys and tab indentation are rejected with line numbers', () => {
  assert.throws(
    () => parseAssignment('grants:\n  - x\n', 'bad.yml'),
    (err) => err instanceof AssignmentFileError && err.line === 1 && /unknown top-level section/.test(err.message),
  )
  assert.throws(
    () => parseAssignment('nodes:\n  node-a: { label: A, color: red }\n', 'bad.yml'),
    (err) => err instanceof AssignmentFileError && err.line === 2 && /unknown node key "color"/.test(err.message),
  )
  assert.throws(
    () => parseAssignment('nodes:\n\tnode-a: {}\n', 'bad.yml'),
    (err) => err instanceof AssignmentFileError && err.line === 2 && /tabs are not allowed/.test(err.message),
  )
  assert.throws(
    () => parseAssignment('nodes:\n  node-a: { label: \'unterminated }\n', 'bad.yml'),
    (err) => err instanceof AssignmentFileError && err.line === 2 && /unterminated (single-)?quoted string/.test(err.message),
  )
  assert.throws(
    () => parseAssignment('assignments:\n  - { workspaceId: ws-1 }\n', 'bad.yml'),
    (err) => err instanceof AssignmentFileError && err.line === 2 && /nodeId/.test(err.message),
  )
})

test('an empty assignment file is rejected at line 1', () => {
  assert.throws(
    () => parseAssignment('', 'empty.yml'),
    (err) => err instanceof AssignmentFileError && err.line === 1 && /empty/.test(err.message),
  )
})

// -------------------------------------------------------------- registration

test("the plugin exports inject = ['tools'] and registers four mesh tools with raw JSON Schema", () => {
  assert.deepEqual(plugin.inject, ['tools'])

  const definitions = capture(makeRuntime())
  assert.deepEqual(
    definitions.map((definition) => definition.name),
    ['mesh_list_nodes', 'mesh_status', 'mesh_dispatch', 'mesh_task_status'],
  )

  for (const definition of definitions) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 0)
    assert.equal(definition.parameters.type, 'object')
    assert.equal(definition.parameters.additionalProperties, false)
    assert.equal(definition.output.schema.type, 'object')
    assert.equal(definition.output.schema.additionalProperties, false)
    assert.equal(typeof definition.output.render, 'function')
    assert.equal(typeof definition.execute, 'function')
  }

  const dispatch = tool(definitions, 'mesh_dispatch')
  assert.deepEqual(dispatch.parameters.required, ['workspaceId', 'objective'])
  const dispatchProperties = dispatch.parameters.properties as Record<string, Record<string, unknown>>
  assert.deepEqual(Object.keys(dispatchProperties), [
    'workspaceId',
    'nodeId',
    'objective',
    'context',
    'acceptance',
    'sessionMode',
    'sessionId',
    'maxDurationMs',
    'replyMode',
  ])
  assert.deepEqual(dispatchProperties.sessionMode!.enum, ['new', 'resume'])
  assert.deepEqual(dispatchProperties.replyMode!.enum, ['final', 'stream'])

  const listNodes = tool(definitions, 'mesh_list_nodes')
  assert.deepEqual(Object.keys(listNodes.parameters.properties as Record<string, unknown>), ['nodeId', 'workspaceId'])

  const taskStatus = tool(definitions, 'mesh_task_status')
  assert.deepEqual(taskStatus.parameters.required, ['taskId'])
  assert.deepEqual(Object.keys(taskStatus.parameters.properties as Record<string, unknown>), ['taskId'])
})

test('the tool and assignment modules stay zero-dependency and spawn nothing', () => {
  const files = [
    '../../src/tools/types.ts',
    '../../src/tools/status.ts',
    '../../src/tools/list-nodes.ts',
    '../../src/tools/task-status.ts',
    '../../src/tools/dispatch.ts',
    '../../src/tools/protocol.ts',
    '../../src/tools/task-id.ts',
    '../../src/tools/index.ts',
    '../../src/assignments/index.ts',
    '../../src/index.ts',
  ]
  const allowed = new Set(['node:crypto', 'node:fs', 'node:path', '@deepseek-ai/cordis'])
  for (const relative of files) {
    const source = readFileSync(new URL(relative, import.meta.url), 'utf8')
    const specifiers = [...new Set([...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]!))]
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('.') || allowed.has(specifier),
        relative + ' imports unexpected package ' + specifier,
      )
    }
    for (const token of ['child_process', 'spawn(', 'fetch(', 'node:http', 'node:https', 'node:net']) {
      assert.equal(source.includes(token), false, relative + ' must not reference ' + token)
    }
  }

  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
  }
  assert.equal(pkg.dependencies, undefined, 'no runtime dependencies may be added')
  assert.deepEqual(Object.keys(pkg.peerDependencies ?? {}), ['@deepseek-ai/cordis'])
})

// -------------------------------------------------------------------- tools

test('mesh_status works without a transport and reports the degradation', async () => {
  const runtime = makeRuntime({ assignment: makeAssignment() })
  const definitions = capture(runtime)
  const status = await invoke(tool(definitions, 'mesh_status'), {})

  assert.equal(status.plugin, 'dsh-workspace-mesh')
  const transport = status.transport as Record<string, unknown>
  assert.equal(transport.configured, false)
  assert.equal(transport.kind, '')
  assert.match(String(transport.reason), /no transport configured/)

  const assignment = status.assignment as Record<string, unknown>
  assert.equal(assignment.configured, true)
  assert.equal(assignment.nodes, 2)
  assert.equal(assignment.assignments, 2)

  const board = status.board as Record<string, unknown>
  assert.equal(board.total, 0)
  const lifecycle = status.lifecycle as Record<string, unknown>
  assert.equal(lifecycle.state, 'running')
})

test('mesh_list_nodes derives unknown nodes from assignment.yml when no transport exists', async () => {
  const runtime = makeRuntime({ assignment: makeAssignment() })
  const result = await invoke(tool(capture(runtime), 'mesh_list_nodes'), {})

  const transport = result.transport as Record<string, unknown>
  assert.equal(transport.configured, false)
  const peers = result.peers as Array<Record<string, unknown>>
  assert.deepEqual(peers.map((peer) => peer.nodeId), ['node-a', 'node-c'])
  assert.deepEqual(peers.map((peer) => peer.status), ['unknown', 'unknown'])
  assert.deepEqual(peers.map((peer) => peer.source), ['assignment', 'assignment'])
  assert.deepEqual(peers[0]!.assignedWorkspaceIds, ['ws-1'])
  assert.deepEqual(peers[0]!.workspaces, [])
  assert.ok((result.notes as string[]).some((note) => note.includes('no transport configured')))
  assert.equal(
    peers.some((peer) => peer.status === 'online'),
    false,
    'no transport must never fabricate an online node',
  )
})

test('mesh_list_nodes merges transport receipts, preserves unknown nodes and filters', async () => {
  const transport = makeDispatchTransport(true)
  const runtime = makeRuntime({ assignment: makeAssignment(), transport })
  const definitions = capture(runtime)

  const result = await invoke(tool(definitions, 'mesh_list_nodes'), {})
  const peers = result.peers as Array<Record<string, unknown>>
  assert.deepEqual(peers.map((peer) => peer.nodeId), ['node-a', 'node-c', 'node-b'])

  const nodeA = peers[0]!
  assert.equal(nodeA.status, 'online')
  assert.equal(nodeA.source, 'both')
  assert.equal(nodeA.label, 'Node A')
  assert.equal(nodeA.endpoint, 'mock://a')
  assert.equal(nodeA.lastSeenAt, 1_000)
  assert.deepEqual(nodeA.assignedWorkspaceIds, ['ws-1'])
  assert.deepEqual(
    (nodeA.workspaces as Array<Record<string, unknown>>).map((workspace) => [
      workspace.workspaceId,
      workspace.name,
      workspace.path,
      workspace.sessions,
    ]),
    [['ws-1', 'One', '/w/1', 0]],
  )

  const nodeC = peers[1]!
  assert.equal(nodeC.status, 'unknown')
  assert.equal(nodeC.source, 'assignment')

  const nodeB = peers[2]!
  assert.equal(nodeB.status, 'offline')
  assert.equal(nodeB.source, 'transport')
  assert.deepEqual(nodeB.assignedWorkspaceIds, [])

  const byWorkspace = await invoke(tool(definitions, 'mesh_list_nodes'), { workspaceId: 'ws-2' })
  assert.deepEqual(
    (byWorkspace.peers as Array<Record<string, unknown>>).map((peer) => peer.nodeId),
    ['node-b'],
  )

  const byNode = await invoke(tool(definitions, 'mesh_list_nodes'), { nodeId: 'node-c' })
  assert.deepEqual(
    (byNode.peers as Array<Record<string, unknown>>).map((peer) => peer.nodeId),
    ['node-c'],
  )

  const missing = await invoke(tool(definitions, 'mesh_list_nodes'), { nodeId: 'node-z' })
  assert.deepEqual(missing.peers, [])
  assert.ok((missing.notes as string[]).some((note) => note.includes('node-z')))
})

test('mesh_dispatch runs the full P2 path over the mock transport', async () => {
  const transport = makeDispatchTransport(true)
  const board = createInMemoryBoard(() => 1_000)
  let counter = 0
  const runtime = makeRuntime({
    transport,
    board,
    assignment: makeAssignment(),
    newTaskId: () => 'task-' + ++counter,
  })
  const definitions = capture(runtime)

  const output = await invoke(tool(definitions, 'mesh_dispatch'), {
    workspaceId: 'ws-1',
    objective: 'ship P2',
    context: 'context text',
    acceptance: ['tests pass', 'no dependencies'],
  })

  assert.equal(output.ok, true)
  assert.equal(output.state, 'done')
  assert.equal(output.taskId, 'task-1')
  assert.deepEqual(output.target, { nodeId: 'node-a', workspaceId: 'ws-1' })
  const result = output.result as Record<string, unknown>
  assert.equal(result.summary, 'final reply')
  assert.equal(result.sessionId, 'mock-sess-1')

  const task = board.get('task-1')
  assert.ok(task)
  assert.equal(task.state, 'done')
  assert.equal(task.objective, 'ship P2')
  assert.equal(task.result?.summary, 'final reply')
  assert.equal(task.result?.sessionId, 'mock-sess-1')
  assert.equal(task.lease.owner, '', 'the lease is released after the dispatch settles')
  assert.equal(task.lease.fencingToken, 1, 'the first claim opened fencing epoch 1')

  assert.deepEqual(
    transport.calls().map((call) => call.method),
    ['createSession', 'follow', 'prompt'],
  )
  const prompts = transport.prompts('node-a', 'mock-sess-1')
  assert.equal(prompts.length, 1)
  assert.match(prompts[0]!, /\[mesh task task-1\] ship P2/)
  assert.match(prompts[0]!, /context text/)
  assert.match(prompts[0]!, /1\. tests pass/)
  assert.match(prompts[0]!, /2\. no dependencies/)

  const rendered = tool(definitions, 'mesh_dispatch').output.render({}, output)
  assert.equal(rendered.length, 1)
  assert.equal(rendered[0]!.type, 'text')
  assert.match(rendered[0]!.text, /final reply/)
})

test('mesh_task_status returns the Task recorded by dispatch and rejects unknown ids', async () => {
  const transport = makeDispatchTransport(true)
  const board = createInMemoryBoard(() => 1_000)
  const runtime = makeRuntime({
    transport,
    board,
    assignment: makeAssignment(),
    newTaskId: () => 'task-status',
  })
  const definitions = capture(runtime)

  const dispatchOutput = await invoke(tool(definitions, 'mesh_dispatch'), {
    workspaceId: 'ws-1',
    objective: 'status me',
  })
  assert.equal(dispatchOutput.ok, true)

  const task = await invoke(tool(definitions, 'mesh_task_status'), { taskId: 'task-status' })
  assert.equal(task.taskId, 'task-status')
  assert.equal(task.state, 'done')
  assert.deepEqual(task.target, { nodeId: 'node-a', workspaceId: 'ws-1' })
  assert.equal((task.result as Record<string, unknown>).summary, 'final reply')
  assert.equal((task.result as Record<string, unknown>).sessionId, 'mock-sess-1')
  assert.equal((task.lease as Record<string, unknown>).owner, '')
  assert.equal((task.lease as Record<string, unknown>).fencingToken, 1)

  await assert.rejects(async () => {
    await tool(definitions, 'mesh_task_status').execute({ taskId: 'missing' }, {})
  }, /not on this host/)
})

test('mesh_dispatch reports no transport configured without creating a task', async () => {
  const runtime = makeRuntime({ assignment: makeAssignment() })
  const definitions = capture(runtime)
  const output = await invoke(tool(definitions, 'mesh_dispatch'), { workspaceId: 'ws-1', objective: 'x' })

  assert.equal(output.ok, false)
  assert.equal(output.state, 'failed')
  assert.equal(output.taskId, undefined)
  const error = output.error as Record<string, unknown>
  assert.equal(error.code, 'remote-failure')
  assert.match(String(error.message), /no transport configured/)
  assert.equal(runtime.board.list().length, 0, 'degradation happens before the board is touched')
})

test('mesh_dispatch maps transport failures onto MeshErrorCode', async () => {
  const transport = makeDispatchTransport(false)
  transport.setOnline('node-a', false)
  const board = createInMemoryBoard(() => 1_000)
  const runtime = makeRuntime({
    transport,
    board,
    assignment: makeAssignment(),
    newTaskId: () => 'task-offline',
  })

  const output = await invoke(tool(capture(runtime), 'mesh_dispatch'), {
    workspaceId: 'ws-1',
    objective: 'x',
  })
  assert.equal(output.ok, false)
  assert.equal(output.state, 'failed')
  const error = output.error as Record<string, unknown>
  assert.equal(error.code, 'node-offline')
  assert.ok(board.get('task-offline'))
  assert.equal(board.get('task-offline')!.state, 'failed')
  assert.equal(board.get('task-offline')!.lease.owner, '')
})

test('mesh_dispatch maps a follow fault to scope-violation', async () => {
  const transport = makeDispatchTransport(true)
  transport.failNext('follow', { code: 'scope-violation', message: 'workspace not granted' })
  const runtime = makeRuntime({ transport, assignment: makeAssignment(), newTaskId: () => 'task-scope' })

  const output = await invoke(tool(capture(runtime), 'mesh_dispatch'), {
    workspaceId: 'ws-1',
    objective: 'x',
  })
  assert.equal(output.state, 'failed')
  assert.equal((output.error as Record<string, unknown>).code, 'scope-violation')
})

test('mesh_dispatch times out and marks the task expired', async () => {
  const transport = makeDispatchTransport(false)
  const board = createInMemoryBoard(() => 1_000)
  const runtime = makeRuntime({
    transport,
    board,
    assignment: makeAssignment(),
    newTaskId: () => 'task-timeout',
  })

  const output = await invoke(tool(capture(runtime), 'mesh_dispatch'), {
    workspaceId: 'ws-1',
    objective: 'never answers',
    maxDurationMs: 20,
  })
  assert.equal(output.ok, false)
  assert.equal(output.state, 'expired')
  const error = output.error as Record<string, unknown>
  assert.equal(error.code, 'timeout')
  assert.match(String(error.message), /timed out after 20ms/)
  assert.equal(board.get('task-timeout')!.state, 'expired')
})

test('mesh_dispatch rejects a live lease with denied and leaves the task queued', async () => {
  const base = createInMemoryBoard(() => 1_000)
  const board: TaskBoard = { ...base, claim: () => false }
  const transport = makeDispatchTransport(true)
  const runtime = makeRuntime({ transport, board, assignment: makeAssignment(), newTaskId: () => 'task-leased' })

  const output = await invoke(tool(capture(runtime), 'mesh_dispatch'), {
    workspaceId: 'ws-1',
    objective: 'x',
  })
  assert.equal(output.ok, false)
  assert.equal((output.error as Record<string, unknown>).code, 'denied')
  assert.equal(board.get('task-leased')!.state, 'queued')
  assert.equal(board.get('task-leased')!.lease.owner, '')
  assert.deepEqual(
    transport.calls().map((call) => call.method),
    [],
    'a rejected lease means no transport call happens',
  )
})

test('mesh_dispatch resumes an existing session without createSession', async () => {
  const transport = createMockTransport({
    now: () => 1_000,
    nodes: [
      {
        nodeId: 'node-a',
        label: 'Node A',
        workspaces: [{ workspaceId: 'ws-1', sessions: [{ sessionId: 's-legacy', title: 'legacy' }] }],
      },
    ],
    autoRespond: () => [{ type: 'assistant/message', text: 'resumed reply', final: true }],
  })
  const runtime = makeRuntime({ transport, assignment: makeAssignment(), newTaskId: () => 'task-resume' })

  const output = await invoke(tool(capture(runtime), 'mesh_dispatch'), {
    workspaceId: 'ws-1',
    objective: 'continue it',
    sessionMode: 'resume',
    sessionId: 's-legacy',
  })
  assert.equal(output.ok, true)
  assert.equal((output.result as Record<string, unknown>).sessionId, 's-legacy')
  assert.equal((output.result as Record<string, unknown>).summary, 'resumed reply')
  assert.deepEqual(
    transport.calls().map((call) => call.method),
    ['follow', 'prompt'],
    'resume must not create a new session',
  )
  assert.deepEqual(transport.prompts('node-a', 's-legacy'), [
    '[mesh task task-resume] continue it',
  ])
})

test('mesh_dispatch rejects malformed arguments as an ordinary tool error', async () => {
  const definitions = capture(makeRuntime({ transport: makeDispatchTransport(true) }))
  const dispatch = tool(definitions, 'mesh_dispatch')

  const rejects = async (args: unknown, pattern: RegExp): Promise<void> => {
    await assert.rejects(async () => {
      await dispatch.execute(args, {})
    }, pattern)
  }

  await rejects({ objective: 'x' }, /workspaceId/)
  await rejects({ workspaceId: 'ws-1' }, /objective/)
  await rejects({ workspaceId: 'ws-1', objective: 'x', sessionMode: 'resume' }, /sessionId/)
  await rejects({ workspaceId: 'ws-1', objective: 'x', surprise: true }, /unknown argument/)
  await rejects({ workspaceId: 'ws-1', objective: 'x', maxDurationMs: 0 }, /maxDurationMs/)
})

// -------------------------------------------------------------------- apply

test('apply exposes the parsed assignment file through mesh_status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-t5-'))
  try {
    const file = join(dir, 'assignment.yml')
    writeFileSync(file, 'nodes:\n  node-a: { label: A }\nassignments:\n  - { workspaceId: ws-1, nodeId: node-a }\n')
    const registered: MeshToolDefinition[] = []
    const ctx = {
      tools: {
        register(definition: MeshToolDefinition) {
          registered.push(definition)
          return () => {}
        },
      },
      effect(callback: () => unknown) {
        return callback()
      },
    }
    plugin.apply(ctx as never, { assignmentFile: file })
    const status = (await tool(registered, 'mesh_status').execute({}, {})) as {
      assignment: { configured: boolean; file: string; nodes: number; assignments: number }
    }
    assert.equal(status.assignment.configured, true)
    assert.equal(status.assignment.file, file)
    assert.equal(status.assignment.nodes, 1)
    assert.equal(status.assignment.assignments, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply registers the tools, loads a valid assignment file and fails loudly on a bad one', () => {
  const registered: MeshToolDefinition[] = []
  const ctx = {
    tools: {
      register(definition: MeshToolDefinition) {
        registered.push(definition)
        return () => {}
      },
    },
    effect(callback: () => unknown) {
      return callback()
    },
  }

  withTempDir((dir) => {
    const valid = join(dir, 'assignment.yml')
    writeFileSync(valid, 'nodes:\n  node-a: { label: A }\nassignments:\n  - { workspaceId: ws-1, nodeId: node-a }\n')
    plugin.apply(ctx as never, { assignmentFile: valid })
    assert.deepEqual(
      registered.map((definition) => definition.name),
      ['mesh_list_nodes', 'mesh_status', 'mesh_dispatch', 'mesh_task_status'],
    )

    const bad = join(dir, 'bad.yml')
    writeFileSync(bad, 'nodes:\n  node-a:\n    label = A\n')
    assert.throws(
      () => plugin.apply(ctx as never, { assignmentFile: bad }),
      (err) => {
        assert.ok(err instanceof AssignmentFileError)
        assert.ok(err.message.includes(bad))
        assert.equal(err.line, 3)
        return true
      },
    )

    const missing = join(dir, 'missing.yml')
    assert.throws(
      () => plugin.apply(ctx as never, { assignmentFile: missing }),
      (err) => err instanceof AssignmentFileError && err.message.includes(missing) && err.code === 'missing-file',
    )
  })
})
