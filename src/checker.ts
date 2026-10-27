import { GilError } from './ast.ts';
import type { Binding, Diagnostic, Expr, Linked, Ontology, Relation, Spec } from './ast.ts';

/** Resolve only exact name@version imports; never pick a latest version. */
export function link(spec: Spec, ontologies: Ontology[]): Linked {
  const result: Record<string, Ontology> = Object.create(null);
  for (const item of spec.imports) {
    // 词法表不携带概念语义，由 Exchange 层解析；这里不能把它当 ontology 解析。
    if (item.layer === 'lexicon') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(item.alias)) {
      throw new GilError('INVALID_ALIAS', `Invalid ontology alias ${item.alias}`);
    }
    if (Object.hasOwn(result, item.alias)) {
      throw new GilError('DUPLICATE_ALIAS', `Duplicate ontology alias ${item.alias}`);
    }
    const at = item.name.lastIndexOf('@');
    const name = item.name.slice(0, at);
    const version = item.name.slice(at + 1);
    if (at < 1 || !version || version === 'latest' || /[\s*^~<>|]/.test(version)) {
      throw new GilError('IMPORT_VERSION_REQUIRED', `Import ${item.name} must use an exact version`);
    }
    const matches = ontologies.filter(o => o.name === name && o.version === version);
    if (matches.length !== 1) {
      throw new GilError(matches.length ? 'AMBIGUOUS_IMPORT' : 'UNRESOLVED_IMPORT',
        `Expected exactly one ontology ${item.name}; found ${matches.length}`);
    }
    result[item.alias] = matches[0];
  }
  return { spec, ontologies: result };
}

type Type = string | null;
interface Scope {
  bindings: Map<string, string>;
  ontology?: Ontology;
  temporal: boolean;
  next: boolean;
  writes?: Set<string>;
}
const basics = new Set(['Text', 'Bool', 'Int', 'Decimal']);
const numeric = (type: Type) => type === 'Int' || type === 'Decimal';
const compatible = (expected: Type, actual: Type) => expected === actual || (expected === 'Decimal' && actual === 'Int');
const ontologyKey = (o: Ontology) => `${o.name}@${o.version}`;
const conceptKey = (o: Ontology, name: string) => `${ontologyKey(o)}:${name}`;

