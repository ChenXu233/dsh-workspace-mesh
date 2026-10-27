import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Config } from '../src/config.js'

interface Envelope {
  uid: number
  refs: Record<string, {
    type?: string
    value?: unknown
    dict?: Record<string, number>
    list?: number[]
    meta?: { default?: unknown; volatile?: boolean; description?: string }
  }>
}

const envelope = (Config as { toJSON(): unknown }).toJSON() as Envelope

test('Config.toJSON returns a volatile schemastery envelope', () => {
  assert.equal(typeof envelope, 'object')
  const root: Envelope['refs'][string] | undefined = envelope.refs[String(envelope.uid)]
  assert.ok(root?.dict, 'object schema must carry a dict')
  for (const field of ['transport', 'peerBaseUrl', 'assignmentFile', 'leaseMs', 'dispatchTimeoutMs', 'leaseOwner']) {
    const ref: Envelope['refs'][string] | undefined = envelope.refs[String(root.dict?.[field])]
    assert.ok(ref, `envelope declares ${field}`)
    assert.equal(ref.meta?.volatile, true, `field ${field} is volatile (form-visible)`)
    assert.equal(typeof ref.meta?.description, 'string', `field ${field} carries a description`)
  }
  const unionRef: Envelope['refs'][string] | undefined = envelope.refs[String(root.dict?.transport)]
  assert.equal(unionRef?.type, 'union', 'transport renders as a dropdown union')
  const modes = (unionRef.list ?? []).map((refId) => envelope.refs[String(refId)]?.value)
  assert.deepEqual([...modes].sort(), ['auto', 'loopback', 'pairing'])
})

test('~standard.validate applies schema defaults and rejects invalid input', () => {
  const validator = (Config as { '~standard': { validate(input: unknown): { value?: Record<string, unknown>; issues?: unknown[] } } })['~standard']
  const ok = validator.validate({})
  assert.equal(ok.issues, undefined)
  // volatile fields resolve to live references; unwrap with .get()
  const live = ok.value as Record<string, { get(): unknown }>
  assert.equal(live.transport?.get(), 'auto')
  assert.equal(live.leaseMs?.get(), 900000)
  const given = validator.validate({ transport: 'loopback', leaseMs: 5 })
  const liveGiven = given.value as Record<string, { get(): unknown }>
  assert.equal(liveGiven.transport?.get(), 'loopback')
  assert.equal(liveGiven.leaseMs?.get(), 5)
  assert.ok(validator.validate({ transport: 'bogus' }).issues, 'bad enum rejected')
  assert.ok(validator.validate({ leaseMs: -1 }).issues, 'negative rejected')
  // schemastery semantics: declared fields validate, unknown keys pass through untouched
  const passthrough = validator.validate({ nope: 1 })
  assert.equal(passthrough.issues, undefined)
  const liveUnknown = passthrough.value as Record<string, { get(): unknown }>
  assert.equal(liveUnknown.leaseMs?.get(), 900000)
  assert.ok(validator.validate('nope').issues, 'non-object rejected')
})

test('the schema face is a rehydrated schemastery object when the peer resolves', async () => {
  assert.equal(typeof (Config as { toJSON?: unknown }).toJSON, 'function')
  assert.ok((Config as Record<string, unknown>)['~standard'], '~standard face present')
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  const twin = Schema(Config as never)
  const resolved = twin({ transport: 'pairing' }) as Record<string, { get(): unknown }>
  assert.equal(resolved.transport?.get(), 'pairing')
  assert.equal(resolved.leaseMs?.get(), 900000)
})
