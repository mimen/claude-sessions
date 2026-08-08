import { dirname, extname, normalize, resolve } from "node:path";
import ts from "typescript";

export interface ImportReference {
  readonly specifier: string;
  readonly names: readonly string[];
}

export interface CatalogueWriterTargets {
  readonly catalogueSchemaModule: string;
}

interface LexicalScope {
  readonly parent: LexicalScope | null;
  readonly bindings: Map<string, ts.Node>;
}

function functionBody(node: ts.SignatureDeclaration): ts.ConciseBody | null {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return node.body;
  if (ts.isFunctionDeclaration(node)
    || ts.isMethodDeclaration(node)
    || ts.isConstructorDeclaration(node)
    || ts.isGetAccessorDeclaration(node)
    || ts.isSetAccessorDeclaration(node)) return node.body ?? null;
  return null;
}

class LexicalBindings {
  readonly #nodeScopes = new Map<ts.Node, LexicalScope>();
  readonly #root: LexicalScope = { parent: null, bindings: new Map() };

  constructor(readonly sourceFile: ts.SourceFile) {
    this.#visitSourceFile(sourceFile);
  }

  scopeOf(node: ts.Node): LexicalScope | null {
    return this.#nodeScopes.get(node) ?? null;
  }

  resolve(identifier: ts.Identifier): ts.Node | null {
    let scope = this.scopeOf(identifier);
    while (scope) {
      const declaration = scope.bindings.get(identifier.text);
      if (declaration) return declaration;
      scope = scope.parent;
    }
    return null;
  }

  #record(node: ts.Node, scope: LexicalScope): void {
    this.#nodeScopes.set(node, scope);
  }

  #bindName(name: ts.BindingName, declaration: ts.Node, scope: LexicalScope): void {
    if (ts.isIdentifier(name)) {
      scope.bindings.set(name.text, declaration);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) this.#bindName(element.name, element, scope);
    }
  }

  #visitSourceFile(node: ts.SourceFile): void {
    this.#record(node, this.#root);
    for (const statement of node.statements) this.#visit(statement, this.#root);
  }

  #visit(node: ts.Node, scope: LexicalScope): void {
    this.#record(node, scope);
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      if (clause?.name) scope.bindings.set(clause.name.text, clause);
      if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          scope.bindings.set(element.name.text, element);
          this.#record(element, scope);
          this.#record(element.name, scope);
        }
      } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        scope.bindings.set(clause.namedBindings.name.text, clause.namedBindings);
        this.#record(clause.namedBindings, scope);
        this.#record(clause.namedBindings.name, scope);
      }
      ts.forEachChild(node, (child) => this.#recordTree(child, scope));
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isClassDeclaration(node) && node.name) scope.bindings.set(node.name.text, node);
    if (ts.isFunctionLike(node)) {
      const functionScope: LexicalScope = { parent: scope, bindings: new Map() };
      for (const parameter of node.parameters) {
        this.#record(parameter, functionScope);
        this.#bindName(parameter.name, parameter, functionScope);
        ts.forEachChild(parameter, (child) => this.#recordTree(child, functionScope));
      }
      const body = functionBody(node);
      if (body) this.#visit(body, functionScope);
      return;
    }
    if (ts.isBlock(node)) {
      const blockScope: LexicalScope = { parent: scope, bindings: new Map() };
      this.#record(node, blockScope);
      for (const statement of node.statements) this.#visit(statement, blockScope);
      return;
    }
    if (ts.isCatchClause(node)) {
      const catchScope: LexicalScope = { parent: scope, bindings: new Map() };
      this.#record(node, catchScope);
      if (node.variableDeclaration) {
        this.#record(node.variableDeclaration, catchScope);
        this.#bindName(node.variableDeclaration.name, node.variableDeclaration, catchScope);
      }
      this.#visit(node.block, catchScope);
      return;
    }
    if (ts.isForStatement(node)) {
      const loopScope: LexicalScope = { parent: scope, bindings: new Map() };
      this.#record(node, loopScope);
      if (node.initializer) this.#visit(node.initializer, loopScope);
      if (node.condition) this.#visit(node.condition, loopScope);
      if (node.incrementor) this.#visit(node.incrementor, loopScope);
      this.#visit(node.statement, loopScope);
      return;
    }
    if (ts.isForInStatement(node) || ts.isForOfStatement(node)) {
      const loopScope: LexicalScope = { parent: scope, bindings: new Map() };
      this.#record(node, loopScope);
      this.#visit(node.initializer, loopScope);
      this.#visit(node.expression, loopScope);
      this.#visit(node.statement, loopScope);
      return;
    }
    if (ts.isVariableDeclaration(node)) this.#bindName(node.name, node, scope);
    ts.forEachChild(node, (child) => this.#visit(child, scope));
  }

  #recordTree(node: ts.Node, scope: LexicalScope): void {
    this.#record(node, scope);
    ts.forEachChild(node, (child) => this.#recordTree(child, scope));
  }
}

