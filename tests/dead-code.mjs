// Static analysis over a real AST, not regexes.
//
// Two earlier attempts at this used string stripping and both lied: brace
// counting inside `${…}` miscounts when an interpolation contains a string, so
// whole spans of code vanished and functions defined there were reported
// missing. A parser removes the guessing entirely.
//
// Reports, per file:
//   · identifiers used but never declared anywhere in scope — the failure that
//     reaches a person as "Can't find variable"
//   · functions declared, never referenced, and not reachable from HTML — code
//     that only costs reading
import { readFileSync, readdirSync } from 'node:fs';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const BROWSER = new Set(`
Array ArrayBuffer BigInt Boolean DataView Date Error EvalError Float32Array
Float64Array Function Infinity Int16Array Int32Array Int8Array Intl JSON Map
Math NaN Number Object Promise Proxy RangeError ReferenceError Reflect RegExp
Set String Symbol SyntaxError TypeError URIError Uint16Array Uint32Array
Uint8Array Uint8ClampedArray WeakMap WeakSet decodeURI decodeURIComponent
encodeURI encodeURIComponent escape eval globalThis isFinite isNaN parseFloat
parseInt undefined unescape structuredClone queueMicrotask
AbortController Blob CanvasRenderingContext2D CustomEvent DOMParser Event File
FileReader FormData Headers Image ImageData IntersectionObserver MutationObserver
Path2D Request Response ResizeObserver Response TextDecoder TextEncoder URL
URLSearchParams Worker XMLHttpRequest
alert atob btoa cancelAnimationFrame clearInterval clearTimeout confirm console
crypto customElements document fetch getComputedStyle history localStorage
location matchMedia navigator performance prompt requestAnimationFrame screen
self sessionStorage setInterval setTimeout window top parent HTMLElement
devicePixelRatio innerWidth innerHeight Node NodeList Element Text
`.trim().split(/\s+/));

function inlineScripts(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/g)]
    .filter(([, a]) => !/importmap|application\/json/.test(a))
    .map(([, a, c]) => ({ module: /type="module"/.test(a), code: c }));
}

function parse(code, isModule) {
  // Try module first when declared; a stray `import` in script mode throws and
  // would be reported as a parse failure rather than analysed.
  for (const sourceType of isModule ? ['module', 'script'] : ['script', 'module']) {
    try {
      return acorn.parse(code, { ecmaVersion: 'latest', sourceType, allowAwaitOutsideFunction: true });
    } catch (_) { /* try the other */ }
  }
  return null;
}

// Every name a scope introduces. Collected by walking declarations rather than
// by pattern, so destructuring, defaults and rest all come out right.
function declaredNames(ast) {
  const names = new Set();
  const addPattern = (node) => {
    if (!node) return;
    switch (node.type) {
      case 'Identifier': names.add(node.name); break;
      case 'ObjectPattern': node.properties.forEach(p =>
        addPattern(p.type === 'RestElement' ? p.argument : p.value)); break;
      case 'ArrayPattern': node.elements.forEach(addPattern); break;
      case 'AssignmentPattern': addPattern(node.left); break;
      case 'RestElement': addPattern(node.argument); break;
    }
  };
  walk.full(ast, (node) => {
    switch (node.type) {
      case 'VariableDeclarator': addPattern(node.id); break;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        if (node.id) names.add(node.id.name);
        node.params.forEach(addPattern);
        break;
      case 'ClassDeclaration': if (node.id) names.add(node.id.name); break;
      case 'CatchClause': addPattern(node.param); break;
      case 'ImportDefaultSpecifier':
      case 'ImportNamespaceSpecifier':
      case 'ImportSpecifier': names.add(node.local.name); break;
      case 'LabeledStatement': names.add(node.label.name); break;
      // `window.foo = …` creates a global that bare `foo()` then resolves to.
      // Leaving this out reported every such handler as undefined — nineteen of
      // them in one file, which is how a real finding gets buried.
      case 'AssignmentExpression':
        if (node.left.type === 'MemberExpression' && !node.left.computed
            && node.left.object.type === 'Identifier'
            && (node.left.object.name === 'window' || node.left.object.name === 'global')
            && node.left.property.type === 'Identifier') {
          names.add(node.left.property.name);
        }
        break;
    }
  });
  return names;
}

