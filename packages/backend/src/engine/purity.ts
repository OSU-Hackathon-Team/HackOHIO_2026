// Owner: Eng 3 (Implementation) — spec: agents/3_feature_implementation/01_engine_implementation.md §3
// Implementation note: the spec's regex scan is replaced by a TypeScript AST walk, so text inside
// strings, comments and regex literals can never trigger (or hide) a rule.
import ts from "typescript";

const MSG = {
  imports: "imports are not allowed",
  require: "require() is not allowed",
  process: "process is not available",
  browser: "browser globals are not allowed",
  global: "globalThis is not allowed; everything the engine needs arrives through its parameters",
  network: "network access is not allowed",
  timers: "timers are not allowed",
  random: "Math.random() makes the engine nondeterministic",
  clock: "reading the clock makes the engine nondeterministic; take the date as a parameter",
  console: "console output is not allowed",
  eval: "eval is not allowed",
} as const;

const GLOBALS: Record<string, string> = {
  require: MSG.require,
  process: MSG.process,
  window: MSG.browser, document: MSG.browser, localStorage: MSG.browser, sessionStorage: MSG.browser,
  navigator: MSG.browser, self: MSG.browser,
  globalThis: MSG.global,
  fetch: MSG.network, XMLHttpRequest: MSG.network, WebSocket: MSG.network,
  setTimeout: MSG.timers, setInterval: MSG.timers, setImmediate: MSG.timers, requestAnimationFrame: MSG.timers,
  performance: MSG.clock,
  crypto: MSG.random,
  console: MSG.console,
  eval: MSG.eval, Function: MSG.eval,
};

/** Identifier is a value/type reference, not a property name or import/export specifier. */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) || ts.isQualifiedName(p)) return (ts.isPropertyAccessExpression(p) ? p.expression : p.left) === id;
  if (
    (ts.isPropertyAssignment(p) || ts.isPropertyDeclaration(p) || ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) || ts.isMethodSignature(p) || ts.isGetAccessor(p) || ts.isSetAccessor(p) ||
      ts.isEnumMember(p)) && p.name === id
  ) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isImportSpecifier(p) || ts.isExportSpecifier(p) || ts.isLabeledStatement(p)) return false;
  return true;
}

/** Names the module declares itself; a local `crypto` helper is not the global. */
function declaredNames(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (n: ts.Node) => {
    if (
      (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) ||
        ts.isBindingElement(n)) && n.name && ts.isIdentifier(n.name)
    ) names.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

export function purityViolations(src: string): string[] {
  const sf = ts.createSourceFile("/engine.ts", src, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const local = declaredNames(sf);
  const found = new Map<string, number>(); // message → first line

  const flag = (msg: string, node: ts.Node) => {
    if (!found.has(msg)) found.set(msg, sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1);
  };
  const isGlobal = (n: ts.Node, name: string) => ts.isIdentifier(n) && n.text === name && !local.has(name);

  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n) || (ts.isExportDeclaration(n) && n.moduleSpecifier)) {
      flag(MSG.imports, n);
    } else if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
      flag(MSG.imports, n);
    } else if (ts.isImportTypeNode(n)) {
      flag(MSG.imports, n);
    } else if (ts.isPropertyAccessExpression(n) && isGlobal(n.expression, "Math") && n.name.text === "random") {
      flag(MSG.random, n);
    } else if (ts.isPropertyAccessExpression(n) && isGlobal(n.expression, "Date") && n.name.text === "now") {
      flag(MSG.clock, n);
    } else if (ts.isNewExpression(n) && isGlobal(n.expression, "Date") && (n.arguments?.length ?? 0) === 0) {
      flag(MSG.clock, n);
    } else if (ts.isCallExpression(n) && isGlobal(n.expression, "Date")) {
      flag(MSG.clock, n); // Date() returns the current time as a string
    } else if (ts.isIdentifier(n) && GLOBALS[n.text] && !local.has(n.text) && isReference(n)) {
      flag(GLOBALS[n.text], n);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);

  return [...found].map(([msg, line]) => `${msg} (line ${line})`);
}
