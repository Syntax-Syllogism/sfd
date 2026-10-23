import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sfEnvelope, orgEntry } from '../src/sf-json.mjs';
const directory = new URL('./fixtures/sf-json/', import.meta.url);
const fixture = name => JSON.parse(readFileSync(new URL(`${name}.json`, directory), 'utf8'));
for (const name of ['query', 'query-tooling', 'query-relationship', 'describe', 'apex-success', 'org-display-nonscratch', 'org-display-scratch', 'org-list', 'org-list-all', 'org-list-regular']) test(`sf contract: ${name}`, () => {
  const expected = fixture(name);
  const command = name.startsWith('org-list') ? 'orgList' : name.startsWith('org-display') ? 'org' : name.startsWith('apex') ? 'apex' : name.startsWith('query') ? 'query' : name;
  const raw = command === 'orgList' ? { orgs: [...expected.result.nonScratchOrgs, ...expected.result.scratchOrgs].map(row => ({ ...row, accessToken: 'secret', refreshToken: 'refresh', clientSecret: 'client' })) } : { ...expected.result, ...(command === 'org' ? { accessToken: 'secret', refreshToken: 'refresh' } : {}) };
  assert.deepEqual(sfEnvelope(command, { status: 0, result: raw }), expected);
});
for (const name of ['apex-compile-error', 'apex-exception', 'query-error', 'org-display-bad-alias']) test(`sf failure capture: ${name}`, () => {
  const { stack, cause, ...expected } = fixture(name);
  const command = name.startsWith('apex') ? 'apex' : name.startsWith('query') ? 'query' : 'org';
  const response = command === 'apex' ? { status: 0, result: expected.data } : { ...expected, errorCode: expected.data?.errorCode };
  assert.deepEqual(sfEnvelope(command, response), expected);
});
test('group sandbox and dev hub entries and reject unknown auth fields', () => {
  const entry = orgEntry({ username: 'safe', isSandbox: true, isDevHub: true, accessToken: 'secret', refreshToken: 'refresh', clientSecret: 'client', sfdxAuthUrl: 'force://secret' });
  const result = sfEnvelope('orgList', { status: 0, result: { orgs: [entry] } });
  assert.equal(result.result.sandboxes.length, 1);
  assert.equal(result.result.devHubs.length, 1);
  assert.equal(result.result.nonScratchOrgs.length, 1);
  assert.deepEqual(result.result.other, []);
  assert.doesNotMatch(JSON.stringify(result), /"secret"|"refresh"|clientSecret|force:\/\//);
});
test('captures contain no token patterns or auth URLs', () => {
  for (const name of readdirSync(directory).filter(name => name.endsWith('.json'))) assert.doesNotMatch(readFileSync(new URL(name, directory), 'utf8'), /00D[A-Za-z0-9]+!|force:\/\//);
});
