#!/usr/bin/env node
// Read-only document audit. This does not run a model, open a database, or grant release permission.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  assert(args[index + 1] && !args[index + 1].startsWith('--'), `${name} requires a value`);
  return args[index + 1];
};
const repository = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const matrixPath = 'docs/plans/threaded-collaboration-compatibility-matrix.md';
const inputPath = path.resolve(repository, option('--matrix', matrixPath));
const outputPath = path.resolve(repository, option('--output', 'docs/reports/evidence/threaded-rc10/acceptance-audit.json'));
const baseline = option('--baseline', '915f106316863f8f681ad891421be3f4ca53cc0b');
assert(/^[a-f0-9]{40}$/.test(baseline), 'Use the full immutable RC09 commit ID');
const hash = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const read = (relative) => readFileSync(path.resolve(repository, relative), 'utf8');
const baselineMatrix = execFileSync('git', ['show', `${baseline}:${matrixPath}`], { cwd: repository, encoding: 'utf8' });
const matrix = readFileSync(inputPath, 'utf8');
const historical = JSON.parse(read('docs/reports/evidence/threaded-rc09/original-text-invariance.json'));

function parse(document) {
  let section = 0;
  const rows = [];
  for (const [offset, line] of document.split('\n').entries()) {
    if (/^## /.test(line)) section = Number(/^## (\d+)/.exec(line)?.[1] ?? 0);
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    const id = /^([A-Z]+\d{2})(?: |$)/.exec(cells[0] ?? '')?.[1];
    if (!id || ![2, 3, 4, 5, 6, 7].includes(section)) continue;
    const family = section === 7 ? 'originalAcceptance' : ({ 2: 'K', 3: 'F', 4: 'P', 5: 'E', 6: 'S' })[section];
    rows.push({ id, family, line: offset + 1, cells });
  }
  const counts = Object.fromEntries(['K', 'F', 'P', 'E', 'S', 'originalAcceptance'].map((family) => [family, rows.filter((row) => row.family === family).length]));
  assert.deepEqual(counts, { K: 16, F: 12, P: 14, E: 6, S: 12, originalAcceptance: 59 });
  assert.equal(new Set(rows.map((row) => row.id)).size, 119, 'All 119 IDs must be unique');
  const payload = {
    coreContracts: rows.filter((row) => row.family === 'K').map(({ id, cells }) => ({ id, contract: cells[1] })),
    acceptanceScenarios: rows.filter((row) => row.family === 'originalAcceptance').map(({ id, cells }) => ({ id, scenario: cells[1], expected: cells[2] })),
  };
  return { rows, counts, payload, enhancementContractCells: rows.filter((row) => row.family === 'E').map(({ cells }) => cells.slice(0, -1)) };
}

const before = parse(baselineMatrix);
const current = parse(matrix);
assert.deepEqual(current.payload, before.payload, 'Original K01–K16 and 59 scenario/expected texts must not change');
assert.deepEqual(current.payload, historical.payload, 'Original texts must also match the archived RC09 extraction');
assert.deepEqual(current.enhancementContractCells, before.enhancementContractCells, 'E01–E06 non-status contract cells must not change');
const originalTextHash = hash(canonical(current.payload));
assert.equal(originalTextHash, '7c0b897370f11707c6204bbf954a1ba0e6efd9df76863815750af55eb63e952e');
const byId = new Map(current.rows.map((row) => [row.id, row]));
const semantic = byId.get('MEM01');
assert(/语义[^。；|]*(?:未实现|待实现)/.test(semantic.cells[5]), 'MEM01 implementation must retain the unimplemented semantic subitem');
assert(/整项[^。；|]*(?:未完整通过|未完成|未通过)/.test(semantic.cells[6]), 'MEM01 must remain incomplete as a whole');

const references = new Map([...matrix.matchAll(/^\[([^\]]+)\]:\s+(\S+)/gm)].map((match) => [match[1], match[2]]));
const localFiles = new Map();
const externalUrls = new Set();
function checkTarget(target) {
  if (/^(?:https?:|app:|codex:)/.test(target)) {
    externalUrls.add(target);
    return { kind: 'external_not_fetched', target };
  }
  if (target.startsWith('#')) return { kind: 'local_anchor_not_resolved', target };
  const withoutAnchor = decodeURIComponent(target.split('#')[0]);
  const absolute = path.resolve(repository, path.dirname(matrixPath), withoutAnchor);
  assert(absolute.startsWith(repository + path.sep), `Local reference escapes repository: ${target}`);
  assert(existsSync(absolute), `Missing local matrix reference: ${target}`);
  const relative = path.relative(repository, absolute);
  if (!localFiles.has(relative)) localFiles.set(relative, absolute === outputPath
    ? { path: relative, sha256: null, hashOmittedReason: 'Audit output references itself through the matrix; existence is checked, self hash excluded.' }
    : { path: relative, sha256: hash(readFileSync(absolute)) });
  return { kind: 'local_file', target, path: relative, sha256: localFiles.get(relative).sha256 };
}
function links(text) {
  const results = [];
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) results.push(checkTarget(match[1]));
  for (const match of text.matchAll(/\[[^\]]+\]\[([^\]]+)\]/g)) {
    assert(references.has(match[1]), `Undefined matrix reference ${match[1]}`);
    results.push({ label: match[1], ...checkTarget(references.get(match[1])) });
  }
  // The matrix uses [C01]/[X01] shorthand as well as full reference syntax.
  for (const match of text.matchAll(/\[((?:C|X)\d{2})\](?!\()/g)) {
    assert(references.has(match[1]), `Undefined fixed source reference ${match[1]}`);
    results.push({ label: match[1], ...checkTarget(references.get(match[1])) });
  }
  return [...new Map(results.map((entry) => [entry.target, entry])).values()];
}
// Validate all local links, including narrative and baseline references, rather than only status cells.
links(matrix);

