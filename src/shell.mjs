// Locate shell boundaries without interpreting words outside candidate sf calls.
export function split(source) {
  const segments = [];
  let elements = [], start = 0, segmentStart = 0, i = 0;
  let quote = '', stack = [], comment = false, pending = [];
  const element = end => {
    const text = source.slice(start, end).trimStart();
    if (/^(?:[({!]|\[\[|(?:if|for|while|until|case|select|function)\b|[\w]+\s*\(\s*\))/.test(text)) throw Error('compound shell command');
    elements.push({ start, end });
  };
  const segment = end => {
    element(end);
    segments.push({ start: segmentStart, end, elements });
    elements = [];
  };
  try {
    while (i < source.length) {
      const c = source[i];
      if (comment && c !== '\n') { i++; continue; }
      if (comment) comment = false;
      if (c === '\\' && quote !== "'") { i += 2; continue; }
      if (quote === "'") { if (c === "'") quote = ''; i++; continue; }
      if (c === '"') { quote = quote === '"' ? '' : '"'; i++; continue; }
      if (c === "'" && !quote) { quote = "'"; i++; continue; }
      if (c === '`') {
        let end = i + 1;
        while (end < source.length && source[end] !== '`') {
          if (source[end] === '\\') end++;
          end++;
        }
        if (end === source.length) end = -1;
        if (end < 0) throw Error('unclosed command substitution');
        i = end + 1; continue;
      }
      if (c === '$' && /[({]/.test(source[i + 1] ?? '')) {
        stack.push({ close: source[i + 1] === '(' ? ')' : '}', quote });
        quote = ''; i += 2; continue;
      }
      if (!quote && c === '#' && (i === 0 || /\s|[;|&]/.test(source[i - 1]))) { comment = true; i++; continue; }
      if (quote) { i++; continue; }
      if (source.startsWith('<<', i)) {
        const match = /^<<\s*(?:'([^']+)'|"([^"]+)"|([\w.-]+))/.exec(source.slice(i));
        if (!match || source[i + 2] === '-') throw Error('unsupported heredoc');
        pending.push(match[1] ?? match[2] ?? match[3]);
        i += match[0].length; continue;
      }
      if (c === '\n' && pending.length) {
        for (const delimiter of pending) {
          let found = false;
          while (i < source.length) {
            const lineStart = i + 1;
            let end = source.indexOf('\n', lineStart);
            if (end < 0) end = source.length;
            i = end;
            if (source.slice(lineStart, end) === delimiter) { found = true; break; }
          }
          if (!found) throw Error('unsupported heredoc terminator');
        }
        pending = [];
        if (!stack.length) { segment(i); start = segmentStart = i + 1; }
        i++; continue;
      }
      if (stack.length && !quote) {
        const top = stack.at(-1);
        if (c === '(' && top.close === ')') stack.push({ close: ')', quote: '' });
        else if (c === top.close) { quote = stack.pop().quote; }
        i++; continue;
      }
      // fd duplication is a redirection, not a background operator.
      if (source.startsWith('>&', i)) { i += 2; continue; }
      if (source.startsWith('|&', i) || (c === '&' && source[i + 1] !== '&')) throw Error('background or stderr pipe');
      if (c === ';' || c === '\n' || source.startsWith('&&', i) || source.startsWith('||', i)) {
        segment(i);
        i += c === '&' || c === '|' ? 2 : 1;
        start = segmentStart = i; continue;
      }
      if (c === '|') { element(i); start = ++i; continue; }
      if (c === '(' || c === ')') throw Error('compound shell command');
      i++;
    }
    if (quote) throw Error('unclosed quote');
    if (stack.length) throw Error('unclosed command substitution');
    if (pending.length) throw Error('unsupported heredoc terminator');
    segment(source.length);
    return { segments };
  } catch (error) { return { skip: error.message }; }
}
