import { dirname, extname, normalize, resolve } from "node:path";
import ts from "typescript";

export interface ImportReference {
  readonly specifier: string;
  readonly names: readonly string[];
}

export interface CatalogueWriterTargets {
  readonly catalogueSchemaModule: string;
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
  readonly direct: Map<string, Set<string>>;
  readonly namespaces: Set<string>;
}

function addDirectBinding(bindings: ModuleBindings, exportedName: string, localName: string): void {
  const locals = bindings.direct.get(exportedName) ?? new Set<string>();
  locals.add(localName);
  bindings.direct.set(exportedName, locals);
}

function collectModuleBindings(parsed: ts.SourceFile, importer: string, target: string): ModuleBindings {
  const bindings: ModuleBindings = { direct: new Map(), namespaces: new Set() };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      if (moduleMatches(importer, node.moduleSpecifier.text, target)) {
        const clause = node.importClause;
        if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
          for (const element of clause.namedBindings.elements) {
            addDirectBinding(bindings, element.propertyName?.text ?? element.name.text, element.name.text);
          }
        } else if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
          bindings.namespaces.add(clause.namedBindings.name.text);
        }
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      const call = moduleCall(node.initializer);
      const specifier = call ? callSpecifier(call) : null;
      if (specifier && moduleMatches(importer, specifier, target)) {
        if (ts.isIdentifier(node.name)) {
          bindings.namespaces.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            const exportedName = element.propertyName?.getText(parsed) ?? element.name.getText(parsed);
            const localName = element.name.getText(parsed);
            addDirectBinding(bindings, exportedName, localName);
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

function usesNamespaceMember(parsed: ts.SourceFile, namespaces: ReadonlySet<string>, names: ReadonlySet<string>): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node))
      && ts.isIdentifier(node.expression)
      && namespaces.has(node.expression.text)) {
      const name = memberName(node);
      if (name && names.has(name)) {
        found = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return found;
}

export function importsNamedBindingFromModule(
  source: string,
  importer: string,
  target: string,
  protectedNames: ReadonlySet<string>,
): boolean {
  const parsed = sourceFile(source, importer);
  const bindings = collectModuleBindings(parsed, importer, target);
  for (const name of protectedNames) {
    if ((bindings.direct.get(name)?.size ?? 0) > 0) return true;
  }
  return usesNamespaceMember(parsed, bindings.namespaces, protectedNames);
}

function templateText(node: ts.TemplateExpression, parsed: ts.SourceFile): string {
  return `${node.head.text}${node.templateSpans.map((span) =>
    `\${${span.expression.getText(parsed)}}${span.literal.text}`
  ).join("")}`;
}

const CATALOGUE_TABLE = "(?:catalogue|dispositions|epics|groupings|historical_detached_child_backfills|identities|identity_[a-z_]+|inboxes|roles|schema_migrations|session_tags)";
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
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = templateText(node, parsed);
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

function readonlyOptionBindings(parsed: ts.SourceFile): Set<string> {
  const bindings = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isVariableDeclarationList(node.parent)
      && (node.parent.flags & ts.NodeFlags.Const) !== 0
      && ts.isIdentifier(node.name)
      && node.initializer) {
      const initializer = unwrapExpression(node.initializer);
      if (ts.isObjectLiteralExpression(initializer) && hasReadonlyTrue(initializer)) {
        bindings.add(node.name.text);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(parsed);
  const invalidateMutations = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      if ((ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
        && ts.isIdentifier(node.left.expression)) {
        bindings.delete(node.left.expression.text);
      }
    }
    ts.forEachChild(node, invalidateMutations);
  };
  invalidateMutations(parsed);
  return bindings;
}

function isBoundIdentifier(node: ts.Expression, names: ReadonlySet<string>): boolean {
  return ts.isIdentifier(node) && names.has(node.text);
}

function isBoundNamespaceMember(
  node: ts.Expression,
  namespaces: ReadonlySet<string>,
  exportedName: string,
): boolean {
  if (!ts.isPropertyAccessExpression(node) && !ts.isElementAccessExpression(node)) return false;
  return ts.isIdentifier(node.expression)
    && namespaces.has(node.expression.text)
    && memberName(node) === exportedName;
}

function optionIsReadonly(option: ts.Expression | undefined, readonlyBindings: ReadonlySet<string>): boolean {
  if (!option) return false;
  const unwrapped = unwrapExpression(option);
  if (ts.isObjectLiteralExpression(unwrapped)) return hasReadonlyTrue(unwrapped);
  return ts.isIdentifier(unwrapped) && readonlyBindings.has(unwrapped.text);
}

export function constructsCatalogueWriter(
  source: string,
  fileName = "source.ts",
  targets?: CatalogueWriterTargets,
): boolean {
  const parsed = sourceFile(source, fileName);
  const schemaBindings = targets
    ? collectModuleBindings(parsed, fileName, targets.catalogueSchemaModule)
    : { direct: new Map<string, Set<string>>(), namespaces: new Set<string>() };
  const sqliteBindings = collectModuleBindings(parsed, fileName, "bun:sqlite");
  const openNames = new Set(schemaBindings.direct.get("openCatalogue") ?? []);
  const databaseNames = new Set(sqliteBindings.direct.get("Database") ?? []);
  if (!targets) openNames.add("openCatalogue");
  if (databaseNames.size === 0 && sqliteBindings.namespaces.size === 0) databaseNames.add("Database");
  const readonlyBindings = readonlyOptionBindings(parsed);
  let writer = false;
  const visit = (node: ts.Node): void => {
    if (writer) return;
    if (ts.isCallExpression(node)) {
      const expression = unwrapExpression(node.expression);
      if (isBoundIdentifier(expression, openNames)
        || isBoundNamespaceMember(expression, schemaBindings.namespaces, "openCatalogue")) {
        writer = true;
        return;
      }
    }
    if (ts.isNewExpression(node)) {
      const expression = unwrapExpression(node.expression);
      const constructsDatabase = isBoundIdentifier(expression, databaseNames)
        || isBoundNamespaceMember(expression, sqliteBindings.namespaces, "Database");
      if (constructsDatabase && !optionIsReadonly(node.arguments?.[1], readonlyBindings)) {
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