const blockers = [
  {
    id: 'RC10-G01', classification: 'declared_business_scope_blocker', stage: 'RC04',
    affectedIds: ['K11', 'K12', 'F07', 'F09', 'F10', 'P12', 'S04', 'S05', 'W01', 'W05', 'A04', 'A06', 'A07'],
    state: 'not_observed',
    fact: 'The completed 609 second/71 GET observation saw zero new HEADs; no same Action/root H0→H1→H2 pair of natural remote HEAD changes was observed.',
    exitEvidence: 'Two legally occurring natural HEAD changes with unique wakes, stale prior approval, revision/independent review, same Action/root and original Thread return; preserve the original not_observed result.',
    cannotBeClosedBy: 'Injected PR facts, historical HEAD snapshots, current stable GETs, or a new composite model conversation.',
  },
  {
    id: 'RC10-G02', classification: 'unimplemented_core_integration_blocker', stage: 'RC06',
    affectedIds: ['K06', 'P08', 'S01', 'Q03', 'Q04', 'OS01'],
    state: 'partly_unimplemented',
    fact: 'Production project source write/merge is not delivered; the unique merge owner/baseVersion proof is a fixture. Separate read-only project and artifact roots do not prove source collaboration.',
    exitEvidence: 'Trusted source write profile, complete side-effect resource claims, merge responsibility/version CAS and production restart/conflict evidence.',
    cannotBeClosedBy: 'Relabelling per-agent directories or isolated artifact generation as project source write/merge, or removing the requirement from core/platform contracts.',
  },
  {
    id: 'RC10-G03', classification: 'unimplemented_core_integration_blocker', stage: 'RC06',
    affectedIds: ['K06', 'F06', 'P04', 'P14', 'S04', 'Q05', 'W04'],
    state: 'unimplemented',
    fact: 'A genuinely conflicting command reserve still becomes unknown; automatic persistent resource waiting/retry is not implemented.',
    exitEvidence: 'Persistent waiting with conflict release wakeup, no lost wake/starvation, permission/generation revalidation and no duplicate command side effect.',
    cannotBeClosedBy: 'Uncontended project_manifest_v1 success or a model capacity-only scheduling test.',
  },
  {
    id: 'RC10-G04', classification: 'declared_backend_combination_blocker', stage: 'RC06',
    affectedIds: ['K06', 'K16', 'P04', 'S01', 'ISO01', 'ISO02', 'Q03'],
    state: 'not_verified',
    fact: 'Full legacy and threaded real-supplier contention has not been accepted; coordinator/legacy bridge and injected regressions are separate evidence.',
    exitEvidence: 'Real legacy and threaded execution under shared exclusive/thread/session/account/workspace constraints with original mode contracts and no starvation.',
    cannotBeClosedBy: 'Only legacy unit tests, an old-exclusive coordinator fixture, or two threaded model calls.',
  },
  {
    id: 'RC10-G05', classification: 'declared_backend_combination_blocker', stage: 'RC07',
    affectedIds: ['K07', 'F12', 'P05', 'S02', 'CTX06'],
    state: 'not_verified',
    fact: 'Default-window natural SDK compaction, product HTTP/UI seal and the actual index full native combination remain unverified. Controlled 32k factory compaction is real but narrower.',
    exitEvidence: 'Evidence for each declared native combination, including compatible continuation or explicit cold start and source/ACL preservation through the product entry point.',
    cannotBeClosedBy: 'Synthetic usage, controlled-window factory compaction, or low-level seal alone.',
  },
  {
    id: 'RC10-G06', classification: 'declared_reliability_combination_blocker', stage: 'RC08',
    affectedIds: ['K04', 'K14', 'F04', 'S03', 'M03', 'MM01', 'MM02', 'MM04', 'E01', 'E02', 'E03', 'E04', 'E05', 'E06'],
    state: 'partly_not_verified',
    fact: 'Low-level competition/outbox faults and actual index/provider full cross-combinations have not all been run. The timeout used a paused unsent target and a controlled clock; receipt loss was a same-binding broker retry.',
    exitEvidence: 'Separate evidence for any additionally declared actual supplier cancellation/network loss/outbox competition combination, preserving original replies and one logical callback.',
    cannotBeClosedBy: 'Adding independent passing group counts or presenting a broker-held receipt/paused-target deadline as natural network loss/in-flight supplier timeout.',
  },
  {
    id: 'RC10-G07', classification: 'whole_item_claim_blocker_deferred_advanced_scope', stage: 'EXT01',
    affectedIds: ['F11', 'P09', 'S01', 'S07', 'S08', 'MEM01'],
    state: 'unimplemented',
    fact: 'MEM01 contains semantic retrieval. Base anchors/recent events/source expansion are implemented, but semantic retrieval is not; MEM01 remains incomplete as a whole under the existing S08 deferred scope.',
    exitEvidence: 'Versioned semantic indexing/independent recall/ranking, ACL/revocation closure, source expansion and frozen real-model quality evidence.',
    cannotBeClosedBy: 'Substring search, reranking substring hits, a semantic scaffold, or removing semantic retrieval from the original MEM01 text.',
  },
  {
    id: 'RC10-G08', classification: 'retained_failure_and_availability_disposition', stage: 'RC05/RC08',
    affectedIds: ['K13', 'K15', 'P11', 'S03', 'MM04', 'REC03', 'B01', 'B02'],
    state: 'unresolved_historical_cause',
    fact: 'The original T08 cancellation and two RC05 extended timeouts remain unexplained. Default 1000ms synchronous preparation may fail closed; selected 10000ms roots do not alter the production default.',
    exitEvidence: 'Preserve failed evidence and explicit operational limits. A later successful run may validate its own scope but cannot diagnose the missing original scene.',
    cannotBeClosedBy: 'Successful reruns, the new trusted SDK error code policy, deleting unknown reservations or silently increasing default allowances.',
  },
  {
    id: 'RC10-G09', classification: 'retained_unknown_with_explicit_disposition', stage: 'RC09/RC10',
    affectedIds: ['K13', 'K14', 'K15', 'REC03', 'REC06', 'B02', 'OPS01'],
    state: 'retained_not_replayed',
    fact: 'The RC09 historical 89-row audit retained 12 reservations totaling 206832 tokens: 9 mapped identities and 3 without bridges. RC10 adds 4 retained reservations totaling 87123 tokens, of which one was explicitly held before external send; these are not all claims of unknown supplier execution. The final combined retained balance is 16 reservations/293955 tokens. Historical rows and all reservations remain unchanged by this audit.',
    exitEvidence: 'Keep per-record disposition and fences, distinguishing possibly sent requests from the held/not-externally-sent request. Settlement requires original identity and independent trusted usage/process/resource/business facts; any later release of a demonstrably unsent reservation needs its own audited operation. Zero unknown is not a prerequisite obtainable by guessing.',
    cannotBeClosedBy: 'Process disappearance, later successful requests, matching token totals, automatic refund or blind replay.',
  },
  {
    id: 'RC10-G10', classification: 'subsequent_daily_release_operation_gate', stage: 'RC11/RC12',
    affectedIds: ['K01', 'K14', 'K16', 'P01', 'P10', 'S01', 'DB03', 'UI01', 'OPS01', 'OS01'],
    state: 'not_executed',
    fact: 'Daily target environment remains closed/unconfigured/unmigrated. Backup/restore/migration, observe rehearsal and selected new-Thread rollout have not been performed.',
    exitEvidence: 'RC11 matched backups, schema/worker and restore evidence, then RC12 scoped activation with drain/stop/rollback handoff.',
    cannotBeClosedBy: 'RC10 scripted acceptance, isolated database migration, threaded_only drain or a report saying implementation is complete.',
  },
  {
    id: 'RC10-G11', classification: 'actual_index_real_composite_chain_blocker', stage: 'RC10',
    affectedIds: ['K03', 'K04', 'K10', 'K11', 'K12', 'K14', 'K15', 'F03', 'F04', 'F09', 'F10', 'P11', 'P12', 'S01', 'S03', 'S05', 'M02', 'MM01', 'MM04', 'A03', 'A04', 'A05', 'A06', 'A07', 'B01'],
    state: 'real_composite_chain_not_passed',
    fact: 'RC10 has 7 passing production-factory groups and 1 passing actual-index injected chain, but zero passing complete real-supplier composite chains. The first real run had a post_message visibility parameter rejected by the server. The second failed before response headers after about 10 seconds while activity authorization remained valid; a connection timeout is only a timing-consistent inference, not a confirmed cause. The third reached A→B relay, an original SDK answer and restart with one consultation callback, but its independent reviewer resubmitted changes_requested→approved within the same generation 1. It did not complete new-HEAD revision or return to the original Thread. Partial facts remain evidence of their exact scope, not a whole-chain pass.',
    exitEvidence: 'A complete actual-index real-supplier chain must retain public relay, consultation with failure/timeout, restart, old callback rejection, permission and budget boundaries, then designated-version review, new-HEAD revision/independent re-review and return to the original Thread under the same causal root. Preserve all three failed reports and settle or explicitly retain each reservation independently.',
    cannotBeClosedBy: 'The injected chain, partial third-run milestones, or same-HEAD verdict updates. The existing product review contract permits a reviewer to update a same-HEAD verdict; this trace alone is not a demonstrated production defect and does not justify weakening the original acceptance requirement.',
    evidencePaths: [
      'docs/reports/evidence/threaded-rc10/main-injected-delivery.json',
      'docs/reports/evidence/threaded-rc10/main-injected-delivery-chain-audit.json',
      'docs/reports/evidence/threaded-rc10/main-live-first.json',
      'docs/reports/evidence/threaded-rc10/main-live-second.json',
      'docs/reports/evidence/threaded-rc10/main-live-third.json',
      'docs/reports/evidence/threaded-rc10/real-failure-diagnostics-final.json',
    ],
  },
];
for (const blocker of blockers) for (const id of blocker.affectedIds) assert(byId.has(id), `Unknown mapped ID ${id}`);

