const fs = require('fs');

function checkFile(path) {
  const src = fs.readFileSync(path, 'utf8');
  const stack = [];
  const pairs = { '{': '}', '(': ')', '[': ']' };
  const openers = new Set(Object.keys(pairs));
  const closers = new Set(Object.values(pairs));

  let line = 1;
  let col = 0;
  let i = 0;
  let inSingle = false, inDouble = false, inBack = false;
  let inBlockComment = false, inLineComment = false;

  function prevNonSpace(idx) {
    for (let j = idx - 1; j >= 0; j--) {
      const c = src[j];
      if (c === '\n') return '\n';
      if (!/\s/.test(c)) return c;
    }
    return '\n';
  }

  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    col++;

    // Handle newlines
    if (ch === '\n') {
      line++; col = 0; inLineComment = false; i++; continue;
    }

    // Handle line comments
    if (!inSingle && !inDouble && !inBack && !inBlockComment && !inLineComment && ch === '/' && next === '/') {
      inLineComment = true; i += 2; col++; continue;
    }

    // Handle block comments
    if (!inSingle && !inDouble && !inBack && !inBlockComment && !inLineComment && ch === '/' && next === '*') {
      inBlockComment = true; i += 2; col++; continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i += 2; col++; continue; }
      i++; continue;
    }
    if (inLineComment) { i++; continue; }

    // Handle strings
    if (!inDouble && !inBack && ch === "'" && !inSingle) { inSingle = true; i++; continue; }
    if (inSingle) {
      if (ch === '\\' && next) { i += 2; col++; continue; }
      if (ch === "'") { inSingle = false; i++; continue; }
      i++; continue;
    }
    if (!inSingle && !inBack && ch === '"' && !inDouble) { inDouble = true; i++; continue; }
    if (inDouble) {
      if (ch === '\\' && next) { i += 2; col++; continue; }
      if (ch === '"') { inDouble = false; i++; continue; }
      i++; continue;
    }
    if (!inSingle && !inDouble && ch === '`' && !inBack) { inBack = true; i++; continue; }
    if (inBack) {
      if (ch === '\\' && next) { i += 2; col++; continue; }
      if (ch === '`') { inBack = false; i++; continue; }
      i++; continue;
    }

    // Possible regex literal (very rough heuristic)
    if (!inSingle && !inDouble && !inBack) {
      if (ch === '/' && next !== '/' && next !== '*') {
        const prev = prevNonSpace(i);
        if (prev === '\n' || prev === '(' || prev === '=' || prev === ':' || prev === '[' || prev === '{' || prev === ',' || prev === '!' || prev === '?' ) {
          // Skip regex until next unescaped '/'
          i++; // consume initial '/'
          while (i < src.length) {
            const c = src[i];
            if (c === '\n') { line++; col = 0; }
            if (c === '\\' && src[i+1]) { i += 2; col += 2; continue; }
            if (c === '/') { i++; col++; // possible flags
              while (/[a-z]/i.test(src[i])) { i++; col++; }
              break;
            }
            i++; col++;
          }
          continue;
        }
      }
    }

    // Now real tokens
    if (openers.has(ch)) {
      stack.push({ ch, line, col });
    } else if (closers.has(ch)) {
      if (!stack.length) {
        console.log(`Unmatched closer ${ch} at ${line}:${col}`);
        return 1;
      }
      const top = stack.pop();
      if (pairs[top.ch] !== ch) {
        console.log(`Mismatched ${top.ch} opened at ${top.line}:${top.col} closed by ${ch} at ${line}:${col}`);
        return 1;
      }
    }

    i++;
  }

  if (inSingle || inDouble || inBack) {
    console.log('Unterminated string literal');
    return 1;
  }
  if (inBlockComment) {
    console.log('Unterminated block comment');
    return 1;
  }
  if (stack.length) {
    for (const s of stack) {
      console.log(`Unclosed ${s.ch} opened at ${s.line}:${s.col}`);
    }
    return 1;
  }
  console.log('All delimiters balanced');
  return 0;
}

if (process.argv.length < 3) {
  console.error('Usage: node scripts/check_braces.cjs <file>');
  process.exit(2);
}

process.exit(checkFile(process.argv[2]));