// Identifiers actually read. Property keys, member access and labels are not
// reads of a binding and must not count.
function usedNames(ast) {
  // Every occurrence, not just the first. Keeping one position per name meant
  // the declaration (which comes first and is skipped) decided the verdict, and
  // a function used fifty lines later still counted as unused.
  const occurrences = [];
  walk.full(ast, (node) => {
    if (node.type === 'Identifier') occurrences.push([node.name, node.start]);
  });
  // walk.full visits property keys and member properties too; filter them out
  // by collecting the ones to exclude.
  const skip = new Set();
  walk.full(ast, (node) => {
    if (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier')
      skip.add(node.property.start);
    // Shorthand `{ action }` has key and value as the same node: skipping the
    // key also skipped the read, so every function returned in an API object
    // looked dead.
    if (node.type === 'Property' && !node.computed && !node.shorthand
        && node.key.type === 'Identifier')
      skip.add(node.key.start);
    if (node.type === 'MethodDefinition' && node.key.type === 'Identifier')
      skip.add(node.key.start);
    // A name in declaration position is not a READ of it. Without this a
    // function always looks used — by its own declaration.
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration'
         || node.type === 'FunctionExpression') && node.id) skip.add(node.id.start);
    if (node.type === 'LabeledStatement') skip.add(node.label.start);
    if (node.type === 'BreakStatement' && node.label) skip.add(node.label.start);
    if (node.type === 'ContinueStatement' && node.label) skip.add(node.label.start);
  });
  const read = new Set();
  for (const [name, start] of occurrences) if (!skip.has(start)) read.add(name);
  return read;
}

const sharedGlobals = new Set(
  readdirSync('.').filter(f => f.endsWith('.js')).flatMap(f =>
    [...readFileSync(f, 'utf8').matchAll(/(?:window|global)\.([A-Za-z_$][\w$]*)\s*=/g)]
      .map(m => m[1])));

let findings = 0;

for (const file of process.argv.slice(2)) {
  const isHtml = file.endsWith('.html');
  const raw = readFileSync(file, 'utf8');
  const parts = isHtml ? inlineScripts(raw) : [{ module: false, code: raw }];

  const declared = new Set();
  const used = new Set();
  const fnDecls = new Map();
  const exportedHere = new Set();
  let parseFailed = false;

  for (const { module, code } of parts) {
    if (!code.trim()) continue;
    const ast = parse(code, module);
    if (!ast) { parseFailed = true; continue; }
    for (const n of declaredNames(ast)) declared.add(n);
    for (const n of usedNames(ast)) used.add(n);
    walk.full(ast, (node) => {
      if (node.type === 'FunctionDeclaration' && node.id) fnDecls.set(node.id.name, true);
      // An exported function is used by definition — by another file. Counting
      // mentions within this one reported every export in scene-core.js as dead.
      if (node.type === 'ExportNamedDeclaration' && node.declaration
          && node.declaration.type === 'FunctionDeclaration' && node.declaration.id) {
        exportedHere.add(node.declaration.id.name);
      }
      if (node.type === 'ExportNamedDeclaration') {
        (node.specifiers || []).forEach(sp => exportedHere.add(sp.local.name));
      }
    });
  }

  const missing = [...used].filter(n =>
    !declared.has(n) && !BROWSER.has(n) && !sharedGlobals.has(n)).sort();

  // A function is dead when nothing in this file mentions it beyond its own
  // declaration, and the HTML never names it either.
  // Dead = declared, never read anywhere in this file, not exported, and not
  // named by the HTML outside the scripts. Measured from the AST: the earlier
  // regex version used \b, which does not bound a name like `$` and therefore
  // declared a helper dead that hub-core.js calls on every notify().
  const htmlOnly = isHtml ? raw.replace(/<script[\s\S]*?<\/script>/g, '') : '';
  const dead = [...fnDecls.keys()]
    .filter(n => !exportedHere.has(n) && !used.has(n) && !htmlOnly.includes(n))
    .sort();

  if (parseFailed || missing.length || dead.length) {
    findings++;
    console.log(`\n── ${file}`);
    if (parseFailed) console.log('   !! a script block failed to parse');
    if (missing.length) {
      console.log(`   used but never declared (${missing.length}):`);
      for (const n of missing) console.log(`     ${n}`);
    }
    if (dead.length) {
      console.log(`   declared, never mentioned again (${dead.length}):`);
      for (const n of dead) console.log(`     ${n}()`);
    }
  } else {
    console.log(`✓ ${file}`);
  }
}
process.exit(findings ? 1 : 0);
