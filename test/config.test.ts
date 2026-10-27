import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../src/config.js'

test('Config.toJSON returns a schemastery envelope with our fields', () => {
  const envelope = Config.toJSON() as {
    uid: number
    refs: Record<string, { type?: string; value?: unknown; dict?: Record<string, number>; list?: number[] }>
  }
  assert.equal(typeof envelope, 'object')
  // the root object schema lives at refs[uid] (schemastery envelope layout)
  const root = envelope.refs[String(envelope.uid)]
  assert.ok(root?.dict, 'object schema must carry a dict')
  for (const field of ['transport', 'peerBaseUrl', 'assignmentFile', 'leaseMs', 'dispatchTimeoutMs', 'leaseOwner']) {
    assert.ok(field in (root.dict ?? {}), `envelope declares ${field}`)
  }
  // the transport union must expose the three modes for the form dropdown
  const unionRef = envelope.refs[String(root.dict?.transport)]
  assert.equal(unionRef?.type, 'union', 'transport renders as a dropdown union')
  const modes = (unionRef.list ?? []).map((refId) => envelope.refs[String(refId)]?.value)
  assert.deepEqual([...modes].sort(), ['auto', 'loopback', 'pairing'])
})

test('~standard.validate applies schema defaults', () => {
  const result = Config['~standard'].validate({})
  assert.equal(result.issues, undefined)
  assert.deepEqual(result.value, {
    transport: 'auto',
    peerBaseUrl: '',
    assignmentFile: '',
    leaseMs: 900000,
    dispatchTimeoutMs: 120000,
    leaseOwner: 'mesh-lead',
  })
})

test('~standard.validate preserves provided values and rejects invalid ones', () => {
  const ok = Config['~standard'].validate({ transport: 'loopback', leaseMs: 5 })
  assert.equal(ok.issues, undefined)
  assert.equal(ok.value?.transport, 'loopback')
  assert.equal(ok.value?.leaseMs, 5)
  assert.ok(Config['~standard'].validate({ transport: 'bogus' }).issues, 'bad enum rejected')
  assert.ok(Config['~standard'].validate({ leaseMs: -1 }).issues, 'negative rejected')
  assert.ok(Config['~standard'].validate({ leaseMs: 1.5 }).issues, 'fractional rejected')
  assert.ok(Config['~standard'].validate({ nope: 1 }).issues, 'unknown field rejected')
  assert.ok(Config['~standard'].validate('nope').issues, 'non-object rejected')
})

test('the envelope rehydrates through the host schemastery runtime', async () => {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  const schema = Schema(Config.toJSON() as never)
  assert.equal(typeof schema, 'function')
  const resolved = schema({ transport: 'pairing' })
  assert.equal(resolved.transport, 'pairing')
  assert.equal(resolved.leaseMs, 900000)
})