const stageSummaries = [
  ['RC01', 'docs/reports/threaded-collaboration-rc01-contracts-2026-10-22.md', 'Source contract audit complete; no implication that missing local implementation passed.'],
  ['RC02', 'docs/reports/threaded-collaboration-rc02-github-2026-10-22.md', 'Optional production GitHub registration and scoped read-only checks complete; daily configuration and natural new event chain not accepted.'],
  ['RC03', 'docs/reports/threaded-collaboration-rc03-commands-hold-2026-10-22.md', 'Selected project_manifest_v1 and hold contract checks complete; no general shell/build or source merge claim.'],
  ['RC04', 'docs/reports/threaded-collaboration-rc04-live-review-2026-10-23.md', '38 dedicated + 70 regression groups; 609 seconds/71 official GETs, zero new HEAD, not_observed; real continuous chain not passed.'],
  ['RC05', 'docs/reports/threaded-collaboration-rc05-fault-recovery-2026-10-23.md', '51 dedicated + 99 regression groups; original timeouts/default activity availability limits and unknown usage retained.'],
  ['RC06', 'docs/reports/threaded-collaboration-rc06-concurrency-2026-10-24.md', '41 dedicated + 88 regression groups; source write/merge, conflicting command waiting and full real legacy contention remain open.'],
  ['RC07', 'docs/reports/threaded-collaboration-rc07-context-2026-10-26.md', '31 dedicated + 83 regression groups; controlled native compaction is separate from default-window/product seal/actual index full native scope.'],
  ['RC08', 'docs/reports/threaded-collaboration-rc08-consultation-2026-10-27.md', '23 dedicated + 84 regression groups; 21 real requests, original T08 cause and full fault cross-combinations remain open.'],
  ['RC09', 'docs/reports/threaded-collaboration-rc09-reconciliation-2026-10-27.md', '24 dedicated + 101 regression groups; no real supplier request, historical 12 unknown reservations retained with disposition.'],
  ['RC10', 'docs/reports/evidence/threaded-rc10/main-live-third.json', '7 production-factory groups and 1 actual-index injected chain passed; zero complete real-supplier chains passed. First-run tool visibility rejection, second-run transport failure before headers and third-run same-generation verdict updates remain failed acceptance results. Third-run relay/SDK original answer/restart/unique consultation callback are partial evidence only; no completed new-HEAD revision and original-Thread return. RC09 historical 12 reservations/206832 tokens plus RC10 4 retained reservations/87123 tokens (one explicitly held before external send) total 16/293955; release remains blocked.'],
].map(([stage, file, conclusion]) => ({ stage, path: file, sha256: hash(read(file)), conclusion }));
stageSummaries.find((item) => item.stage === 'RC10').supportingEvidence = [
  'docs/reports/evidence/threaded-rc10/chain.json',
  ...blockers.find((item) => item.id === 'RC10-G11').evidencePaths,
  'docs/reports/evidence/threaded-rc10/regressions/coexistence-summary.json',
].map((file) => ({ path: file, sha256: hash(read(file)) }));

