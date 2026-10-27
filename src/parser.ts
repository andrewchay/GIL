import { GilError, renderType } from './ast.ts';
import type { Action, Binding, Claim, Concept, Document, Expr, Goal, KnowledgeItem, Lexicon, LexiconEntry,
  Ontology, Provenance, Relation, Spec, TypeExpr, Verification } from './ast.ts';
import type { Interpretation } from './interpretation-ast.ts';
import type { DelegationDocument } from './delegation-ast.ts';
import type { Environment, RlAction } from './rl-ast.ts';

interface Token { text: string; kind: 'id' | 'number' | 'string' | 'symbol' | 'eof'; line: number; column: number }
const reserved = new Set(`ontology version concept identity relation constraint type lexicon phrase candidate candidates spec use as for context input output state knowledge assert assume open ambiguous disputed operationalize source inferred asserted assumed goals achieve prefer minimize maximize priority constraints require action requires ensures writes preserves outcomes failure atomic retryable reversibility reversible compensable irreversible compensate verification verify by under interpretation ground of delegate environment forall exists in within after entered changed always eventually not true false`.split(' '));
const precedence: Record<string, number> = { '=>': 1, '||': 2, '&&': 3, '==': 4, '!=': 4, '<': 5, '<=': 5, '>': 5, '>=': 5, '+': 6, '-': 6, '*': 7, '/': 7 };

/*
 * 这些保留字同时是规范里的标准谓词（如 `irreversible(action)`）。
 * 只有紧跟 `(` 时才作为调用名使用，避免把它们当普通标识符。
 */
const predicateKeywords = new Set(['irreversible', 'reversible', 'compensable']);
/** `action` 在规范中既是章节关键字，也指代当前动作本身（如 `irreversible(action)`）。 */
const termKeywords = new Set(['action']);

/** 委派子句关键字：它们结束上一个子句，不能被当作目标名吃掉。 */
const DELEGATION_CLAUSES = new Set(['autonomy', 'budget', 'requires', 'requiresEvidence', 'approval',
  'onConflict', 'onUncertainty', 'revokeBy', 'expires']);