/** Static errors are diagnostics, not runtime Unknown values. */
export function check(linked: Linked): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const { spec } = linked;
  const report = (code: string, message: string) => { diagnostics.push({ code, message }); };
  const ontologies = [...new Map(Object.values(linked.ontologies).map(o => [ontologyKey(o), o])).values()];
  const concepts = new Map<string, { ontology: Ontology; fields: Binding[] }>();
  for (const ontology of ontologies) {
    for (const concept of ontology.concepts) {
      concepts.set(conceptKey(ontology, concept.name), { ontology, fields: concept.fields });
    }
  }
  function unique(names: string[], label: string): void {
    const seen = new Set<string>();
    for (const name of names) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) report('INVALID_NAME', `${label}: invalid name ${name}`);
      if (seen.has(name)) report('DUPLICATE_NAME', `${label}: duplicate name ${name}`);
      seen.add(name);
    }
  }
  function importedOntology(alias: string): Ontology | undefined {
    return Object.hasOwn(linked.ontologies, alias) ? linked.ontologies[alias] : undefined;
  }
  function resolveType(name: string, ontology?: Ontology): Type {
    if (basics.has(name)) return name;
    if (ontology && concepts.has(conceptKey(ontology, name))) return conceptKey(ontology, name);
    if (!ontology) {
      const parts = name.split('.');
      const imported = importedOntology(parts[0]);
      if (parts.length === 2 && imported && concepts.has(conceptKey(imported, parts[1]))) {
        return conceptKey(imported, parts[1]);
      }
    }
    report('UNSUPPORTED_TYPE', `Type ${name} is unresolved or outside the finite Core profile`);
    return null;
  }
  function expect(actual: Type, expected: Type, label: string): void {
    if (actual !== null && expected !== null && !compatible(expected, actual)) {
      report('TYPE_MISMATCH', `${label}: expected ${expected}, received ${actual}`);
    }
  }
  function resolveRelation(path: string[], ontology?: Ontology): { ontology: Ontology; relation: Relation } | null {
    const owner = ontology ? (path.length === 1 ? ontology : undefined) :
      (path.length === 2 ? importedOntology(path[0]) : undefined);
    const relation = owner?.relations.find(r => r.name === path[path.length - 1]);
    if (!owner || !relation) {
      report('UNRESOLVED_RELATION', `Unresolved pure relation ${path.join('.')}`);
      return null;
    }
    return { ontology: owner, relation };
  }
  function infer(expr: Expr, scope: Scope): Type {
    switch (expr.kind) {
      case 'literal': {
        if (typeof expr.value === 'string') return 'Text';
        if (typeof expr.value === 'boolean') return 'Bool';
        if (typeof expr.value === 'number' && Number.isFinite(expr.value)) {
          if (Number.isInteger(expr.value) && !Number.isSafeInteger(expr.value)) {
            report('INVALID_LITERAL', 'Int literal exceeds the safe integer range');
            return null;
          }
          return Number.isInteger(expr.value) ? 'Int' : 'Decimal';
        }
        report('INVALID_LITERAL', 'Unsupported literal value');
        return null;
      }
      case 'ref': {
        const root = expr.path[0];
        const declared = scope.bindings.get(root);
        if (!declared) {
          report('UNRESOLVED_REFERENCE', `Unresolved reference ${expr.path.join('.')}`);
          return null;
        }
        if (expr.next) {
          if (!scope.next || !spec.state.some(b => b.name === root) || scope.ontology) {
            report('INVALID_NEXT_SCOPE', `Next reference ${expr.path.join('.')} is only valid for state in ensures`);
          } else if (!scope.writes?.has(root)) {
            report('NEXT_NOT_WRITTEN', `Next state ${root} must be listed in writes`);
          }
        }
        let type = resolveType(declared, scope.ontology);
        for (const fieldName of expr.path.slice(1)) {
          if (type === null) return null;
          const concept = concepts.get(type);
          const field = concept?.fields.find(f => f.name === fieldName);
          if (!concept || !field) {
            report('UNRESOLVED_FIELD', `${expr.path.join('.')}: ${fieldName} is not a field of ${type}`);
            return null;
          }
          type = resolveType(field.type, concept.ontology);
        }
        return type;
      }
      case 'call': {
        const target = resolveRelation(expr.path, scope.ontology);
        const actual = expr.args.map(arg => infer(arg, scope));
        if (!target) return null;
        if (actual.length !== target.relation.params.length) {
          report('RELATION_ARITY', `${expr.path.join('.')}: expected ${target.relation.params.length} arguments, received ${actual.length}`);
        }
        target.relation.params.forEach((param, i) => {
          if (i < actual.length) expect(actual[i], resolveType(param.type, target.ontology), `Argument ${param.name} of ${expr.path.join('.')}`);
        });
        return resolveType(target.relation.type, target.ontology);
      }
      case 'unary': {
        const arg = infer(expr.arg, scope);
        if (expr.op === '!' || expr.op === 'always' || expr.op === 'eventually') {
          if (expr.op !== '!' && !scope.temporal) report('UNSUPPORTED_TEMPORAL_SCOPE', `${expr.op} is supported only in goals and constraints`);
          expect(arg, 'Bool', `Operator ${expr.op}`);
          return arg === null ? null : 'Bool';
        }
        if (expr.op === '-' || expr.op === '+') {
          if (arg !== null && !numeric(arg)) report('TYPE_MISMATCH', `Operator ${expr.op} requires a numeric operand`);
          return numeric(arg) ? arg : null;
        }
        report('UNSUPPORTED_OPERATOR', `Unsupported unary operator ${expr.op}`);
        return null;
      }
      case 'binary': {
        const left = infer(expr.left, scope);
        const right = infer(expr.right, scope);
        if (['&&', '||', '=>'].includes(expr.op)) {
          expect(left, 'Bool', `Left operand of ${expr.op}`);
          expect(right, 'Bool', `Right operand of ${expr.op}`);
          return left === null || right === null ? null : 'Bool';
        }
        if (['==', '!='].includes(expr.op)) {
          // A root-state prime equality in ensures is also a runtime assignment.
          // Numeric comparison is symmetric; assignment widening is not.
          if (expr.op === '==' && scope.next && expr.left.kind === 'ref' && expr.left.next &&
              expr.left.path.length === 1 && spec.state.some(b => b.name === expr.left.path[0])) {
            expect(right, left, `Assignment to ${expr.left.path[0]}`);
          } else if (left !== null && right !== null && left !== right && !(numeric(left) && numeric(right))) {
            report('TYPE_MISMATCH', `Operator ${expr.op} cannot compare ${left} with ${right}`);
          }
          return left === null || right === null ? null : 'Bool';
        }
        if (['<', '<=', '>', '>=', '+', '-', '*', '/', '%'].includes(expr.op)) {
          if ((left !== null && !numeric(left)) || (right !== null && !numeric(right))) {
            report('TYPE_MISMATCH', `Operator ${expr.op} requires numeric operands`);
            return null;
          }
          if (left === null || right === null) return null;
          if (['<', '<=', '>', '>='].includes(expr.op)) return 'Bool';
          return expr.op === '/' || left === 'Decimal' || right === 'Decimal' ? 'Decimal' : 'Int';
        }
        report('UNSUPPORTED_OPERATOR', `Unsupported binary operator ${expr.op}`);
        return null;
      }
      default:
        report('UNSUPPORTED_EXPRESSION', 'Expression is outside the finite Core profile');
        return null;
    }
  }
  function bindings(items: Binding[], scope: Scope, label: string, defaults = true): void {
    unique(items.map(b => b.name), label);
    for (const binding of items) {
      const type = resolveType(binding.type, scope.ontology);
      if (binding.value !== undefined) {
        if (!defaults) report('UNSUPPORTED_DEFAULT', `${label}: defaults are not supported for ${binding.name}`);
        expect(infer(binding.value, scope), type, `Initializer ${binding.name}`);
      }
    }
  }
  // Validate every imported declaration, including relations unused by the spec.
  for (const ontology of ontologies) {
    unique([...ontology.concepts.map(c => c.name), ...ontology.relations.map(r => r.name)], `Ontology ${ontologyKey(ontology)}`);
    for (const concept of ontology.concepts) {
      const scope: Scope = { bindings: new Map(), ontology, temporal: false, next: false };
      bindings(concept.fields, scope, `Fields of ${concept.name}`, false);
      if (!concept.fields.some(f => f.name === concept.identity)) {
        report('INVALID_IDENTITY', `${concept.name}: identity ${concept.identity} must name a declared field`);
      }
    }
    for (const relation of ontology.relations) {
      const scope: Scope = { bindings: new Map(relation.params.map(p => [p.name, p.type])), ontology, temporal: false, next: false };
      bindings(relation.params, scope, `Parameters of ${relation.name}`, false);
      expect(infer(relation.body, scope), resolveType(relation.type, ontology), `Return of relation ${relation.name}`);
    }
    const edges = new Map<string, Set<string>>();
    function calls(expr: Expr, result: Set<string>): void {
      switch (expr.kind) {
        case 'call':
          if (expr.path.length === 1 && ontology.relations.some(r => r.name === expr.path[0])) result.add(expr.path[0]);
          expr.args.forEach(arg => calls(arg, result));
          break;
        case 'unary': calls(expr.arg, result); break;
        case 'binary': calls(expr.left, result); calls(expr.right, result); break;
      }
    }
    for (const relation of ontology.relations) {
      const deps = new Set<string>();
      calls(relation.body, deps);
      edges.set(relation.name, deps);
    }
    const active = new Set<string>();
    const done = new Set<string>();
    function visit(name: string): void {
      if (active.has(name)) { report('RECURSIVE_RELATION', `Recursive relation ${ontologyKey(ontology)}.${name} is outside the finite Core profile`); return; }
      if (done.has(name)) return;
      active.add(name);
      for (const dep of edges.get(name) ?? []) visit(dep);
      active.delete(name);
      done.add(name);
    }
    for (const name of edges.keys()) visit(name);
  }
  const globals = [...spec.context, ...spec.input, ...spec.state];
  unique([...spec.imports.map(i => i.alias), ...globals.map(b => b.name)], 'Spec namespace');
  const globalScope: Scope = { bindings: new Map(globals.map(b => [b.name, b.type])), temporal: false, next: false };
  bindings(spec.context, globalScope, 'Context');
  bindings(spec.input, globalScope, 'Input', false);
  bindings(spec.state, globalScope, 'State');
  unique([...spec.goals, ...spec.constraints].map(c => c.name), 'Claims');
  for (const claim of [...spec.goals, ...spec.constraints]) {
    expect(infer(claim.expr, { ...globalScope, temporal: true }), 'Bool', `Claim ${claim.name}`);
  }
  unique(spec.actions.map(a => a.name), 'Actions');
  for (const action of spec.actions) {
    for (const param of action.params) {
      if (globalScope.bindings.has(param.name) || Object.hasOwn(linked.ontologies, param.name)) {
        report('DUPLICATE_NAME', `Action ${action.name}: parameter ${param.name} shadows a spec name`);
      }
    }
    const scope: Scope = { ...globalScope, bindings: new Map([...globalScope.bindings, ...action.params.map(p => [p.name, p.type] as [string, string])]) };
    bindings(action.params, scope, `Parameters of ${action.name}`, false);
    const writes = new Set<string>();
    for (const write of action.writes) {
      if (writes.has(write)) report('DUPLICATE_WRITE', `Action ${action.name}: duplicate write ${write}`);
      writes.add(write);
      if (!spec.state.some(b => b.name === write)) report('INVALID_WRITE', `Action ${action.name}: writes target ${write} must name a state binding`);
    }
    for (const expr of action.requires) expect(infer(expr, scope), 'Bool', `Requires of ${action.name}`);
    for (const expr of action.ensures) expect(infer(expr, { ...scope, next: true, writes }), 'Bool', `Ensures of ${action.name}`);
  }
  return diagnostics;
}
