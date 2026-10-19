import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** A deterministic in-process executor; never imports a provider or spawns a process. */
export function createFakeThreadedExecutor(resources) {
  const calls = [];
  const scenarios = [];
  const entered = [];
  return {
    calls,
    enqueue(scenario) { scenarios.push(scenario); },
    async execute(input) {
      calls.push(input);
      const scenario = scenarios.shift();
      assert.ok(scenario, 'Unexpected fake execution');
      resources.setAlive(input.binding, true);
      entered.shift()?.resolve(input);
      return scenario(input, resources);
    },
    nextCall() {
      const gate = deferred();
      entered.push(gate);
      return gate.promise;
    },
    assertDrained() { assert.equal(scenarios.length, 0, 'An expected fake invocation never ran'); },
  };
}

/** Only fixture code can mint a proof; copying its JSON must not grant release authority. */
export function createFakeThreadedResources() {
  const claims = new Map();
  const proofs = new WeakSet();
  const generations = new Map();
  const releases = [];
  const claimFor = value => claims.get(value.claimId);
  const identityMatches = (claim, value) => claim
    && ['claimId', 'attemptId', 'generation', 'fencingToken'].every(key => claim[key] === value[key]);
  return {
    claims,
    releases,
    acquire(input) {
      const slot = `${input.threadId}:${input.agentId}`;
      const generation = (generations.get(slot) ?? 0) + 1;
      generations.set(slot, generation);
      const claim = { ...input, attemptId: input.attemptId ?? randomUUID(), claimId: randomUUID(),
        generation, fencingToken: randomUUID(), claimOwner: randomUUID() };
      claims.set(claim.claimId, { ...claim, held: true, alive: false });
      return claim;
    },
    assertCurrent(binding) {
      const claim = claimFor(binding);
      if (!identityMatches(claim, binding) || !claim.held) throw new Error('FAKE_STALE_RESOURCE_CLAIM');
      for (const key of ['threadId', 'invocationId', 'runId', 'ownerId', 'agentId', 'claimOwner']) {
        if (key === 'claimOwner' && valueIsBinding(binding)) continue;
        if (claim[key] !== undefined && claim[key] !== binding[key]) throw new Error('FAKE_WRONG_RESOURCE_SCOPE');
      }
    },
    setAlive(binding, alive) {
      this.assertCurrent(binding);
      claimFor(binding).alive = alive;
    },
    isHeld(binding) { return !!claimFor(binding)?.held; },
    isAlive(binding) { return !!claimFor(binding)?.alive; },
    quiescent(binding, extra = {}) {
      this.assertCurrent(binding);
      assert.equal(this.isAlive(binding), false, 'A live executor cannot furnish a quiescence proof');
      const proof = { schemaVersion: 1, id: randomUUID(), attemptId: binding.attemptId, claimId: binding.claimId,
        generation: binding.generation, fencingToken: binding.fencingToken,
        reason: 'process_exited', sideEffects: 'reconciled', ...extra };
      proofs.add(proof);
      return proof;
    },
    verifyQuiescence(binding, proof) {
      // Cleanup may repeat after release succeeded but its database acknowledgement failed.
      if (!identityMatches(claimFor(binding), binding) || !proofs.has(proof)
        || this.isAlive(binding) || !identityMatches(proof, binding)
        || !['none', 'reconciled'].includes(proof.sideEffects)) throw new Error('FAKE_INVALID_QUIESCENCE_PROOF');
    },
    release(binding, proof) {
      this.verifyQuiescence(binding, proof);
      if (!claimFor(binding).held) return;
      claimFor(binding).held = false;
      releases.push({ binding, proof });
    },
  };
}

const valueIsBinding = value => value.origin === 'threaded_invocation_attempt';