function sourceFile(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function staticImportNames(node: ts.ImportDeclaration): string[] {
  const clause = node.importClause;
  if (!clause) return [];
  const names: string[] = [];
  if (clause.name) names.push("default");
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    for (const element of clause.namedBindings.elements) {
      names.push(element.propertyName?.text ?? element.name.text);
    }
  }
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) names.push("*");
  return names;
}

function exportNames(node: ts.ExportDeclaration): string[] {
  if (!node.exportClause) return ["*"];
  if (ts.isNamespaceExport(node.exportClause)) return ["*"];
  return node.exportClause.elements.map((element) => element.propertyName?.text ?? element.name.text);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isAwaitExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function callSpecifier(node: ts.CallExpression): string | null {
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
  if (!isDynamicImport && !isRequire) return null;
  const argument = node.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function moduleCall(expression: ts.Expression): ts.CallExpression | null {
  const unwrapped = unwrapExpression(expression);
  return ts.isCallExpression(unwrapped) && callSpecifier(unwrapped) ? unwrapped : null;
}

function destructuredCallNames(node: ts.CallExpression): string[] {
  const parent = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
  if (!ts.isVariableDeclaration(parent) || !ts.isObjectBindingPattern(parent.name)) return [];
  return parent.name.elements.map((element) => element.propertyName && ts.isIdentifier(element.propertyName)
    ? element.propertyName.text
    : element.name.getText());
}

export function importReferences(source: string, fileName = "source.ts"): ImportReference[] {
  const parsed = sourceFile(source, fileName);
  const references: ImportReference[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({ specifier: node.moduleSpecifier.text, names: staticImportNames(node) });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      references.push({ specifier: node.moduleSpecifier.text, names: exportNames(node) });
    } else if (ts.isCallExpression(node)) {
      const specifier = callSpecifier(node);
      if (specifier) references.push({ specifier, names: destructuredCallNames(node) });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return references;
}

function normalizedModulePath(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const path = normalize(resolve(dirname(importer), specifier));
  return extname(path) ? path : `${path}.ts`;
}

function moduleMatches(importer: string, specifier: string, target: string): boolean {
  if (!target.startsWith(".") && !target.startsWith("/")) return specifier === target;
  return normalizedModulePath(importer, specifier) === normalize(resolve(target));
}

export function importsModule(source: string, importer: string, target: string): boolean {
  return importReferences(source, importer).some((reference) => moduleMatches(importer, reference.specifier, target));
}

interface ModuleBindings {
  readonly direct: Map<string, Set<ts.Node>>;
  readonly namespaces: Set<ts.Node>;
}

function addDirectBinding(bindings: ModuleBindings, exportedName: string, declaration: ts.Node): void {
  const declarations = bindings.direct.get(exportedName) ?? new Set<ts.Node>();
  declarations.add(declaration);
  bindings.direct.set(exportedName, declarations);
}

function collectModuleBindings(parsed: ts.SourceFile, importer: string, target: string): ModuleBindings {
  const bindings: ModuleBindings = { direct: new Map(), namespaces: new Set() };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (moduleMatches(importer, node.moduleSpecifier.text, target)) {
        const clause = node.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            addDirectBinding(bindings, element.propertyName?.text ?? element.name.text, element);
          }
        } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          bindings.namespaces.add(clause.namedBindings);
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const call = moduleCall(node.initializer);
      const specifier = call ? callSpecifier(call) : null;
      if (specifier && moduleMatches(importer, specifier, target)) {
        if (ts.isIdentifier(node.name)) {
          bindings.namespaces.add(node);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const exportedName = element.propertyName?.getText(parsed) ?? element.name.getText(parsed);
            addDirectBinding(bindings, exportedName, element);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return bindings;
}

function memberName(node: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  const argument = node.argumentExpression;
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function directModuleMember(
  node: ts.Expression,
  importer: string,
  target: string,
  exportedName: string,
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  if (memberName(expression) !== exportedName) return false;
  const call = moduleCall(expression.expression);
  const specifier = call ? callSpecifier(call) : null;
  return !!specifier && moduleMatches(importer, specifier, target);
}

function identifierResolvesTo(
  identifier: ts.Identifier,
  declarations: ReadonlySet<ts.Node>,
  lexical: LexicalBindings,
): boolean {
  const declaration = lexical.resolve(identifier);
  return !!declaration && declarations.has(declaration);
}

function namespaceMemberResolvesTo(
  node: ts.Expression,
  declarations: ReadonlySet<ts.Node>,
  exportedName: string,
  lexical: LexicalBindings,
): boolean {
  const expression = unwrapExpression(node);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return false;
  if (memberName(expression) !== exportedName || !ts.isIdentifier(expression.expression)) return false;
  return identifierResolvesTo(expression.expression, declarations, lexical);
}

export function importsNamedBindingFromModule(
  source: string,
  importer: string,
  target: string,
  protectedNames: ReadonlySet<string>,
): boolean {
  const parsed = sourceFile(source, importer);
  const lexical = new LexicalBindings(parsed);
  const bindings = collectModuleBindings(parsed, importer, target);
  for (const name of protectedNames) {
    if ((bindings.direct.get(name)?.size ?? 0) > 0) return true;
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const name = memberName(node);
      if (name && protectedNames.has(name)) {
        if (directModuleMember(node, importer, target, name)
          || namespaceMemberResolvesTo(node, bindings.namespaces, name, lexical)) {
          found = true;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

function templateText(node: ts.TemplateExpression, parsed: ts.SourceFile): string {
  return `${node.head.text}${node.templateSpans.map((span) =>
    `\${${span.expression.getText(parsed)}}${span.literal.text}`
  ).join("")}`;
}

function isConstVariable(declaration: ts.VariableDeclaration): boolean {
  return ts.isVariableDeclarationList(declaration.parent)
    && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
}

function constantString(
  expression: ts.Expression,
  lexical: LexicalBindings,
  resolving: ReadonlySet<ts.VariableDeclaration> = new Set(),
): string | null {
  const node = unwrapExpression(expression);
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const declaration = lexical.resolve(node);
    if (!declaration
      || !ts.isVariableDeclaration(declaration)
      || !isConstVariable(declaration)
      || !declaration.initializer
      || resolving.has(declaration)) return null;
    const nextResolving = new Set(resolving);
    nextResolving.add(declaration);
    return constantString(declaration.initializer, lexical, nextResolving);
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const substitution = constantString(span.expression, lexical, resolving);
      if (substitution === null) return null;
      value += substitution + span.literal.text;
    }
    return value;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantString(node.left, lexical, resolving);
    if (left === null) return null;
    const right = constantString(node.right, lexical, resolving);
    return right === null ? null : left + right;
  }
  return null;
}

function parentConstantConcatenation(
  node: ts.Expression,
  lexical: LexicalBindings,
): boolean {
  const parent = node.parent;
  return ts.isBinaryExpression(parent)
    && parent.operatorToken.kind === ts.SyntaxKind.PlusToken
    && constantString(parent, lexical) !== null;
}

const CATALOGUE_TABLE = "(?:catalogue|category_backfill_audits|category_schema_migrations|dispositions|epics|groupings|historical_detached_child_backfills|identities|identity_[a-z_]+|inboxes|roles|schema_migrations|session_category_assignments|session_category_attempts|session_tags)";
const DYNAMIC_IDENTITY_TABLE = "(?:\\$\\{[^}]*\\btableName\\b[^}]*\\})";
const TABLE_TARGET = `(?:["\`\\[]?(?:${CATALOGUE_TABLE})\\b|${DYNAMIC_IDENTITY_TABLE})`;
const PROTECTED_TABLE_MUTATION_SQL = new RegExp(
  `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO|ALTER\\s+TABLE|DROP\\s+TABLE|CREATE\\s+TABLE)\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?${TABLE_TARGET}`,
  "i",
);
const PROTECTED_INDEX_MUTATION_SQL = new RegExp(
  `\\bCREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?[^\\s]+\\s+ON\\s+${TABLE_TARGET}`,
  "i",
);

export function protectedMutationSql(source: string, fileName = "source.ts"): string[] {
  const parsed = sourceFile(source, fileName);
  const lexical = new LexicalBindings(parsed);
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteralLike(node)
      || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateExpression(node)
      || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
      if (!parentConstantConcatenation(node, lexical)) text = constantString(node, lexical);
      if (text === null && ts.isTemplateExpression(node)) text = templateText(node, parsed);
    }
    if (text && (PROTECTED_TABLE_MUTATION_SQL.test(text) || PROTECTED_INDEX_MUTATION_SQL.test(text))) matches.push(text);
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return matches;
}

function hasReadonlyTrue(object: ts.ObjectLiteralExpression): boolean {
  if (object.properties.some((property) => ts.isSpreadAssignment(property))) return false;
  return object.properties.some((property) =>
    ts.isPropertyAssignment(property)
      && ((ts.isIdentifier(property.name) && property.name.text === "readonly")
        || (ts.isStringLiteralLike(property.name) && property.name.text === "readonly"))
      && property.initializer.kind === ts.SyntaxKind.TrueKeyword
  );
}

type DatabaseConstructorCheck = (node: ts.NewExpression) => boolean;

function isTypeOnlyReference(identifier: ts.Identifier): boolean {
  let node: ts.Node = identifier;
  while (node.parent && !ts.isStatement(node.parent) && !ts.isSourceFile(node.parent)) {
    node = node.parent;
    if (ts.isTypeNode(node)) return true;
  }
  return false;
}

function isAcceptedOptionsArgument(
  identifier: ts.Identifier,
  constructsDatabase: DatabaseConstructorCheck,
): boolean {
  let expression: ts.Expression = identifier;
  while (
    expression.parent
    && (ts.isParenthesizedExpression(expression.parent)
      || ts.isAsExpression(expression.parent)
      || ts.isSatisfiesExpression(expression.parent)
      || ts.isTypeAssertionExpression(expression.parent))
    && expression.parent.expression === expression
  ) {
    expression = expression.parent;
  }
  const parent = expression.parent;
  return ts.isNewExpression(parent)
    && parent.arguments?.[1] === expression
    && constructsDatabase(parent);
}

function hasOnlyAcceptedReadonlyReferences(
  parsed: ts.SourceFile,
  declaration: ts.VariableDeclaration,
  lexical: LexicalBindings,
  constructsDatabase: DatabaseConstructorCheck,
): boolean {
  let accepted = true;
  const visit = (node: ts.Node): void => {
    if (!accepted) return;
    if (ts.isIdentifier(node)
      && !(node.pos >= declaration.pos && node.end <= declaration.end)
      && lexical.resolve(node) === declaration
      && !isTypeOnlyReference(node)
      && !isAcceptedOptionsArgument(node, constructsDatabase)) {
      accepted = false;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return accepted;
}

function optionIsReadonly(
  option: ts.Expression | undefined,
  parsed: ts.SourceFile,
  lexical: LexicalBindings,
  constructsDatabase: DatabaseConstructorCheck,
): boolean {
  if (!option) return false;
  const unwrapped = unwrapExpression(option);
  if (ts.isObjectLiteralExpression(unwrapped)) return hasReadonlyTrue(unwrapped);
  if (!ts.isIdentifier(unwrapped)) return false;
  const declaration = lexical.resolve(unwrapped);
  if (!declaration || !ts.isVariableDeclaration(declaration) || !isConstVariable(declaration)) return false;
  if (!declaration.initializer) return false;
  const initializer = unwrapExpression(declaration.initializer);
  return ts.isObjectLiteralExpression(initializer)
    && hasReadonlyTrue(initializer)
    && hasOnlyAcceptedReadonlyReferences(parsed, declaration, lexical, constructsDatabase);
}

function directBindingCall(
  expression: ts.Expression,
  declarations: ReadonlySet<ts.Node>,
  lexical: LexicalBindings,
): boolean {
  const unwrapped = unwrapExpression(expression);
  return ts.isIdentifier(unwrapped) && identifierResolvesTo(unwrapped, declarations, lexical);
}

export function constructsCatalogueWriter(
  source: string,
  fileName = "source.ts",
  targets?: CatalogueWriterTargets,
): boolean {
  const parsed = sourceFile(source, fileName);
  const lexical = new LexicalBindings(parsed);
  const schemaBindings = targets
    ? collectModuleBindings(parsed, fileName, targets.catalogueSchemaModule)
    : { direct: new Map<string, Set<ts.Node>>(), namespaces: new Set<ts.Node>() };
  const sqliteBindings = collectModuleBindings(parsed, fileName, "bun:sqlite");
  const openDeclarations = schemaBindings.direct.get("openCatalogue") ?? new Set<ts.Node>();
  const databaseDeclarations = sqliteBindings.direct.get("Database") ?? new Set<ts.Node>();
  const constructsDatabase: DatabaseConstructorCheck = (node) =>
    directBindingCall(node.expression, databaseDeclarations, lexical)
      || namespaceMemberResolvesTo(node.expression, sqliteBindings.namespaces, "Database", lexical)
      || directModuleMember(node.expression, fileName, "bun:sqlite", "Database");
  let writer = false;
  const visit = (node: ts.Node): void => {
    if (writer) return;
    if (ts.isCallExpression(node)) {
      const opensCatalogue = directBindingCall(node.expression, openDeclarations, lexical)
        || namespaceMemberResolvesTo(node.expression, schemaBindings.namespaces, "openCatalogue", lexical)
        || (!!targets && directModuleMember(
          node.expression,
          fileName,
          targets.catalogueSchemaModule,
          "openCatalogue",
        ));
      if (opensCatalogue) {
        writer = true;
        return;
      }
    }
    if (ts.isNewExpression(node) && constructsDatabase(node)) {
      if (!optionIsReadonly(node.arguments?.[1], parsed, lexical, constructsDatabase)) {
        writer = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return writer;
}

export function exactAllowlistDifferences(
  actual: ReadonlySet<string>,
  allowlisted: ReadonlySet<string>,
): { readonly unexpected: string[]; readonly stale: string[] } {
  return {
    unexpected: [...actual].filter((path) => !allowlisted.has(path)).sort(),
    stale: [...allowlisted].filter((path) => !actual.has(path)).sort(),
  };
}