const deferredIds = new Set(['S08', 'S09', 'S11', 'S12']);
const partialIds = new Set(['MEM01', 'P08', 'F11', 'S01']);
const rows = current.rows.map(({ id, family, cells, line }) => {
  const validation = cells.at(-1);
  const implementation = ['K', 'originalAcceptance'].includes(family) ? cells.at(-2) : validation;
  const related = blockers.filter((blocker) => blocker.affectedIds.includes(id));
  return {
    id, family, line, label: cells[0],
    implementation: {
      state: deferredIds.has(id) ? 'deferred_unimplemented_or_unverified' : partialIds.has(id) ? 'partially_implemented' : 'implementation_or_contract_recorded_see_scope',
      recordedText: implementation,
    },
    verification: {
      wholeItemPassed: id === 'MEM01' ? false : null,
      wholeItemVerdict: id === 'MEM01' ? 'incomplete_semantic_subitem' : 'not_inferred_from_scoped_or_aggregate_evidence',
      recordedText: validation,
      reportedLayerMentions: {
        isolatedOrInjected: /隔离|注入|fixture|合成|受控/.test(validation),
        actualProcessOrOS: /(?:实际|真实)[^。；]*(?:PID|worker|进程|SDK|index|IPC)|SIGKILL/.test(validation),
        realSupplierSubscope: /真实(?:供应商|provider|API)|配置供应商|实际index\/供应商|真实SDK|真实.*请求/.test(validation),
        realBusinessOrReadonlyDomainSubscope: /真实(?:GitHub|域|只读)|实际GitHub|官方GET/.test(validation),
        uiSubscope: /Chrome|UI/.test(validation),
        unverifiedOrLimited: /未验|未通过|未完成|未实现|未交付|未全|不等于|不能|不冒称|限制|仍.*后续/.test(validation),
        observedFailureOrUnknown: /not_observed|失败|unknown|未定位|未知/.test(validation),
      },
      mentionClassificationIsNotAnAcceptanceVerdict: true,
      limitationsInRecordedText: validation.split(/[。；]/).filter((sentence) => /未验|未通过|未完成|未实现|未交付|未全|不等于|不能|不冒称|not_observed|未定位|未知|限制/.test(sentence)),
    },
    evidenceLinks: links(cells.join(' | ')),
    releaseReviewIssues: related.map((blocker) => blocker.id),
    originalCells: cells,
  };
});

