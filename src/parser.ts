import { GilError } from './ast.ts';
import type { Action, Binding, Claim, Concept, Document, Expr, Ontology, Relation, Spec } from './ast.ts';
import type { Interpretation } from './interpretation-ast.ts';

interface Token { text: string; kind: 'id' | 'number' | 'string' | 'symbol' | 'eof'; line: number; column: number }
const reserved = new Set(`ontology version concept identity relation constraint type lexicon phrase candidate candidates spec use as for context input output state knowledge assert assume open ambiguous disputed operationalize source inferred asserted assumed goals achieve prefer minimize maximize priority constraints require action requires ensures writes preserves outcomes failure atomic retryable reversibility reversible compensable irreversible compensate verification verify by under interpretation ground of delegate environment forall exists in within after entered changed always eventually not true false`.split(' '));
const precedence: Record<string, number> = { '=>': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '<=': 5, '>': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7 };

function fail(token: Token, message: string, code = 'PARSE_ERROR'): never {
  throw new GilError(code, `${message} at ${token.line}:${token.column}`);
}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0, line = 1, column = 1;
  const advance = (text: string) => {
    for (const c of text) { if (c === '\n') { line++; column = 1; } else { column++; } }
    offset += text.length;
  };
  while (offset < source.length) {
    const rest = source.slice(offset);
    const start: Token = { text: '', kind: 'symbol', line, column };
    const space = /^\s+/.exec(rest);
    if (space) { advance(space[0]); continue; }
    if (rest.startsWith('//')) { advance(rest.split('\n')[0]); continue; }
    if (rest.startsWith('(*')) {
      const end = rest.indexOf('*)', 2);
      if (end === -1) fail(start, 'Unterminated block comment');
      advance(rest.slice(0, end + 2)); continue;
    }
    if (rest[0] === '"') {
      let end = 1;
      while (end < rest.length) {
        if (rest[end] === '\\') { end += 2; continue; }
        if (rest[end] === '"') break;
        end++;
      }
      if (end >= rest.length) fail(start, 'Unterminated string');
      const raw = rest.slice(0, end + 1);
      let value: string;
      try { value = JSON.parse(raw); } catch { fail(start, 'Invalid JSON string escape or control character'); }
      tokens.push({ ...start, kind: 'string', text: value! }); advance(raw); continue;
    }
    const id = /^[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (id) { tokens.push({ ...start, kind: 'id', text: id[0] }); advance(id[0]); continue; }
    const number = /^\d+(?:\.\d+)?/.exec(rest);
    if (number) {
      if (!Number.isFinite(Number(number[0]))) fail(start, 'Non-finite number');
      tokens.push({ ...start, kind: 'number', text: number[0] }); advance(number[0]); continue;
    }
    const op = /^(?:=>|==|!=|<=|>=|&&|\|\||->|[{}():;,.+'!\-*\/=< >?\[\]|%])/.exec(rest);
    if (!op) fail(start, `Unsupported character ${JSON.stringify(rest[0])}`, 'UNSUPPORTED_SYNTAX');
    tokens.push({ ...start, text: op[0] }); advance(op[0]);
  }
  tokens.push({ text: '<eof>', kind: 'eof', line, column });
  return tokens;
}

class Parser {
  tokens: Token[];
  index = 0;
  constructor(source: string) { this.tokens = lex(source); }
  peek(): Token { return this.tokens[this.index]; }
  take(): Token { const token = this.peek(); if (token.kind !== 'eof') this.index++; return token; }
  is(text: string): boolean { return this.peek().kind !== 'string' && this.peek().text === text; }
  accept(text: string): boolean { if (!this.is(text)) return false; this.take(); return true; }
  expect(text: string): void {
    if (this.accept(text)) return;
    if (['in', 'within', 'after', 'source', '[', '{', '%', '?', '|'].some(t => this.is(t))) this.unsupported('Syntax construct');
    fail(this.peek(), `Expected ${JSON.stringify(text)}, found ${JSON.stringify(this.peek().text)}`);
  }
  name(): string {
    const token = this.peek();
    if (token.kind !== 'id' || reserved.has(token.text)) fail(token, 'Expected non-keyword identifier');
    return this.take().text;
  }
  path(): string[] { const result = [this.name()]; while (this.accept('.')) result.push(this.name()); return result; }
  string(): string { if (this.peek().kind !== 'string') fail(this.peek(), 'Expected string'); return this.take().text; }
  unsupported(label: string): never { return fail(this.peek(), `${label} is outside gil-core-clinical-0.1`, 'UNSUPPORTED_SYNTAX'); }
  unique(seen: Set<string>, name: string, token: Token, label = 'declaration'): void {
    if (seen.has(name)) fail(token, `Duplicate ${label}: ${name}`, 'DUPLICATE_CLAUSE');
    seen.add(name);
  }
  type(): string {
    const type = this.path().join('.');
    if (['<', '?', '|', '{', '('].some(t => this.is(t))) this.unsupported('Constructed/refined type');
    return type;
  }
  binding(initializer: boolean): Binding {
    const name = this.name(); this.expect(':'); const type = this.type();
    if (this.accept('=')) {
      if (!initializer) this.unsupported('Initializer in this declaration');
      return { name, type, value: this.expression() };
    }
    return { name, type };
  }
  parameters(): Binding[] {
    this.expect('('); const result: Binding[] = [], seen = new Set<string>();
    if (!this.is(')')) do {
      const token = this.peek(), item = this.binding(false);
      this.unique(seen, item.name, token); result.push(item);
    } while (this.accept(','));
    this.expect(')'); return result;
  }
  document(): Document {
    let document: Document;
    if (this.accept('ontology')) document = this.ontology();
    else if (this.accept('spec')) document = this.spec();
    else this.unsupported('Top-level document');
    if (this.peek().kind !== 'eof') fail(this.peek(), 'Only one top-level document is allowed');
    return document;
  }
  interpretation(): Interpretation {
    this.expect('interpretation');
    const name = this.name(); this.expect('of'); const sourceText = this.string(); this.expect('{');
    const result: Interpretation = { kind: 'interpretation', name, sourceText, imports: [], items: [] };
    let hasItem = false;
    while (!this.is('}')) {
      const token = this.peek();
      if (this.accept('use')) {
        if (hasItem) fail(token, 'Imports must precede interpretation items');
        this.expect('ontology'); const name = this.string(); this.expect('as'); const alias = this.name();
        this.expect(';'); result.imports.push({ name, alias }); continue;
      }
      hasItem = true;
      if (this.accept('ground')) {
        // sourceSpan is an ordinary identifier, not a new lexer keyword.
        if (this.peek().kind !== 'id' || this.peek().text !== 'sourceSpan') {
          fail(this.peek(), 'Only sourceSpan is supported in gil-exchange-interpretation-0.1', 'UNSUPPORTED_SYNTAX');
        }
        this.take(); this.expect('('); const artifactId = this.string(); this.expect(',');
        const offset = (): number => {
          const token = this.peek();
          if (token.kind !== 'number' || !/^\d+$/.test(token.text) || !Number.isSafeInteger(Number(token.text))) {
            fail(token, 'sourceSpan offset must be a non-negative safe integer');
          }
          return Number(this.take().text);
        };
        const start = offset(); this.expect(','); const end = offset(); this.expect(')'); this.expect('->');
        const targetToken = this.peek(), target = this.expression();
        if (target.kind !== 'ref' || target.next) {
          fail(targetToken, 'Ground target must be an explicit non-prime reference in gil-exchange-interpretation-0.1', 'UNSUPPORTED_SYNTAX');
        }
        this.expect(';'); result.items.push({ kind: 'ground', source: { artifactId, start, end }, target });
      } else if (this.accept('open')) {
        const name = this.name(); this.expect(':'); const type = this.type(); this.expect(';');
        result.items.push({ kind: 'open', name, type });
      } else if (this.accept('ambiguous')) {
        const name = this.name(); this.expect('{'); this.expect('candidates');
        const candidates: string[][] = [];
        if (!this.is(';')) do { candidates.push(this.path()); } while (this.accept(','));
        this.expect(';'); this.expect('}'); result.items.push({ kind: 'ambiguous', name, candidates });
      } else {
        fail(token, 'Unsupported interpretation item in gil-exchange-interpretation-0.1', 'UNSUPPORTED_SYNTAX');
      }
    }
    this.expect('}');
    if (this.peek().kind !== 'eof') fail(this.peek(), 'Only one top-level document is allowed');
    return result;
  }
  ontology(): Ontology {
    const name = this.string(); this.expect('version'); const version = this.string(); this.expect('{');
    const concepts: Concept[] = [], relations: Relation[] = [], seen = new Set<string>();
    while (!this.is('}')) {
      const token = this.peek();
      if (this.accept('concept')) {
        const name = this.name(); this.unique(seen, name, token); this.expect('{');
        const fields: Binding[] = [], fieldNames = new Set<string>(); let identity: string | undefined;
        while (!this.is('}')) {
          const fieldToken = this.peek(), isIdentity = this.accept('identity');
          if (isIdentity && identity !== undefined) fail(fieldToken, 'Duplicate identity clause', 'DUPLICATE_CLAUSE');
          if (this.peek().kind === 'id' && reserved.has(this.peek().text)) this.unsupported('Concept member');
          const field = this.binding(false); this.unique(fieldNames, field.name, fieldToken);
          fields.push(field); if (isIdentity) identity = field.name; this.expect(';');
        }
        this.expect('}'); if (identity === undefined) fail(token, 'Concept requires one identity field');
        concepts.push({ name, fields, identity });
      } else if (this.accept('relation')) {
        const name = this.name(); this.unique(seen, name, token); const params = this.parameters();
        this.expect(':'); const type = this.type();
        if (!this.is('=')) this.unsupported('Relation without a body');
        this.expect('='); const body = this.expression(); this.expect(';'); relations.push({ name, params, type, body });
      } else this.unsupported('Ontology member');
    }
    this.expect('}'); return { kind: 'ontology', name, version, concepts, relations };
  }
  spec(): Spec {
    const name = this.path().join('.'); this.expect('version'); const version = this.string(); this.expect('{');
    const result: Spec = { kind: 'spec', name, version, imports: [], context: [], input: [], state: [], goals: [], constraints: [], actions: [] };
    const sections = new Set<string>(), aliases = new Set<string>(); let hasSection = false;
    while (!this.is('}')) {
      const token = this.peek();
      if (this.accept('use')) {
        if (hasSection) fail(token, 'Imports must precede sections');
        if (!this.accept('ontology')) this.unsupported('Non-ontology import');
        const name = this.string(); this.expect('as'); const alias = this.name();
        this.unique(aliases, alias, token, 'import alias'); this.expect(';'); result.imports.push({ name, alias }); continue;
      }
      const section = this.peek().text;
      if (!['context', 'input', 'state', 'goals', 'constraints', 'action'].includes(section)) this.unsupported('Spec section');
      this.take(); hasSection = true; this.unique(sections, section, token, 'section'); this.expect('{');
      const names = new Set<string>();
      while (!this.is('}')) {
        const itemToken = this.peek();
        if (section === 'context' || section === 'input' || section === 'state') {
          const item = this.binding(true); this.unique(names, item.name, itemToken); this.expect(';'); result[section].push(item);
        } else if (section === 'action') {
          const item = this.action(); this.unique(names, item.name, itemToken); result.actions.push(item);
        } else {
          const prefix = section === 'goals' ? 'achieve' : 'require';
          if (!this.accept(prefix)) this.unsupported(`${section} declaration`);
          const name = this.name(); this.unique(names, name, itemToken); this.expect(':');
          const expr = this.expression(); this.expect(';'); const item: Claim = { name, expr }; result[section].push(item);
        }
      }
      this.expect('}');
    }
    this.expect('}'); return result;
  }

  action(): Action {
    this.expect('action'); const name = this.name(), params = this.parameters();
    if (this.is('->')) this.unsupported('Action return type');
    const result: Action = { name, params, requires: [], ensures: [], writes: [], atomic: false };
    const singleton = new Set<string>();
    while (!this.is(';')) {
      const token = this.peek();
      if (this.accept('requires')) result.requires.push(this.expression());
      else if (this.accept('ensures')) result.ensures.push(this.expression());
      else if (this.accept('writes')) {
        this.unique(singleton, 'writes', token, 'action clause');
        const references = new Set<string>();
        do {
          const refToken = this.peek(), ref = this.path().join('.');
          this.unique(references, ref, refToken, 'write target'); result.writes.push(ref);
        } while (this.accept(','));
      } else if (this.accept('atomic')) {
        this.unique(singleton, 'atomic', token, 'action clause'); result.atomic = true;
      } else this.unsupported('Action clause');
    }
    this.expect(';'); return result;
  }
  expression(min = 1): Expr {
    let left = this.prefix();
    while (true) {
      const token = this.peek();
      const level = token.kind === 'symbol' ? precedence[token.text] : undefined;
      if (level === undefined || level < min) break;
      this.take();
      const right = this.expression(token.text === '=>' ? level : level + 1);
      left = { kind: 'binary', op: token.text, left, right };
    }
    return left;
  }
  prefix(): Expr {
    const token = this.peek();
    if (['!', '-', 'not', 'always', 'eventually'].some(t => this.is(t))) {
      this.take(); return { kind: 'unary', op: token.text === 'not' ? '!' : token.text, arg: this.prefix() };
    }
    if (this.accept('(')) { const expr = this.expression(); this.expect(')'); return expr; }
    if (token.kind === 'string') { this.take(); return { kind: 'literal', value: token.text }; }
    if (token.kind === 'number') { this.take(); return { kind: 'literal', value: Number(token.text) }; }
    if (this.accept('true')) return { kind: 'literal', value: true };
    if (this.accept('false')) return { kind: 'literal', value: false };
    if (token.kind === 'id' && !reserved.has(token.text)) {
      const path = this.path();
      if (this.accept('(')) {
        const args: Expr[] = [];
        if (!this.is(')')) do { args.push(this.expression()); } while (this.accept(','));
        this.expect(')');
        if (this.is('.') || this.is("'") || this.is('(') || this.is('[')) this.unsupported('Postfix on call result');
        return { kind: 'call', path, args };
      }
      const next = this.accept("'");
      if (this.is('.') || this.is("'") || this.is('(') || this.is('[')) this.unsupported('Postfix after next-state reference');
      return next ? { kind: 'ref', path, next: true } : { kind: 'ref', path };
    }
    if (token.kind === 'id' || ['{', '['].some(t => this.is(t))) this.unsupported('Expression construct');
    fail(token, `Expected expression, found ${JSON.stringify(token.text)}`);
  }
}

export function parse(source: string): Document { return new Parser(source).document(); }

/** Independent Exchange entry point; the Core Document parser remains unchanged. */
export function parseInterpretation(source: string): Interpretation { return new Parser(source).interpretation(); }
