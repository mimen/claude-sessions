import { dirname, extname, normalize, resolve } from "node:path";
import ts from "typescript";

export interface ImportReference {
  readonly specifier: string;
  readonly names: readonly string[];
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

function callSpecifier(node: ts.CallExpression): string | null {
  const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
  const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
  if (!isDynamicImport && !isRequire) return null;
  const argument = node.arguments[0];
  return argument && ts.isStringLiteralLike(argument) ? argument.text : null;
}

function destructuredCallNames(node: ts.CallExpression): string[] {
  const parent = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
  if (!ts.isVariableDeclaration(parent) || !ts.isObjectBindingPattern(parent.name)) return [];
  return parent.name.elements.map((element) => element.propertyName && ts.isIdentifier(element.propertyName)
    ? element.propertyName.text
    : element.name.getText());
}

export function importReferences(source: string, fileName = "source.ts"): ImportReference[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
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
  visit(sourceFile);
  return references;
}

function normalizedModulePath(importer: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const path = normalize(resolve(dirname(importer), specifier));
  return extname(path) ? path : `${path}.ts`;
}

export function importsModule(source: string, importer: string, target: string): boolean {
  const normalizedTarget = normalize(resolve(target));
  return importReferences(source, importer).some((reference) =>
    normalizedModulePath(importer, reference.specifier) === normalizedTarget
  );
}

export function importsNamedBindingFromModule(
  source: string,
  importer: string,
  target: string,
  protectedNames: ReadonlySet<string>,
): boolean {
  const normalizedTarget = normalize(resolve(target));
  return importReferences(source, importer).some((reference) =>
    normalizedModulePath(importer, reference.specifier) === normalizedTarget
      && reference.names.some((name) => name === "*" || protectedNames.has(name))
  );
}

function templateText(node: ts.TemplateExpression): string {
  return `${node.head.text}${node.templateSpans.map((span) => ` ${span.literal.text}`).join("")}`;
}

const PROTECTED_MUTATION_SQL = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["`[]?(?:catalogue|session_tags|identities|identity_[a-z_]+|historical_detached_child_backfills)\b/i;

export function protectedMutationSql(source: string, fileName = "source.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: string[] = [];
  const visit = (node: ts.Node): void => {
    let text: string | null = null;
    if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) text = node.text;
    else if (ts.isTemplateExpression(node)) text = templateText(node);
    if (text && PROTECTED_MUTATION_SQL.test(text)) matches.push(text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

export function constructsCatalogueWriter(source: string, fileName = "source.ts"): boolean {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let writer = false;
  const visit = (node: ts.Node): void => {
    if (writer) return;
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "openCatalogue") {
      writer = true;
      return;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Database") {
      const options = node.arguments?.[1];
      const readonly = options && ts.isObjectLiteralExpression(options)
        ? options.properties.some((property) =>
            ts.isPropertyAssignment(property)
              && ((ts.isIdentifier(property.name) && property.name.text === "readonly")
                || (ts.isStringLiteralLike(property.name) && property.name.text === "readonly"))
              && property.initializer.kind === ts.SyntaxKind.TrueKeyword
          )
        : false;
      if (!readonly) {
        writer = true;
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
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
