import test from 'node:test';
import assert from 'node:assert/strict';
import { split } from '../src/shell.mjs';
for (const separator of [';', '&&', '||', '\n']) test(`list boundary ${JSON.stringify(separator)}`, () => {
  const source = `echo '$x;|#' ${separator} sf org display | jq .`;
  const { segments } = split(source);
  assert.equal(segments.length, 2);
  assert.equal(source.slice(segments[1].elements[0].start, segments[1].elements[0].end), ' sf org display ');
});
for (const source of ['echo "$(echo a; echo b)"; sf org display', 'echo `echo a; echo b`; sf org display', 'echo ${x:-a;b}; sf org display', 'echo $((1+2)); sf org display', 'echo x # ; ignored\nsf org display', "cat <<'EOF'\na; | b\nEOF\nsf org display", 'cat <<A <<"B"\na\nA\nb\nB\nsf org display']) test(`opaque: ${source}`, () => {
  const parsed = split(source);
  assert.equal(parsed.skip, undefined);
  assert.equal(parsed.segments.length, 2);
});
for (const source of ['(sf org display)', '{ sf org display; }', 'f() { sf org display; }', ...['if', 'for', 'while', 'until', 'case', 'select', 'function', '[[', '!'].map(word => `${word} x; sf org display`), 'echo x & sf org display', 'echo x |& sf org display', 'cat <<-EOF\nx\nEOF', 'cat <<EOF\nx', "echo 'oops", 'echo $(oops']) test(`skip: ${source}`, () => assert.ok(split(source).skip));

test('comments and heredocs inside substitutions do not expose false boundaries', () => {
  for (const source of [
    'echo $(echo x # ) ; sf org display\n echo y); sf org display',
    'echo $(cat <<EOF\n) ; sf org display\nEOF\n); sf org display',
  ]) {
    const parsed = split(source);
    assert.equal(parsed.skip, undefined);
    assert.equal(parsed.segments.length, 2);
    assert.equal(source.slice(parsed.segments[1].start), ' sf org display');
  }
});