const report = {
  schemaVersion: 1, stage: 'RC10', date: '2026-10-27', ok: true,
  scope: 'Read-only release and documentation audit of the immutable RC01–RC09 evidence, RC10 scoped passes and failed real composite chains, plus current 119-row matrix; not an additional behavior test group.',
  baselineCommit: baseline, matrixPath, currentMatrixSha256: hash(matrix),
  checks: {
    uniqueIdsAndExpectedCounts: true,
    coreContractsAndOriginal59TextsUnchanged: true,
    originalTextCanonicalSha256: originalTextHash,
    enhancementNonStatusCellsUnchanged: true,
    mem01WholeItemRemainsIncomplete: true,
    allLocalMatrixFileLinksExist: true,
    referenceLabelsResolved: true,
    noNetworkOrDatabaseAccess: true,
  },
  counts: { ...current.counts, total: rows.length, localLinkedFiles: localFiles.size, externalUrlsNotFetched: externalUrls.size },
  interpretation: [
    'ok means the audit assertions passed. It does not mean RC10 exit, any whole original acceptance item, or release readiness passed.',
    'Every ID retains exact implementation/verification statements and their references. Layer mention tags are conservative text labels, not a semantic upgrade to real or full acceptance.',
    'Existing scoped passing results remain valid within their stated layer. Unverified combinations, original failures and deferred capabilities are not erased.',
    'New composite chain evidence may be added by RC10 but cannot close an independent historical requirement without its own exit evidence.',
    'An advanced deferred capability may be excluded only according to the pre-existing range decision; core contracts cannot be narrowed. MEM01 is never reported as wholly passed while semantic retrieval is absent.',
  ],
  releaseDecision: {
    fullContinuousCollaborationAccepted: false,
    all59Passed: false,
    dailyActivationAuthorizedByThisAudit: false,
    dailyReleaseReady: false,
    coreContractsReduced: false,
    newReliabilityAcceptanceSeparate: true,
    semanticScopeDeferredButMem01Incomplete: true,
    historicalUnknownAutoReleased: false,
    blockingIssueIds: blockers.filter((item) => /blocker/.test(item.classification)).map((item) => item.id),
    dispositionIssueIds: ['RC10-G08', 'RC10-G09'],
    subsequentOperationGateIds: ['RC10-G10'],
  },
  reviewedStages: stageSummaries,
  issues: blockers,
  rows,
  linkedLocalFiles: [...localFiles.values()].sort((a, b) => a.path.localeCompare(b.path)),
  networkRequests: 0, modelRequests: 0, dailyDatabaseRead: false, sharedLedgerRead: false,
};
if (!args.includes('--check-only')) {
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ ok: true, rows: rows.length, core: 16, originalAcceptance: 59, enhancements: 6, originalTextHash, localLinkedFiles: localFiles.size, dailyReleaseReady: false, all59Passed: false, output: args.includes('--check-only') ? null : path.relative(repository, outputPath) }));
