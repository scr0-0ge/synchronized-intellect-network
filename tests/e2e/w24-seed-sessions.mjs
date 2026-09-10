// Offline pre-existing Session data for the report-only walkthrough.
// Close the production app first. No production adapter or provider is loaded.
// .\pnpm.bat exec node tests/e2e/w24-seed-sessions.mjs <own uaw-w24-* profile>
import assert from 'node:assert/strict';
import { realpath, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { createWorkbenchCoordinator } from '../../src/coordinator/index.ts';

const root = await realpath(process.argv[2]);
assert.equal(dirname(root), await realpath(process.env.APPDATA));
assert.ok(basename(root).startsWith('uaw-w24-'));
const data = join(root, 'workbench-project-host');
const registry = JSON.parse(await readFile(join(data, 'project-registry-v1.json'), 'utf8'));
const profile = { model: 'gpt-5.6-sol', effortLevel: 'high', executionMode: 'single-agent', accessMode: 'full-access' };
const observations = [];
const unknownOnly = process.argv.includes('--unknown-only');
for (const project of registry.records.filter(p => ['工作笔记', '旅行计划'].includes(basename(p.canonicalDirectory)))) {
  if (unknownOnly && basename(project.canonicalDirectory) !== '工作笔记') continue;
  const adapter = {
    async inspect() { return {runtime:'codex', models:[{id:profile.model,effortLevels:['high']}],executionModes:['single-agent'],accessModes:['full-access']}; },
    async start() {
      const unknown = adapter.unknown;
      return {
        profile, opaqueSessionReference: `w24-offline-${Date.now()}`,
        async send() {},
        async *events() {
          yield {kind:'session-started'};
          if (unknown) return;
          yield {kind:'turn-started'};
          yield {kind:'agent-message',text:'这是本地合成的既有会话，用于归档、恢复和删除走查。没有请求任何真实模型。'};
          yield {kind:'turn-completed',status:'completed'};
        },
      };
    },
    async resume() { throw new Error('w24 never resumes a provider'); },
  };
  const channel = await createWorkbenchCoordinator({databasePath:join(data,'project-ledgers',`${project.ledgerSlot}.sqlite`),adapter}).openProject(project.canonicalDirectory);
  try {
    const labels = unknownOnly ? ['断线后的会话'] : basename(project.canonicalDirectory) === '工作笔记' ? ['周会纪要', '待整理的购物清单', '断线后的会话'] : ['行程初稿'];
    for (const label of labels) {
      adapter.unknown = label === '断线后的会话';
      const receipt = await channel.act({kind:'direct',commandKind:'start',idempotencyKey:`w24-${label}${unknownOnly ? '-alternate-exit' : ''}`,runtime:'codex',catalogRevision:'w24-offline-fixture',preferences:{global:profile},profile,input:`本地离线样本：${label}`});
      let terminal;
      for (let n = 0; n < 200; n++) {
        const command = (await channel.snapshot()).commands.find(c => c.commandId === receipt.commandId);
        if (command && ['completed','failed','recovery-required'].includes(command.status)) { terminal=command; break; }
        await new Promise(r => setTimeout(r, 25));
      }
      assert.ok(terminal?.session, 'offline sample must settle');
      assert.equal(terminal.status, adapter.unknown ? 'recovery-required' : 'completed');
      await channel.mutateSessionMetadata({sessionId:terminal.session.sessionId,operation:{kind:'rename',displayName:label}});
      observations.push({project:basename(project.canonicalDirectory),label,status:terminal.status,sessionId:terminal.session.sessionId});
    }
  } finally { await channel.close(); }
}
await writeFile(`.scratch/unified-ai-workbench/evidence/w24-real-use/${unknownOnly ? 'seed-alternate-exit' : 'seed'}.json`, JSON.stringify(observations,null,2));
console.log(JSON.stringify(observations,null,2));