/** GIL-RL 只有离散步。 */
const STEP_UNITS = ['steps'] as const;
/** Core 的时间界限单位。它是声明的时间量，不携带真实时钟。 */
const BOUND_UNITS = ['steps', 'seconds', 'minutes', 'hours', 'days'] as const;

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
  /** GIL-RL 专属语法（in 运算符、within 界限）只在环境文档中启用，Core 保持严格。 */
  rl: boolean;
  constructor(source: string, rl = false) { this.tokens = lex(source); this.rl = rl; }
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
  /** 类型表达式。`Entity<H.Customer>`、`Set<Order>`、`A | B`、`T?`、记录类型。 */
  typeExpr(): TypeExpr {
    return this.unionType();
  }
  unionType(): TypeExpr {
    const options = [this.postfixType()];
    while (this.accept('|')) options.push(this.postfixType());
    return options.length === 1 ? options[0] : { kind: 'union', options };
  }
  postfixType(): TypeExpr {
    let type = this.primaryType();
    while (this.is('<') || this.is('?')) {
      if (this.accept('?')) { type = { kind: 'optional', arg: type }; continue; }
      this.expect('<');
      if (type.kind !== 'name') fail(this.peek(), 'Type constructor must be a plain name');
      const args: TypeExpr[] = [];
      do { args.push(this.typeExpr()); } while (this.accept(','));
      this.expect('>');
      type = { kind: 'apply', name: type.path, args };
    }
    return type;
  }
  primaryType(): TypeExpr {
    if (this.accept('(')) { const inner = this.typeExpr(); this.expect(')'); return inner; }
    if (this.accept('{')) {
      // 记录类型：`{ name: T | 判定 }`。字段名与类型交替出现，判定可选且只有一个。
      const fields: Binding[] = [];
      let guard: Expr | undefined;
      while (!this.is('}')) {
        const name = this.name(); this.expect(':'); const type = this.typeExpr();
        const field: Binding = { name, type: renderType(type) };
        if (type.kind !== 'name') field.typeExpr = type;
        fields.push(field);
        if (this.accept('|')) { guard = this.expression(); break; }
        if (!this.is('}')) this.unsupported('Extra record type member');
      }
      this.expect('}');
      return { kind: 'record', fields, guard };
    }
    return { kind: 'name', path: this.path() };
  }
  /** 兼容既有调用点：返回规范文本形式。 */
  type(): string {
    return renderType(this.typeExpr());
  }
  /** `source <expr> as asserted|assumed|inferred|disputed`。 */
  provenance(): Provenance {
    this.expect('source'); const expr = this.expression();
    if (!this.accept('as')) return { expr };
    const token = this.peek();
    if (!['asserted', 'assumed', 'inferred', 'disputed'].includes(token.text)) {
      fail(token, 'Provenance label must be asserted, assumed, inferred or disputed');
    }
    return { expr, label: this.take().text as Provenance['label'] };
  }
  binding(initializer: boolean): Binding {
    const name = this.name(); this.expect(':'); const typeExpr = this.typeExpr(), type = renderType(typeExpr);
    const result: Binding = { name, type };
    if (typeExpr.kind !== 'name') result.typeExpr = typeExpr;
    if (this.accept('=')) {
      if (!initializer) this.unsupported('Initializer in this declaration');
      result.value = this.expression();
    }
    if (this.is('source')) result.provenance = this.provenance();
    return result;
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
    const document = this.single();
    if (this.peek().kind !== 'eof') fail(this.peek(), 'Only one top-level document is allowed');
    return document;
  }

  /** 解析恰好一个顶层文档，不检查是否已到文件末尾。bundle 与单文档入口共用。 */
  single(): Document {
    if (this.accept('ontology')) return this.ontology();
    if (this.accept('lexicon')) return this.lexicon();
    if (this.accept('spec')) return this.spec();
    if (this.accept('environment')) { this.rl = true; return this.environment(); }
    return this.unsupported('Top-level document');
  }

  /** 一个文件可以携带多个互不嵌套的顶层文档（示例文件 bundling）。 */
  bundle(): BundleItem[] {
    const items: BundleItem[] = [];
    while (this.peek().kind !== 'eof') {
      if (this.is('interpretation')) items.push(this.interpretationDoc());
      else if (this.is('delegate')) items.push(this.delegation());
      else items.push(this.single());
    }
    if (items.length === 0) fail(this.peek(), 'Expected at least one top-level document');
    return items;
  }

  /** `delegate <name>(params) to <target> ... ;` —— 请求语法，不是授权。 */
  delegation(): DelegationDocument {
    this.expect('delegate');
    const name = this.name(); this.expect('(');
    const params: Binding[] = [];
    if (!this.is(')')) do {
      const paramName = this.name();
      params.push(this.is(':') ? (this.expect(':'), { name: paramName, type: this.type() }) : { name: paramName, type: 'AUTO' });
    } while (this.accept(','));
    this.expect(')');
    this.expect('to');
    const result: DelegationDocument = { kind: 'delegate', name, params, to: this.path(), scope: [],
      requires: [], requiresEvidence: [] };
    this.expect('within'); result.scope = this.path();
    const singleton = new Set<string>();
    while (!this.is(';')) {
      const token = this.peek();
      if (this.accept('autonomy')) {
        this.unique(singleton, 'autonomy', token, 'delegation clause');
        const autonomy = this.peek().text;
        if (!['supervised', 'bounded', 'autonomous'].includes(autonomy)) {
          fail(this.peek(), 'autonomy must be supervised, bounded or autonomous', 'UNSUPPORTED_SYNTAX');
        }
        result.autonomy = this.take().text as DelegationDocument['autonomy'];
      } else if (this.accept('budget')) {
        this.unique(singleton, 'budget', token, 'delegation clause');
        const amount = this.number(); this.expect('.'); result.budget = { amount, currency: this.name() };
      } else if (this.accept('requiresEvidence')) {
        do { result.requiresEvidence.push(this.path()); } while (this.accept(','));
      } else if (this.accept('requires')) {
        result.requires.push(this.expression());
      } else if (this.accept('approval')) {
        this.unique(singleton, 'approval', token, 'delegation clause');
        const role = this.path(); this.expect('when'); result.approval = { role, when: this.expression() };
      } else if (this.accept('onConflict')) {
        this.unique(singleton, 'onConflict', token, 'delegation clause'); result.onConflict = this.handler();
      } else if (this.accept('onUncertainty')) {
        this.unique(singleton, 'onUncertainty', token, 'delegation clause'); result.onUncertainty = this.handler();
      } else if (this.accept('revokeBy')) {
        this.unique(singleton, 'revokeBy', token, 'delegation clause'); result.revokeBy = this.path();
      } else if (this.accept('expires')) {
        this.unique(singleton, 'expires', token, 'delegation clause');
        const amount = this.number(); this.expect('.'); const unit = this.name();
        this.expect('after'); result.expires = { amount, unit, after: this.path() };
      } else this.unsupported('Delegation clause');
    }
    this.expect(';');
    return result;
  }

  /** 词法表：短语到候选含义。候选必须由上位 ontology 解释，词法表本身不赋值语义。 */
  lexicon(): Lexicon {
    const name = this.string(); this.expect('version'); const version = this.string();
    this.expect('for'); const ontology = this.string(); this.expect('{');
    const entries: LexiconEntry[] = [], phrases = new Set<string>();
    while (!this.is('}')) {
      const token = this.peek();
      this.expect('phrase'); const phrase = this.string();
      if (phrases.has(phrase)) fail(token, `Duplicate phrase: ${phrase}`, 'DUPLICATE_CLAUSE');
      phrases.add(phrase);
      this.expect('=>');
      let candidates: string[][];
      if (this.accept('candidate')) candidates = [this.path()];
      else if (this.accept('candidates')) {
        candidates = [];
        if (!this.is(';')) do { candidates.push(this.path()); } while (this.accept(','));
      } else fail(this.peek(), 'Expected candidate or candidates', 'UNSUPPORTED_SYNTAX');
      this.expect(';');
      entries.push({ phrase, candidates });
    }
    this.expect('}');
    return { kind: 'lexicon', name, version, ontology, entries };
  }
  interpretation(): Interpretation {
    const result = this.interpretationDoc();
    if (this.peek().kind !== 'eof') fail(this.peek(), 'Only one top-level document is allowed');
    return result;
  }

  interpretationDoc(): Interpretation {
    this.expect('interpretation');
    const name = this.name(); this.expect('of'); const sourceText = this.string(); this.expect('{');
    const result: Interpretation = { kind: 'interpretation', name, sourceText, imports: [], items: [] };
    let hasItem = false;
    while (!this.is('}')) {
      const token = this.peek();
      if (this.accept('use')) {
        if (hasItem) fail(token, 'Imports must precede interpretation items');
        const lexicon = this.accept('lexicon');
        if (!lexicon) this.expect('ontology');
        const name = this.string();
        const alias = this.accept('as') ? this.name() : name.replace(/^.*\//, '').replace(/@.*$/, '');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) fail(token, `Cannot derive an alias for import ${name}; use "as"`);
        this.expect(';'); result.imports.push(lexicon ? { name, alias, layer: 'lexicon' } : { name, alias }); continue;
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
      } else if (this.accept('assume')) {
        const name = this.name(); this.expect(':'); const expr = this.expression();
        const provenance = this.is('source') ? this.provenance() : undefined;
        this.expect(';'); result.items.push({ kind: 'assume', name, expr, provenance });
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
    const result: Spec = { kind: 'spec', name, version, imports: [], context: [], input: [], output: [],
      state: [], knowledge: [], goals: [], constraints: [], actions: [], verification: [] };
    const sections = new Set<string>(), aliases = new Set<string>(); let hasSection = false;
    const SECTIONS = ['context', 'input', 'output', 'state', 'knowledge', 'goals', 'constraints', 'action', 'verification'];
    while (!this.is('}')) {
      const token = this.peek();
      if (this.accept('use')) {
        if (hasSection) fail(token, 'Imports must precede sections');
        const lexicon = this.accept('lexicon');
        if (!lexicon) this.expect('ontology');
        const name = this.string();
        const alias = this.accept('as') ? this.name() : name.replace(/^.*\//, '').replace(/@.*$/, '');
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) fail(token, `Cannot derive an alias for import ${name}; use "as"`);
        this.unique(aliases, alias, token, 'import alias'); this.expect(';');
        result.imports.push(lexicon ? { name, alias, layer: 'lexicon' } : { name, alias }); continue;
      }
      const section = this.peek().text;
      if (!SECTIONS.includes(section)) this.unsupported('Spec section');
      this.take(); hasSection = true; this.unique(sections, section, token, 'section'); this.expect('{');
      const names = new Set<string>();
      while (!this.is('}')) {
        const itemToken = this.peek();
        if (section === 'context' || section === 'input' || section === 'output' || section === 'state') {
          const item = this.binding(true); this.unique(names, item.name, itemToken); this.expect(';'); result[section].push(item);
        } else if (section === 'knowledge') {
          const item = this.knowledgeItem(); this.unique(names, item.name, itemToken, 'knowledge item');
          result.knowledge.push(item);
        } else if (section === 'verification') {
          const item = this.verification(); this.unique(names, item.target.join('.'), itemToken, 'verification target');
          result.verification.push(item);
        } else if (section === 'action') {
          const item = this.action(); this.unique(names, item.name, itemToken); result.actions.push(item);
        } else {
          const item = this.goalOrConstraint(section, names, itemToken);
          result[section].push(item);
        }
      }
      this.expect('}');
    }
    this.expect('}'); return result;
  }

  /** `goals` 支持 achieve 与 prefer；`constraints` 只接受 require。 */
  goalOrConstraint(section: 'goals' | 'constraints', names: Set<string>, token: Token): Claim | Goal {
    if (section === 'constraints') {
      if (!this.accept('require')) this.unsupported('constraints declaration');
      const name = this.name(); this.unique(names, name, token); this.expect(':');
      const expr = this.expression(); this.expect(';'); return { name, expr };
    }
    if (this.accept('prefer')) {
      const name = this.name(); this.unique(names, name, token); this.expect(':');
      const direction = this.is('minimize') || this.is('maximize') ? this.take().text as 'minimize' | 'maximize' : undefined;
      if (!direction) this.unsupported('Preference without minimize/maximize');
      const expr = this.expression(); this.expect('priority'); const priority = this.integer();
      this.expect(';');
      return { kind: 'prefer', name, expr, direction, priority };
    }
    if (!this.accept('achieve')) this.unsupported('goals declaration');
    const name = this.name(); this.unique(names, name, token); this.expect(':');
    const expr = this.expression(); this.expect(';');
    return { name, expr };
  }

  integer(): number {
    const token = this.peek();
    if (token.kind !== 'number' || !/^\d+$/.test(token.text)) fail(token, 'Expected a non-negative integer');
    const value = Number(this.take().text);
    if (!Number.isSafeInteger(value)) fail(token, 'Integer out of safe range');
    return value;
  }

  /** 知识状态项：open / assert / assume / disputed / ambiguous / operationalize。 */
  knowledgeItem(): KnowledgeItem {
    const token = this.peek();
    if (this.accept('open')) {
      const name = this.name(); this.expect(':'); const typeExpr = this.typeExpr(); this.expect(';');
      const item: KnowledgeItem = { kind: 'open', name, type: renderType(typeExpr) };
      if (typeExpr.kind !== 'name') item.typeExpr = typeExpr;
      return item;
    }
    if (this.accept('ambiguous')) {
      const name = this.name(); this.expect('{'); this.expect('candidates');
      const candidates: string[][] = [];
      if (!this.is(';')) do { candidates.push(this.path()); } while (this.accept(','));
      this.expect(';'); this.expect('}');
      return { kind: 'ambiguous', name, candidates };
    }
    if (this.accept('operationalize')) {
      const text = this.string(); this.expect('as'); const expr = this.expression(); this.expect(';');
      return { kind: 'operationalize', text, expr };
    }
    const modality = ['assert', 'assume', 'disputed'].find(m => this.is(m)) as 'assert' | 'assume' | 'disputed' | undefined;
    if (!modality) fail(token, 'Unsupported knowledge item', 'UNSUPPORTED_SYNTAX');
    this.take();
    const name = this.name(); this.expect(':'); const expr = this.expression();
    const provenance = this.is('source') ? this.provenance() : undefined;
    this.expect(';');
    return { kind: 'claim', modality, name, expr, provenance };
  }

  /**
   * 冲突/不确定处理：`ask customer`、`escalate` 这类「动词 + 可选目标」形式。
   * 子句关键字不进入 reserved（它们不影响 Core 标识符），这里显式停止。
   */
  handler(): string[] {
    const parts = [this.name()];
    while (this.peek().kind === 'id' && !reserved.has(this.peek().text) && !DELEGATION_CLAUSES.has(this.peek().text)) {
      parts.push(this.name());
    }
    return parts;
  }

  /** `verify <target> by <verifier>(args) [under a, b];` */
  verification(): Verification {
    this.expect('verify'); const target = [this.path()];
    while (this.accept(',')) target.push(this.path());
    this.expect('by'); const name = this.path(); this.expect('(');
    const args: Expr[] = [];
    if (!this.is(')')) do { args.push(this.expression()); } while (this.accept(','));
    this.expect(')');
    const under: string[][] = [];
    if (this.accept('under')) do { under.push(this.path()); } while (this.accept(','));
    this.expect(';');
    return { target, verifier: { name, args }, under };
  }

  /** GIL-RL 环境文档。所有章节最多出现一次；发生顺序不作要求。 */
  environment(): Environment {
    const name = this.path().join('.'); this.expect('version'); const version = this.string(); this.expect('{');
    const state: Environment['state'] = [], initial: Environment['initial'] = [], actions: RlAction[] = [];
    const goals: Environment['goals'] = [], constraints: Environment['constraints'] = [];
    const observation: Environment['observation'] = { full: false, visible: [] };
    const termination: Environment['termination'] = {};
    let reward: Environment['reward'] | undefined, objective: Environment['objective'];
    const sections = new Set<string>();
    const SECTIONS = ['state', 'observation', 'initial', 'action', 'termination', 'goals', 'constraints', 'reward', 'objective'];
    while (!this.is('}')) {
      const token = this.peek(), section = token.text;
      if (!SECTIONS.includes(section)) this.unsupported('Environment section');
      this.take(); this.unique(sections, section, token, 'section'); this.expect('{');
      const names = new Set<string>();
      while (!this.is('}')) {
        const itemToken = this.peek();
        if (section === 'state') {
          const item = this.binding(true); this.unique(names, item.name, itemToken, 'state binding'); this.expect(';'); state.push(item);
        } else if (section === 'observation') {
          // 首版只支持 `fullState;` 或裸可见变量名；类型化观察不在最小子集内。
          const item = this.name(); this.unique(names, item, itemToken, 'observation item'); this.expect(';');
          if (item === 'fullState') observation.full = true; else observation.visible.push(item);
        } else if (section === 'initial') {
          initial.push(this.expression()); this.expect(';');
        } else if (section === 'action') {
          const item = this.rlAction(); this.unique(names, item.name, itemToken, 'action'); actions.push(item);
        } else if (section === 'termination') {
          const kind = this.peek().text;
          if (!['success', 'failure', 'cutoff'].includes(kind)) this.unsupported('Termination clause');
          this.take(); if (!this.accept('when')) this.unsupported('Termination without when');
          this.unique(names, kind, itemToken, 'termination clause');
          termination[kind as 'success' | 'failure' | 'cutoff'] = this.expression(); this.expect(';');
        } else if (section === 'goals') {
          if (!this.accept('achieve')) this.unsupported('goals declaration');
          const goal = this.name(); this.unique(names, goal, itemToken, 'goal'); this.expect(':');
          goals.push({ name: goal, expr: this.expression() }); this.expect(';');
        } else if (section === 'constraints') {
          if (!this.accept('require')) this.unsupported('constraints declaration');
          const constraint = this.name(); this.unique(names, constraint, itemToken, 'constraint'); this.expect(':');
          constraints.push({ name: constraint, expr: this.expression() }); this.expect(';');
        } else if (section === 'reward') {
          if (reward === undefined) reward = { discount: 1, aggregation: 'expectedDiscountedReturn', terms: [] };
          if (this.accept('discount')) { reward.discount = this.number(); this.expect(';'); }
          else if (this.accept('horizon')) { reward.horizon = this.quantity(); this.expect(';'); }
          else if (this.accept('aggregation')) { reward.aggregation = this.name(); this.expect(';'); }
          else if (this.accept('term')) { reward.terms.push(this.rewardTerm()); }
          else this.unsupported('Reward clause');
        } else {
          if (objective !== undefined) fail(itemToken, 'Duplicate objective clause', 'DUPLICATE_CLAUSE');
          this.expect('maximize'); const maximize = this.name();
          this.expect('subjectTo'); const subjectTo: string[] = [];
          do { subjectTo.push(this.name()); } while (this.accept(','));
          this.expect(';'); objective = { maximize, subjectTo };
        }
      }
      this.expect('}');
    }
    this.expect('}');
    if (reward === undefined) fail({ text: '', kind: 'eof', line: 0, column: 0 }, 'Environment requires a reward section');
    return { kind: 'environment', name, version, state, observation, initial, actions, termination,
      goals, constraints, reward, objective };
  }

  rewardTerm(): Environment['reward']['terms'][number] {
    const name = this.name(); this.expect(':'); const amount = this.signedNumber();
    if (this.accept('once')) {
      if (!this.accept('entered')) this.unsupported('Reward event');
      this.expect('('); const predicate = this.expression(); this.expect(')'); this.expect(';');
      return { name, amount, kind: 'once-entered', predicate };
    }
    if (this.accept('per')) {
      const unit = this.name(); this.expect(';');
      if (unit !== 'step') fail(this.peek(), 'Only per step aggregation is inside gil-rl-environment-0.1', 'UNSUPPORTED_SYNTAX');
      return { name, amount, kind: 'per-step' };
    }
    return this.unsupported('Reward term timing');
  }

  /**
   * 量词绑定的类型。
   *
   * 量词分隔符 `.` 与限定名的 `.` 同形，只能靠命名约定消歧：Core 里概念名
   * 首字母大写、`alias.Concept` 最多两段，而绑定变量名小写。因此只在点后是
   * 大写标识符时，才把它当成类型的第二段；否则该点就是分隔符。
   */
  quantifierType(): { type: TypeExpr; separated: boolean } {
    const start = this.index;
    const first = this.name();
    if (this.is('<')) {
      this.index = start;
      const type = this.postfixType();
      const separated = this.accept('.');
      return { type, separated };
    }
    const segments = [first];
    const afterDot = this.tokens[this.index + 1]?.text ?? '';
    if (this.is('.') && /^[A-Z]/.test(afterDot)) {
      this.take(); segments.push(this.name());
    }
    const separated = this.accept('.');
    if (!separated) fail(this.peek(), "Expected '.' before the quantifier body");
    return { type: { kind: 'name', path: segments }, separated: true };
  }

  /** 带单位的量：`100.steps`、`2.minutes`。单位白名单由调用方限定。 */
  quantity(units: readonly string[] = STEP_UNITS): { value: number; unit: string } {
    const value = this.number(); this.expect('.'); const unit = this.name();
    if (!units.includes(unit)) {
      fail(this.peek(), `Unsupported unit ${unit}; expected ${units.join(', ')}`, 'UNSUPPORTED_SYNTAX');
    }
    return { value, unit };
  }

  number(): number {
    const token = this.peek();
    if (token.kind !== 'number') fail(token, 'Expected a number');
    const value = Number(this.take().text);
    if (!Number.isFinite(value)) fail(token, 'Non-finite number');
    return value;
  }

  signedNumber(): number {
    const negative = this.accept('-');
    const value = this.number();
    return negative ? -value : value;
  }

  /** 与 Core action 相同，额外允许 outcomes 块（有限随机转移）。 */
  rlAction(): RlAction {
    this.expect('action'); const name = this.name(), params = this.parameters();
    if (this.is('->')) this.unsupported('Action return type');
    const result: RlAction = { name, params, requires: [], ensures: [], writes: [], atomic: false, outcomes: [] };
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
      } else if (this.accept('outcomes')) {
        this.unique(singleton, 'outcomes', token, 'action clause');
        this.expect('{');
        while (!this.is('}')) {
          const branchToken = this.peek(), probability = this.number();
          if (probability < 0 || probability > 1) fail(branchToken, 'Outcome probability must be within [0,1]');
          this.expect('->'); const ensures = this.expression(); this.expect(';');
          result.outcomes.push({ probability, ensures });
        }
        this.expect('}');
      } else this.unsupported('Action clause');
    }
    this.expect(';'); return result;
  }

  action(): Action {
    this.expect('action'); const name = this.name(), params = this.parameters();
    const returns = this.accept('->') ? this.type() : undefined;
    const result: Action = { name, params, requires: [], ensures: [], writes: [], atomic: false };
    if (returns !== undefined) result.returns = returns;
    const singleton = new Set<string>();
    while (!this.is(';')) {
      const token = this.peek();
      if (this.accept('requires')) result.requires.push(this.expression());
      else if (this.accept('ensures')) result.ensures.push(this.expression());
      else if (this.accept('preserves')) {
        this.unique(singleton, 'preserves', token, 'action clause');
        (result.preserves ??= []).push(this.expression());
      } else if (this.accept('writes')) {
        this.unique(singleton, 'writes', token, 'action clause');
        const references = new Set<string>();
        do {
          const refToken = this.peek(), ref = this.path().join('.');
          this.unique(references, ref, refToken, 'write target'); result.writes.push(ref);
        } while (this.accept(','));
      } else if (this.accept('atomic')) {
        this.unique(singleton, 'atomic', token, 'action clause'); result.atomic = true;
      } else if (this.accept('outcomes')) {
        this.unique(singleton, 'outcomes', token, 'action clause');
        result.outcomes = this.outcomes();
      } else if (this.accept('failure')) {
        this.unique(singleton, 'failure', token, 'action clause');
        const failures: string[] = [];
        do { failures.push(this.name()); } while (this.accept(','));
        result.failures = failures;
      } else if (this.accept('retryable')) {
        this.unique(singleton, 'retryable', token, 'action clause');
        if (!this.is('true') && !this.is('false')) fail(this.peek(), 'retryable requires true or false');
        result.retryable = this.take().text === 'true';
      } else if (this.accept('reversibility')) {
        this.unique(singleton, 'reversibility', token, 'action clause');
        const kind = this.peek().text;
        if (!['reversible', 'compensable', 'irreversible'].includes(kind)) {
          fail(this.peek(), 'reversibility must be reversible, compensable or irreversible', 'UNSUPPORTED_SYNTAX');
        }
        result.reversibility = this.take().text as Action['reversibility'];
      } else if (this.accept('compensate')) {
        this.unique(singleton, 'compensate', token, 'action clause');
        result.compensate = this.expression();
      } else this.unsupported('Action clause');
    }
    this.expect(';'); return result;
  }

  /** 有限随机转移块，Core 与 RL 共用。 */
  outcomes(): { probability: number; ensures: Expr }[] {
    this.expect('{');
    const result: { probability: number; ensures: Expr }[] = [];
    while (!this.is('}')) {
      const branchToken = this.peek(), probability = this.number();
      if (probability < 0 || probability > 1) fail(branchToken, 'Outcome probability must be within [0,1]');
      this.expect('->'); const ensures = this.expression(); this.expect(';');
      result.push({ probability, ensures });
    }
    this.expect('}');
    return result;
  }
  expression(min = 1): Expr {
    let left = this.prefix();
    while (true) {
      const token = this.peek();
      const level = token.kind === 'symbol' ? precedence[token.text]
        : this.rl && token.text === 'in' ? 4 : undefined;
      if (level === undefined || level < min) break;
      this.take();
      const right = this.expression(token.text === '=>' ? level : level + 1);
      left = { kind: 'binary', op: token.text, left, right };
    }
    return left;
  }
  prefix(): Expr {
    const token = this.peek();
    if (this.is('forall') || this.is('exists')) {
      const quantifier = this.take().text as 'forall' | 'exists';
      // 绑定名允许逗号或空白分隔：`forall b1 b2: H.Booking.`
      const names = [this.name()];
      while (this.accept(',') || (this.peek().kind === 'id' && !reserved.has(this.peek().text))) names.push(this.name());
      this.expect(':');
      /*
       * 量词的 `.` 与限定名里的 `.` 同形：`exists b: H.Booking. chosen == b`。
       * path() 会把分隔点后的首段也当成类型段吃掉，所以这里回退一段，
       * 让量词体从正确的 token 开始。若类型是构造类型，path 停在 `<`，
       * 不会出现这种情况。
       */
      const quantified = this.quantifierType();
      const { type } = quantified;
      const text = renderType(type);
      const bindings: Binding[] = names.map(name => {
        const binding: Binding = { name, type: text };
        if (type.kind !== 'name') binding.typeExpr = type;
        return binding;
      });
      return { kind: 'quantifier', quantifier, bindings, body: this.expression() };
    }
    if (['!', '-', 'not', 'always', 'eventually'].some(t => this.is(t))) {
      this.take(); const op = token.text === 'not' ? '!' : token.text;
      if (op === 'eventually' && this.accept('within')) {
        const bound = this.quantity(BOUND_UNITS);
        // 时间界限绑定其后的完整表达式：`eventually within 2.minutes e`。
        return { kind: 'unary', op, arg: { kind: 'bounded', value: bound.value, unit: bound.unit, arg: this.expression(4) } };
      }
      // RL 里 not/always/eventually 必须绑定到整个比较表达式，否则 `not x in S` 会错解成 `(!x) in S`。
      if (this.rl && op !== '-') return { kind: 'unary', op, arg: this.expression(4) };
      return { kind: 'unary', op, arg: this.prefix() };
    }
    if (this.accept('(')) { const expr = this.expression(); this.expect(')'); return expr; }
    if (token.kind === 'string') { this.take(); return { kind: 'literal', value: token.text }; }
    if (token.kind === 'number') {
      this.take(); const value = Number(token.text);
      // 单位字面量：`24.hours`。点后必须是标识符，否则仍是普通数字。
      if (this.is('.') && this.tokens[this.index + 1]?.kind === 'id') {
        this.take(); return { kind: 'quantity', value, unit: this.name() };
      }
      return { kind: 'literal', value };
    }
    if (this.accept('true')) return { kind: 'literal', value: true };
    if (this.accept('false')) return { kind: 'literal', value: false };
    const isPredicate = token.kind === 'id' && predicateKeywords.has(token.text) && this.tokens[this.index + 1]?.text === '(';
    const isTerm = token.kind === 'id' && termKeywords.has(token.text);
    if (token.kind === 'id' && (!reserved.has(token.text) || isPredicate || isTerm)) {
      const path = isPredicate || isTerm ? [this.take().text] : this.path();
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

/** bundle 里的顶层项：Core 文档、解释或委派请求。 */
export type BundleItem = Document | Interpretation | DelegationDocument;

export function parse(source: string): Document { return new Parser(source).document(); }

/**
 * 解析含多个顶层文档的文件。
 *
 * 单个文档入口 `parse` 仍只接受一个文档；bundle 只用于规范仓库里把
 * spec、interpretation 与 delegate 放在同一份示例中的情形。
 */
export function parseBundle(source: string): BundleItem[] { return new Parser(source).bundle(); }

/** GIL-RL 环境文档入口：启用 in 运算符与 within 界限。 */
export function parseEnvironment(source: string): Environment {
  const document = new Parser(source, true).document();
  if (document.kind !== 'environment') throw new GilError('CLI_ERROR', 'Expected an environment document');
  return document;
}

/** Independent Exchange entry point; the Core Document parser remains unchanged. */
export function parseInterpretation(source: string): Interpretation { return new Parser(source).interpretation(); }
