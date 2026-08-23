import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const SURFACE_NAMESPACES = {
  "src/ui/today-pane.ts": ["today.", "acceptance."],
  "src/ui/map-pane.ts": ["map."],
  "src/ui/suggestions-tab.ts": ["suggestions."],
  "src/ui/history-tab.ts": ["history.", "acceptance.", "settings.status."],
  "src/ui/ai-suggestion.ts": ["ai."],
  "src/ui/quick-capture-modal.ts": ["quickCapture."],
  "src/ui/change-preview-modal.ts": ["changePreview.", "acceptance."],
  "src/ui/ai-payload-preview-modal.ts": ["ai."],
  "src/ui/catalog-scan-confirmation-modal.ts": ["catalog.confirm."],
  "src/ui/catalog-txt-import-confirmation-modal.ts": ["catalog.confirm."],
  "src/ui/catalog-large-scan-confirmation-modal.ts": ["verification.confirm."],
  "src/ui/cloud-directory-picker.ts": ["directoryPicker."],
  "src/ui/catalog-progress-presenter.ts": ["progress.", "settings.status."],
  "src/ui/start-page.ts": ["start.", "today.", "map.", "catalog."],
  "src/ui/workbench-view.ts": ["progress.", "status.", "host.", "acceptance.", "ai."],
  "src/ui/settings-sections.ts": ["settings.", "directoryPicker.", "verification.", "progress.", "language."],
  "src/plugin/knowledge-workbench-plugin.ts": ["host."],
  "src/main.ts": [],
  "src/main-acceptance.ts": ["acceptance."],
  "src/runtime/runtime-composition.ts": [],
} as const;

type SurfaceFile = keyof typeof SURFACE_NAMESPACES;

const DISPLAY_PROPERTIES = new Set(["textContent", "placeholder", "title"]);
const REQUIRED_NAMESPACES = [
  "today.", "map.", "suggestions.", "history.", "quickCapture.", "changePreview.",
  "ai.", "catalog.confirm.", "verification.confirm.", "progress.", "acceptance.", "host.",
] as const;
const PUNCTUATION_ONLY = /^[\p{P}\p{S}\s]*$/u;
const TECHNICAL_PATH = /^\/(?:[\p{L}\p{N}._-]+(?:\/[\p{L}\p{N}._-]+)*)?$/u;
const TECHNICAL_FIELD_PREFIX = /^knowledge-workbench-[a-z-]+:\s*$/u;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly sink: string;
  readonly reason: string;
}

interface DictionaryShape {
  readonly keys: ReadonlySet<string>;
  readonly findings: readonly string[];
}

const propertyName = (node: ts.Node): string | undefined => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression !== undefined
    && ts.isStringLiteral(node.argumentExpression)) return node.argumentExpression.text;
  return undefined;
};
const declarationName = (node: ts.PropertyName): string | undefined => (
  ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)
    ? node.text
    : undefined
);
const unwrap = (node: ts.Expression): ts.Expression => {
  let current = node;
  while (ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)) current = current.expression;
  return current;
};

const objectLiteralFor = (initializer: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined => {
  if (initializer === undefined) return undefined;
  const value = unwrap(initializer);
  if (ts.isCallExpression(value)
    && ts.isPropertyAccessExpression(value.expression)
    && ts.isIdentifier(value.expression.expression)
    && value.expression.expression.text === "Object"
    && value.expression.name.text === "freeze") {
    return value.arguments[0] === undefined ? undefined : objectLiteralFor(value.arguments[0]);
  }
  return ts.isObjectLiteralExpression(value) ? value : undefined;
};

const dictionaryShape = (source: string): DictionaryShape => {
  const ast = ts.createSourceFile("workbench-i18n.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const objects = new Map<string, ts.ObjectLiteralExpression>();
  const findings: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const object = objectLiteralFor(node.initializer);
      if (object !== undefined) objects.set(node.name.text, object);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const read = (name: "en" | "zhCN"): Map<string, string> => {
    const output = new Map<string, string>();
    const object = objects.get(name);
    if (object === undefined) {
      findings.push(`missing-dictionary:${name}`);
      return output;
    }
    for (const property of object.properties) {
      if (!ts.isPropertyAssignment(property)) continue;
      const key = declarationName(property.name);
      const value = unwrap(property.initializer);
      if (key === undefined || !ts.isStringLiteralLike(value)) continue;
      output.set(key, value.text);
      if (value.text.trim().length === 0) findings.push(`empty-value:${name}:${key}`);
    }
    return output;
  };
  const en = read("en");
  const zh = read("zhCN");
  for (const key of en.keys()) if (!zh.has(key)) findings.push(`missing-key:zhCN:${key}`);
  for (const key of zh.keys()) if (!en.has(key)) findings.push(`missing-key:en:${key}`);
  const placeholders = (value: string): readonly string[] => (
    [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/gu)]
      .map((match) => match[1]!)
      .sort()
  );
  for (const [key, value] of en) {
    const translated = zh.get(key);
    if (translated !== undefined
      && JSON.stringify(placeholders(value)) !== JSON.stringify(placeholders(translated))) {
      findings.push(`placeholder-mismatch:${key}`);
    }
  }
  for (const namespace of REQUIRED_NAMESPACES) {
    if (![...en.keys()].some((key) => key.startsWith(namespace))) {
      findings.push(`missing-namespace:en:${namespace}`);
    }
    if (![...zh.keys()].some((key) => key.startsWith(namespace))) {
      findings.push(`missing-namespace:zhCN:${namespace}`);
    }
  }
  return { keys: new Set(en.keys()), findings };
};

const I18N_SOURCE = readFileSync(resolve(ROOT, "src/i18n/workbench-i18n.ts"), "utf8");
const DICTIONARY = dictionaryShape(I18N_SOURCE);

const findingsForSource = (
  file: SurfaceFile,
  source: string,
  dictionary: DictionaryShape = DICTIONARY,
): readonly Finding[] => {
  const fileName = resolve(ROOT, file);
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    target: ts.ScriptTarget.ESNext,
  };
  const host = ts.createCompilerHost(compilerOptions);
  const readSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) => (
    resolve(requested) === fileName
      ? ts.createSourceFile(requested, source, languageVersion, true, ts.ScriptKind.TS)
      : readSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile)
  );
  const program = ts.createProgram([fileName], compilerOptions, host);
  const ast = program.getSourceFile(fileName);
  if (ast === undefined) throw new Error(`localization-boundary-source-unavailable:${file}`);
  const checker = program.getTypeChecker();
  const findings: Finding[] = [];

  interface BoundValue {
    readonly expression: ts.Expression;
    readonly environment: Environment;
  }
  type Environment = ReadonlyMap<ts.Symbol, BoundValue>;
  const EMPTY_ENVIRONMENT: Environment = new Map();

  const record = (node: ts.Node, sink: string, reason: string): void => {
    const { line } = ast.getLineAndCharacterOfPosition(node.getStart(ast));
    findings.push({ file, line: line + 1, sink, reason });
  };

  const symbolAt = (node: ts.Node): ts.Symbol | undefined => checker.getSymbolAtLocation(node)
    ?? (ts.isIdentifier(node)
      ? checker.resolveName(
        node.text,
        node,
        ts.SymbolFlags.Value | ts.SymbolFlags.Alias,
        false,
      )
      : undefined);
  const declarationOf = (symbol: ts.Symbol | undefined): ts.Declaration | undefined => (
    symbol?.valueDeclaration ?? symbol?.declarations?.[0]
  );
  const declarationsByName = new Map<string, ts.Declaration[]>();
  const collectDeclarations = (node: ts.Node): void => {
    if ((ts.isVariableDeclaration(node)
      || ts.isParameter(node)
      || ts.isBindingElement(node)
      || ts.isPropertyDeclaration(node))
      && ts.isIdentifier(node.name)) {
      const declarations = declarationsByName.get(node.name.text) ?? [];
      declarations.push(node);
      declarationsByName.set(node.name.text, declarations);
    }
    ts.forEachChild(node, collectDeclarations);
  };
  collectDeclarations(ast);
  const lexicalScope = (node: ts.Node): ts.Node => {
    let current: ts.Node | undefined = node.parent;
    while (current !== undefined
      && !ts.isBlock(current)
      && !ts.isSourceFile(current)
      && !ts.isClassLike(current)
      && !ts.isForOfStatement(current)
      && !ts.isFunctionLike(current)) current = current.parent;
    return current ?? ast;
  };
  const isAncestor = (ancestor: ts.Node, node: ts.Node): boolean => {
    let current: ts.Node | undefined = node;
    while (current !== undefined) {
      if (current === ancestor) return true;
      current = current.parent;
    }
    return false;
  };
  const lexicalDeclaration = (node: ts.Identifier): ts.Declaration | undefined => (
    (declarationsByName.get(node.text) ?? [])
      .filter((declaration) => declaration.getStart(ast) <= node.getStart(ast)
        && isAncestor(lexicalScope(declaration), node))
      .sort((left, right) => right.getStart(ast) - left.getStart(ast))[0]
  );
  const declarationAt = (node: ts.Node | undefined): ts.Declaration | undefined => {
    if (node === undefined) return undefined;
    const memberName = (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
      || (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node);
    const lexical = ts.isIdentifier(node) ? lexicalDeclaration(node) : undefined;
    return memberName
      ? declarationOf(symbolAt(node)) ?? lexical
      : lexical ?? declarationOf(symbolAt(node));
  };
  const initializerOf = (declaration: ts.Declaration | undefined): ts.Expression | undefined => {
    if (declaration === undefined) return undefined;
    if (ts.isVariableDeclaration(declaration)
      || ts.isPropertyDeclaration(declaration)
      || ts.isPropertyAssignment(declaration)
      || ts.isParameter(declaration)
      || ts.isBindingElement(declaration)) return declaration.initializer;
    return undefined;
  };
  const functionFor = (call: ts.CallExpression): ts.FunctionLikeDeclaration | undefined => {
    const target = ts.isPropertyAccessExpression(call.expression)
      ? call.expression.name
      : call.expression;
    const symbol = symbolAt(target);
    const declaration = declarationOf(symbol) ?? (ts.isIdentifier(target) ? lexicalDeclaration(target) : undefined);
    if (declaration === undefined || declaration.getSourceFile() !== ast) return undefined;
    if (ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) return declaration;
    if (ts.isVariableDeclaration(declaration)
      && declaration.initializer !== undefined
      && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
      return declaration.initializer;
    }
    return undefined;
  };
  const bindFunction = (
    declaration: ts.FunctionLikeDeclaration,
    call: ts.CallExpression,
    outer: Environment,
  ): Environment => {
    const environment = new Map(outer);
    declaration.parameters.forEach((parameter, index) => {
      if (!ts.isIdentifier(parameter.name)) return;
      const symbol = symbolAt(parameter.name);
      const argument = call.arguments[index] ?? parameter.initializer;
      if (symbol !== undefined && argument !== undefined) {
        environment.set(symbol, { expression: argument, environment: outer });
      }
    });
    return environment;
  };
  const enclosingForOfSource = (declaration: ts.Declaration): ts.Expression | undefined => {
    let current: ts.Node | undefined = declaration;
    while (current !== undefined && !ts.isForOfStatement(current)) current = current.parent;
    return current?.expression;
  };
  const bindingElementSource = (declaration: ts.BindingElement): ts.Expression | undefined => {
    let current: ts.Node = declaration;
    while (!ts.isVariableDeclaration(current) && !ts.isParameter(current)) {
      if (current.parent === undefined) return undefined;
      current = current.parent;
    }
    return initializerOf(current) ?? enclosingForOfSource(current);
  };
  const literalText = (
    input: ts.Expression,
    environment: Environment,
    seen = new Set<ts.Symbol>(),
  ): string | undefined => {
    const expression = unwrap(input);
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (!ts.isIdentifier(expression)) return undefined;
    const symbol = symbolAt(expression);
    if (symbol === undefined || seen.has(symbol)) return undefined;
    const bound = environment.get(symbol);
    if (bound !== undefined) {
      return literalText(bound.expression, bound.environment, new Set([...seen, symbol]));
    }
    const initializer = initializerOf(lexicalDeclaration(expression) ?? declarationOf(symbol));
    return initializer === undefined
      ? undefined
      : literalText(initializer, environment, new Set([...seen, symbol]));
  };
  const resolvedObjectLiteral = (
    input: ts.Expression,
    environment: Environment,
    seen = new Set<ts.Symbol>(),
  ): ts.ObjectLiteralExpression | undefined => {
    const expression = unwrap(input);
    const direct = objectLiteralFor(expression);
    if (direct !== undefined) return direct;
    if (!ts.isIdentifier(expression)) return undefined;
    const symbol = symbolAt(expression);
    if (symbol === undefined || seen.has(symbol)) return undefined;
    const bound = environment.get(symbol);
    if (bound !== undefined) {
      return resolvedObjectLiteral(bound.expression, bound.environment, new Set([...seen, symbol]));
    }
    const initializer = initializerOf(lexicalDeclaration(expression) ?? declarationOf(symbol));
    return initializer === undefined
      ? undefined
      : resolvedObjectLiteral(initializer, environment, new Set([...seen, symbol]));
  };
  const staticMemberValues = (
    input: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    environment: Environment,
  ): readonly ts.Expression[] => {
    const object = resolvedObjectLiteral(input.expression, environment);
    if (object === undefined) return [];
    const requested = ts.isPropertyAccessExpression(input)
      ? input.name.text
      : input.argumentExpression === undefined
        ? undefined
        : literalText(input.argumentExpression, environment);
    const properties = object.properties.filter(ts.isPropertyAssignment);
    if (requested === undefined) return properties.map((property) => property.initializer);
    const matching = properties.find((property) => declarationName(property.name) === requested);
    return matching === undefined ? [] : [matching.initializer];
  };

  const isExternallyAssignedProperty = (
    input: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    environment: Environment,
    seen: Set<ts.Symbol>,
  ): boolean => {
    const member = ts.isPropertyAccessExpression(input) ? input.name : input.argumentExpression;
    const symbol = member === undefined ? undefined : symbolAt(member);
    const declaration = declarationAt(member);
    if (declaration === undefined || !ts.isPropertyDeclaration(declaration)) return false;
    let external = false;
    const visit = (node: ts.Node): void => {
      if (external) return;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))) {
        const assignedMember = ts.isPropertyAccessExpression(node.left) ? node.left.name : node.left.argumentExpression;
        if (assignedMember !== undefined
          && (symbolAt(assignedMember) === symbol || declarationAt(assignedMember) === declaration)
          && isExternalExpression(node.right, environment, seen)) external = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    return external;
  };

  const isExternalExpression = (
    input: ts.Expression,
    environment: Environment,
    seen = new Set<ts.Symbol>(),
  ): boolean => {
    const expression = unwrap(input);
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression);
      if (symbol !== undefined && seen.has(symbol)) return false;
      const bound = symbol === undefined ? undefined : environment.get(symbol);
      const nextSeen = symbol === undefined ? seen : new Set([...seen, symbol]);
      if (bound !== undefined) {
        return isExternalExpression(bound.expression, bound.environment, nextSeen);
      }
      const declaration = lexicalDeclaration(expression) ?? declarationOf(symbol);
      if (declaration === undefined) return false;
      if (ts.isParameter(declaration)) return true;
      if (ts.isBindingElement(declaration)) {
        const sourceExpression = bindingElementSource(declaration);
        return sourceExpression !== undefined
          && isExternalExpression(sourceExpression, environment, nextSeen);
      }
      const initializer = initializerOf(declaration);
      if (initializer !== undefined) {
        return isExternalExpression(initializer, environment, nextSeen);
      }
      const forOfSource = enclosingForOfSource(declaration);
      if (forOfSource !== undefined
        && /(?:^|[|&])\s*[A-Z][A-Za-z0-9_]*/u.test(checker.typeToString(checker.getTypeAtLocation(expression)))) {
        return true;
      }
      return forOfSource !== undefined
        && isExternalExpression(forOfSource, environment, nextSeen);
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const values = staticMemberValues(expression, environment);
      if (values.length > 0) return values.every((value) => isExternalExpression(value, environment, seen));
      if (isExternallyAssignedProperty(expression, environment, seen)) return true;
      const member = ts.isPropertyAccessExpression(expression)
        ? expression.name
        : expression.argumentExpression;
      const declaration = declarationAt(member);
      if (declaration !== undefined && ts.isParameter(declaration)) return true;
      return isExternalExpression(expression.expression, environment, seen);
    }
    if (ts.isCallExpression(expression)) {
      const local = functionFor(expression);
      if (expression.arguments.length > 0
        && expression.arguments.every((argument) => (
          ts.isExpression(argument) && isExternalExpression(argument, environment, seen)
        ))) return true;
      if (local !== undefined) return false;
      if (ts.isPropertyAccessExpression(expression.expression)) {
        return isExternalExpression(expression.expression.expression, environment, seen);
      }
      const symbol = symbolAt(expression.expression);
      const declaration = symbol === undefined ? undefined : declarationOf(symbol.flags & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(symbol)
        : symbol);
      if (declaration !== undefined) {
        const relative = declaration.getSourceFile().fileName.replace(`${ROOT}/`, "");
        return Object.prototype.hasOwnProperty.call(SURFACE_NAMESPACES, relative);
      }
      return false;
    }
    if (ts.isConditionalExpression(expression)) {
      return isExternalExpression(expression.whenTrue, environment, seen)
        && isExternalExpression(expression.whenFalse, environment, seen);
    }
    if (ts.isBinaryExpression(expression)
      && (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
      return isExternalExpression(expression.left, environment, seen)
        || isExternalExpression(expression.right, environment, seen);
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const values = expression.properties.flatMap((property) => {
        if (ts.isPropertyAssignment(property)) return [property.initializer];
        if (ts.isShorthandPropertyAssignment(property)) return [property.name];
        if (ts.isSpreadAssignment(property)) return [property.expression];
        return [];
      });
      return values.length > 0 && values.every((value) => isExternalExpression(value, environment, seen));
    }
    if (ts.isArrayLiteralExpression(expression)) {
      return expression.elements.length === 0
        || expression.elements.every((element) => (
          ts.isSpreadElement(element)
            ? isExternalExpression(element.expression, environment, seen)
            : ts.isExpression(element) && isExternalExpression(element, environment, seen)
        ));
    }
    return false;
  };

  const stringLiteralsFromType = (type: ts.Type): readonly string[] => {
    if (type.isStringLiteral()) return [type.value];
    if (type.isUnion()) return type.types.flatMap(stringLiteralsFromType);
    return [];
  };
  const possibleI18nKeys = (
    input: ts.Expression,
    environment: Environment,
    seen = new Set<ts.Symbol>(),
  ): readonly string[] => {
    const inputTypeKeys = stringLiteralsFromType(checker.getTypeAtLocation(input));
    const expression = unwrap(input);
    if (ts.isStringLiteralLike(expression)) return [expression.text];
    if (ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
    if (ts.isConditionalExpression(expression)) {
      return [
        ...possibleI18nKeys(expression.whenTrue, environment, seen),
        ...possibleI18nKeys(expression.whenFalse, environment, seen),
      ];
    }
    if (ts.isBinaryExpression(expression)
      && expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...possibleI18nKeys(expression.left, environment, seen),
        ...possibleI18nKeys(expression.right, environment, seen),
      ];
    }
    if (ts.isIdentifier(expression)) {
      const symbol = symbolAt(expression);
      if (symbol === undefined || seen.has(symbol)) return [];
      const bound = environment.get(symbol);
      if (bound !== undefined) {
        return possibleI18nKeys(bound.expression, bound.environment, new Set([...seen, symbol]));
      }
      const initializer = initializerOf(lexicalDeclaration(expression) ?? declarationOf(symbol));
      return initializer === undefined
        ? inputTypeKeys
        : possibleI18nKeys(initializer, environment, new Set([...seen, symbol]));
    }
    if (ts.isElementAccessExpression(expression) || ts.isPropertyAccessExpression(expression)) {
      const values = staticMemberValues(expression, environment);
      return values.length > 0
        ? values.flatMap((value) => possibleI18nKeys(value, environment, seen))
        : inputTypeKeys;
    }
    if (ts.isTemplateExpression(expression)) {
      let prefixes: readonly string[] = [expression.head.text];
      for (const span of expression.templateSpans) {
        const values = possibleI18nKeys(span.expression, environment, seen);
        if (values.length === 0) return [];
        prefixes = prefixes.flatMap((prefix) => values.map((value) => `${prefix}${value}${span.literal.text}`));
      }
      return prefixes;
    }
    return inputTypeKeys;
  };
  const checkI18nCall = (
    node: ts.CallExpression,
    sink: string,
    environment: Environment,
    checkExpression: (
      input: ts.Expression | undefined,
      node: ts.Node,
      sink: string,
      environment: Environment,
      seen?: ReadonlySet<ts.Symbol>,
    ) => void,
  ): void => {
    const keys = node.arguments[0] === undefined ? [] : possibleI18nKeys(node.arguments[0], environment);
    if (keys.length === 0) {
      record(node, sink, "i18n-key-not-statically-known");
      return;
    }
    for (const key of keys) {
      const prefix = key.endsWith("*") ? key.slice(0, -1) : key;
      if (!(SURFACE_NAMESPACES[file] as readonly string[]).some((namespace) => prefix.startsWith(namespace))) {
        record(node, sink, `wrong-namespace:${key}`);
      }
      const exists = key.endsWith("*")
        ? [...dictionary.keys].some((candidate) => candidate.startsWith(prefix))
        : dictionary.keys.has(key);
      if (!exists) record(node, sink, `missing-i18n-key:${key}`);
    }
    const values = node.arguments[1];
    if (values === undefined) return;
    const object = resolvedObjectLiteral(values, environment);
    if (object === undefined) {
      record(values, sink, "i18n-values-not-statically-known");
      return;
    }
    for (const property of object.properties) {
      if (ts.isPropertyAssignment(property)) {
        checkExpression(property.initializer, property, `${sink}:i18n-value`, environment);
      } else if (ts.isShorthandPropertyAssignment(property)) {
        checkExpression(property.name, property, `${sink}:i18n-value`, environment);
      } else if (ts.isSpreadAssignment(property)) {
        record(property, sink, "i18n-values-spread-unverified");
      }
    }
  };

  const WORKBENCH_I18N_DECLARATION = resolve(ROOT, "src/i18n/workbench-i18n.ts");
  const TYPESCRIPT_LIB_DIRECTORY = resolve(ROOT, "node_modules/typescript/lib");
  const OBSIDIAN_DECLARATION = resolve(ROOT, "node_modules/obsidian/obsidian.d.ts");
  const resolvedDeclaration = (call: ts.CallExpression | ts.NewExpression): ts.SignatureDeclaration | undefined => (
    checker.getResolvedSignature(call)?.getDeclaration()
  );
  const declarationPath = (declaration: ts.Declaration | undefined): string | undefined => (
    declaration === undefined ? undefined : resolve(declaration.getSourceFile().fileName)
  );
  const isTypescriptLibDeclaration = (declaration: ts.Declaration | undefined): boolean => {
    const path = declarationPath(declaration);
    return path !== undefined
      && path.startsWith(`${TYPESCRIPT_LIB_DIRECTORY}/lib.`)
      && path.endsWith(".d.ts");
  };
  const STANDARD_ERROR_TYPES = new Set([
    "Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError",
  ]);
  const isStandardErrorDeclaration = (declaration: ts.Declaration): boolean => (
    isTypescriptLibDeclaration(declaration)
      && (ts.isInterfaceDeclaration(declaration) || ts.isClassDeclaration(declaration))
      && declaration.name !== undefined
      && STANDARD_ERROR_TYPES.has(declaration.name.text)
  );
  const isStandardErrorType = (type: ts.Type): boolean => {
    if (type.isUnionOrIntersection()) return type.types.some(isStandardErrorType);
    const symbols = [type.aliasSymbol, type.getSymbol()].filter(
      (symbol): symbol is ts.Symbol => symbol !== undefined,
    );
    return symbols.some((symbol) => symbol.declarations?.some(isStandardErrorDeclaration) === true);
  };
  const isStandardPromiseCatchCall = (call: ts.CallExpression): boolean => {
    if (!ts.isPropertyAccessExpression(call.expression) || call.expression.name.text !== "catch") return false;
    const declaration = resolvedDeclaration(call);
    return declaration !== undefined
      && isTypescriptLibDeclaration(declaration)
      && (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration))
      && ts.isInterfaceDeclaration(declaration.parent)
      && declaration.parent.name.text === "Promise";
  };
  const isPromiseCatchParameter = (input: ts.Expression): boolean => {
    const expression = unwrap(input);
    if (!ts.isIdentifier(expression)) return false;
    const declaration = lexicalDeclaration(expression) ?? declarationAt(expression);
    if (declaration === undefined || !ts.isParameter(declaration)
      || declaration.parent.parameters[0] !== declaration) return false;
    let callback: ts.Node = declaration.parent;
    while (callback.parent !== undefined && (ts.isParenthesizedExpression(callback.parent)
      || ts.isAsExpression(callback.parent)
      || ts.isSatisfiesExpression(callback.parent)
      || ts.isNonNullExpression(callback.parent))) callback = callback.parent;
    return callback.parent !== undefined
      && ts.isCallExpression(callback.parent)
      && callback.parent.arguments.some((argument) => isAncestor(argument, callback))
      && isStandardPromiseCatchCall(callback.parent);
  };
  const isRawStandardErrorValue = (input: ts.Expression): boolean => (
    isStandardErrorType(checker.getTypeAtLocation(unwrap(input))) || isPromiseCatchParameter(input)
  );
  const isStandardErrorMember = (
    input: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  ): boolean => {
    const name = propertyName(input);
    if (name !== "message" && name !== "stack") return false;
    const member = ts.isPropertyAccessExpression(input) ? input.name : input.argumentExpression;
    const declaration = declarationAt(member);
    return declaration !== undefined
      && isTypescriptLibDeclaration(declaration)
      && ts.isInterfaceDeclaration(declaration.parent)
      && declaration.parent.name.text === "Error";
  };
  const isRawErrorDisplayExpression = (input: ts.Expression): boolean => {
    const expression = unwrap(input);
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      return isStandardErrorMember(expression)
        || ((propertyName(expression) === "message" || propertyName(expression) === "stack")
          && isRawStandardErrorValue(expression.expression));
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)
      && expression.expression.text === "String"
      && isTypescriptLibDeclaration(resolvedDeclaration(expression))) {
      return expression.arguments.some((argument) => (
        ts.isExpression(argument) && isRawStandardErrorValue(argument)
      ));
    }
    return isRawStandardErrorValue(expression);
  };
  const isWorkbenchI18nCall = (call: ts.CallExpression): boolean => {
    if (!ts.isPropertyAccessExpression(call.expression)) return false;
    const declaration = resolvedDeclaration(call);
    return declaration !== undefined
      && declarationPath(declaration) === WORKBENCH_I18N_DECLARATION
      && (ts.isMethodSignature(declaration) || ts.isMethodDeclaration(declaration))
      && declarationName(declaration.name) === call.expression.name.text
      && ts.isInterfaceDeclaration(declaration.parent)
      && declaration.parent.name.text === "WorkbenchI18n";
  };

  const enclosingCallArgument = (node: ts.Node): { readonly call: ts.CallExpression; readonly index: number } | undefined => {
    let current = node;
    while (current.parent !== undefined) {
      if (ts.isCallExpression(current.parent)) {
        const index = current.parent.arguments.findIndex((argument) => isAncestor(argument, node));
        return index < 0 ? undefined : { call: current.parent, index };
      }
      if (!ts.isParenthesizedExpression(current.parent)
        && !ts.isAsExpression(current.parent)
        && !ts.isSatisfiesExpression(current.parent)
        && !ts.isNonNullExpression(current.parent)
        && !ts.isConditionalExpression(current.parent)) return undefined;
      current = current.parent;
    }
    return undefined;
  };

  const isMessageKeyContext = (node: ts.Expression): boolean => {
    const argument = enclosingCallArgument(node);
    if (argument !== undefined && argument.index === 0
      && ts.isPropertyAccessExpression(argument.call.expression)
      && argument.call.expression.name.text === "t"
      && isWorkbenchI18nCall(argument.call)) return true;
    const contextual = checker.getContextualType(node);
    if (contextual === undefined) return false;
    const keys = stringLiteralsFromType(contextual);
    return keys.length > 0 && keys.every((key) => dictionary.keys.has(key));
  };

  const assignmentProperty = (node: ts.Node): string | undefined => {
    let current = node;
    while (current.parent !== undefined && (ts.isParenthesizedExpression(current.parent)
      || ts.isAsExpression(current.parent)
      || ts.isSatisfiesExpression(current.parent)
      || ts.isNonNullExpression(current.parent)
      || ts.isConditionalExpression(current.parent))) current = current.parent;
    return ts.isBinaryExpression(current.parent)
      && current.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && current.parent.right === current
      ? propertyName(current.parent.left)
      : undefined;
  };

  const propertyInitializerName = (node: ts.Node): string | undefined => {
    let current = node;
    while (current.parent !== undefined && (ts.isParenthesizedExpression(current.parent)
      || ts.isAsExpression(current.parent)
      || ts.isSatisfiesExpression(current.parent)
      || ts.isNonNullExpression(current.parent)
      || ts.isConditionalExpression(current.parent))) current = current.parent;
    return ts.isPropertyAssignment(current.parent) && current.parent.initializer === current
      ? declarationName(current.parent.name)
      : undefined;
  };

  const TECHNICAL_ASSIGNMENT_PROPERTIES = new Set([
    "autocomplete", "className", "inputMode", "rel", "target", "type",
  ]);
  const TECHNICAL_OBJECT_PROPERTIES = new Set([
    "action", "comparison", "direction", "filter", "icon", "id", "kind", "locale",
    "method", "mode", "phase", "reason", "role", "source", "status", "type", "viewType",
  ]);
  const TECHNICAL_CALL_ARGUMENTS: Readonly<Record<string, readonly number[] | "all">> = {
    addEventListener: [0],
    closest: [0],
    createElement: [0],
    endsWith: [0],
    getAttribute: [0],
    hasAttribute: [0],
    includes: [0],
    insertAdjacentElement: [0],
    matches: [0],
    normalize: [0],
    querySelector: [0],
    querySelectorAll: [0],
    removeAttribute: [0],
    removeEventListener: [0],
    split: [0],
    startsWith: [0],
    toLocaleLowerCase: [0],
  };
  const TECHNICAL_CODE = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u;
  const TECHNICAL_FRAGMENT = /^[a-z][a-z0-9_.-]*$/u;
  const TECHNICAL_CSS_CLASS = /^knowledge-workbench(?:(?:__|--)[a-z0-9-]+)+(?:\s+knowledge-workbench(?:(?:__|--)[a-z0-9-]+)+)*$/u;
  const TECHNICAL_FILENAME_FRAGMENT = /^(?:knowledge-workbench-history-|knowledge-workbench-directory-|\.json)$/u;
  const isStandardLibraryCall = (call: ts.CallExpression): boolean => (
    isTypescriptLibDeclaration(resolvedDeclaration(call))
  );
  const isTrustedTechnicalApiCall = (call: ts.CallExpression): boolean => (
    isStandardLibraryCall(call) || declarationPath(resolvedDeclaration(call)) === OBSIDIAN_DECLARATION
  );
  const isTechnicalComparison = (node: ts.Node, text: string): boolean => {
    const parent = node.parent;
    if (!ts.isBinaryExpression(parent)) return false;
    const comparison = parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsToken
      || parent.operatorToken.kind === ts.SyntaxKind.InKeyword;
    if (!comparison) return false;
    if (parent.operatorToken.kind === ts.SyntaxKind.InKeyword) return true;
    const other = parent.left === node ? parent.right : parent.left;
    const buildConstant = ts.isIdentifier(other) && other.text.startsWith("__KNOWLEDGE_WORKBENCH_");
    return buildConstant || TECHNICAL_CODE.test(text)
      || text === "Escape" || text === "zh-CN" || text === "en-US";
  };
  const isNormalOnlyBrandDeclaration = (node: ts.Node, text: string): boolean => (
    file === "src/ui/settings-sections.ts"
    && text === "SecretStorage"
    && ts.isVariableDeclaration(node.parent)
    && node.parent.initializer === node
    && ts.isIdentifier(node.parent.name)
    && node.parent.name.text === "SECRET_STORAGE_BRAND"
  );
  const isNormalOnlyBrandInterpolation = (
    expression: ts.StringLiteralLike,
    context: ts.Node,
    sink: string,
  ): boolean => {
    if (file !== "src/ui/settings-sections.ts"
      || expression.text !== "SecretStorage"
      || !sink.endsWith(":i18n-value")
      || !isNormalOnlyBrandDeclaration(expression, expression.text)
      || !ts.isPropertyAssignment(context)
      || declarationName(context.name) !== "credentialStoreName"
      || !ts.isObjectLiteralExpression(context.parent)
      || !ts.isCallExpression(context.parent.parent)
      || context.parent.parent.arguments[1] !== context.parent
      || !isWorkbenchI18nCall(context.parent.parent)) return false;
    const key = context.parent.parent.arguments[0];
    return key !== undefined
      && ts.isStringLiteralLike(key)
      && (key.text === "settings.surface.credentialStorage"
        || key.text === "settings.surface.persistentCredentialId");
  };
  const DIRECTORY_PICKER_INTERPOLATIONS = new Set([
    "directories", "matches", "path", "query", "requests", "root", "seconds",
  ]);
  const isDirectoryPickerInterpolation = (context: ts.Node, sink: string): boolean => (
    file === "src/ui/cloud-directory-picker.ts"
    && sink.endsWith(":i18n-value")
    && ts.isPropertyAssignment(context)
    && DIRECTORY_PICKER_INTERPOLATIONS.has(declarationName(context.name) ?? "")
  );
  const isTechnicalLiteral = (node: ts.Node, text: string): boolean => {
    if (isNormalOnlyBrandDeclaration(node, text)) return true;
    if (PUNCTUATION_ONLY.test(text) || TECHNICAL_PATH.test(text) || TECHNICAL_FIELD_PREFIX.test(text)) return true;
    if (TECHNICAL_FILENAME_FRAGMENT.test(text)) return true;
    if (text === "en" || text === "zh-CN" || text === "en-US") return true;
    if (file === "src/ui/cloud-directory-picker.ts"
      && (text === "ArrowDown" || text === "ArrowUp" || text === "Enter")) return true;
    const parent = node.parent;
    if ((ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) && parent.moduleSpecifier === node) return true;
    if (ts.isExternalModuleReference(parent) && parent.expression === node) return true;
    if (ts.isLiteralTypeNode(parent)
      && (TECHNICAL_CODE.test(text) || text === "en" || text === "zh-CN" || text === "en-US")) return true;
    if (ts.isPropertyAssignment(parent) && parent.name === node) {
      const value = unwrap(parent.initializer);
      const localizedSentinel = ts.isStringLiteralLike(value) && dictionary.keys.has(value.text);
      if (localizedSentinel || TECHNICAL_CODE.test(text)) return true;
    }
    if ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent)
      || ts.isPropertySignature(parent) || ts.isMethodSignature(parent))
      && parent.name === node && TECHNICAL_CODE.test(text)) return true;
    if (ts.isElementAccessExpression(parent) && parent.argumentExpression === node
      && TECHNICAL_CODE.test(text)) return true;
    if (isTechnicalComparison(node, text)) return true;
    const assigned = assignmentProperty(node);
    if (assigned === "className" && TECHNICAL_CSS_CLASS.test(text)) return true;
    if (assigned !== undefined && TECHNICAL_ASSIGNMENT_PROPERTIES.has(assigned)
      && (TECHNICAL_CODE.test(text) || TECHNICAL_CSS_CLASS.test(text))) return true;
    let assignmentTarget: ts.Expression | undefined;
    let current = node;
    while (current.parent !== undefined && !ts.isBinaryExpression(current.parent)) current = current.parent;
    if (current.parent !== undefined && ts.isBinaryExpression(current.parent)
      && current.parent.right === current) assignmentTarget = current.parent.left;
    if (assignmentTarget !== undefined && ts.isPropertyAccessExpression(assignmentTarget)
      && ts.isPropertyAccessExpression(assignmentTarget.expression)
      && assignmentTarget.expression.name.text === "dataset"
      && (TECHNICAL_FRAGMENT.test(text) || TECHNICAL_CSS_CLASS.test(text))) return true;
    if (assignmentTarget !== undefined && ts.isPropertyAccessExpression(assignmentTarget)
      && ts.isPropertyAccessExpression(assignmentTarget.expression)
      && assignmentTarget.expression.name.text === "style"
      && /^(?:px|-?(?:\d+(?:\.\d+)?)(?:px|%|em|rem|vh|vw)?|#[0-9a-fA-F]{3,8})$/u.test(text)) return true;
    const property = propertyInitializerName(node);
    if (property !== undefined && TECHNICAL_OBJECT_PROPERTIES.has(property)
      && (TECHNICAL_CODE.test(text) || /^(?:application|text)\/[a-z0-9.+-]+$/u.test(text))) return true;
    const argument = enclosingCallArgument(node);
    if (argument !== undefined) {
      const callee = propertyName(argument.call.expression)
        ?? (ts.isIdentifier(argument.call.expression) ? argument.call.expression.text : "");
      const positions = TECHNICAL_CALL_ARGUMENTS[callee];
      if ((positions === "all" || positions?.includes(argument.index) === true)
        && isTrustedTechnicalApiCall(argument.call)) return true;
      if (callee === "setAttribute" && isTrustedTechnicalApiCall(argument.call)) {
        if (argument.index === 0) return true;
        const attribute = argument.call.arguments[0];
        return argument.index === 1 && attribute !== undefined && ts.isStringLiteral(attribute)
          && attribute.text !== "aria-label" && attribute.text !== "title"
          && (TECHNICAL_CODE.test(text) || TECHNICAL_CSS_CLASS.test(text));
      }
      if (callee === "addRibbonIcon" && argument.index === 0
        && declarationPath(resolvedDeclaration(argument.call)) === OBSIDIAN_DECLARATION) return true;
      if (callee === "open" && argument.index > 0
        && isTrustedTechnicalApiCall(argument.call)) return true;
      if (callee === "add" || callee === "remove" || callee === "toggle") {
        const receiver = ts.isPropertyAccessExpression(argument.call.expression)
          ? argument.call.expression.expression
          : undefined;
        if (receiver !== undefined && propertyName(receiver) === "classList"
          && /^knowledge-workbench(?:(?:__|--)[a-z0-9-]+)*$/u.test(text)
          && isTrustedTechnicalApiCall(argument.call)) return true;
      }
    }
    if (ts.isNewExpression(parent) && ts.isIdentifier(parent.expression)
      && ["Error", "EvalError", "RangeError", "ReferenceError", "SyntaxError", "TypeError", "URIError", "URL"].includes(parent.expression.text)
      && isTypescriptLibDeclaration(resolvedDeclaration(parent))) return true;
    if (ts.isReturnStatement(parent) && TECHNICAL_CODE.test(text)) {
      let owner: ts.Node | undefined = parent.parent;
      while (owner !== undefined && !ts.isFunctionLike(owner)) owner = owner.parent;
      if (owner !== undefined && ts.isMethodDeclaration(owner)
        && owner.name !== undefined && declarationName(owner.name) === "getIcon") return true;
    }
    const contextual = ts.isExpression(node) ? checker.getContextualType(node) : undefined;
    const contextualValues = contextual === undefined ? [] : stringLiteralsFromType(contextual);
    if (contextualValues.length > 0 && contextualValues.every((value) => dictionary.keys.has(value))) return false;
    if (contextualValues.length > 0 && contextualValues.includes(text)
      && contextualValues.every((value) => TECHNICAL_CODE.test(value)
        || value === "Escape" || value === "zh-CN" || value === "en-US")) return true;
    if (/^(?:https?|obsidian):\/\//u.test(text)) return true;
    return false;
  };

  const checkLiteralOrigin = (node: ts.Expression, text: string): void => {
    if (isTechnicalLiteral(node, text)) return;
    if (isMessageKeyContext(node)) {
      if (!(SURFACE_NAMESPACES[file] as readonly string[]).some((namespace) => text.startsWith(namespace))) {
        record(node, "literal-origin", `wrong-namespace:${text}`);
      }
      if (!dictionary.keys.has(text)) record(node, "literal-origin", `missing-i18n-key:${text}`);
      return;
    }
    record(node, "literal-origin", `hard-coded:${text}`);
  };

  const displaySink = (node: ts.Node): Readonly<{ expression: ts.Expression | undefined; sink: string }> | undefined => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && DISPLAY_PROPERTIES.has(propertyName(node.left) ?? "")) {
      return { expression: node.right, sink: propertyName(node.left)! };
    }
    if (!ts.isCallExpression(node)) return undefined;
    const callee = propertyName(node.expression)
      ?? (ts.isIdentifier(node.expression) ? node.expression.text : "");
    if (callee === "setTitle") return { expression: node.arguments[0], sink: "setTitle" };
    if (callee === "setAttribute" && node.arguments[0] !== undefined
      && ts.isStringLiteral(node.arguments[0])
      && (node.arguments[0].text === "aria-label" || node.arguments[0].text === "title")) {
      return { expression: node.arguments[1], sink: node.arguments[0].text };
    }
    if (callee === "addRibbonIcon") return { expression: node.arguments[1], sink: "ribbon-label" };
    if (callee === "appendButton") return { expression: node.arguments[1], sink: "button-label" };
    if (callee === "button") return { expression: node.arguments[0], sink: "button-label" };
    if (callee === "actionButton") {
      const local = functionFor(node);
      const labelIndex = local?.parameters.findIndex((parameter) => (
        ts.isIdentifier(parameter.name) && parameter.name.text === "label"
      ));
      return { expression: node.arguments[labelIndex === undefined || labelIndex < 0 ? 0 : labelIndex], sink: "button-label" };
    }
    if (callee === "heading") return { expression: node.arguments[2], sink: "heading" };
    if (callee === "appendProgressCard") return { expression: node.arguments[1], sink: "progress-card-title" };
    if (callee === "appendDetailList" || callee === "renderItems") {
      return { expression: node.arguments[1], sink: "section-heading" };
    }
    return undefined;
  };

  const callStack = new Set<ts.FunctionLikeDeclaration>();
  let checkExpression: (
    input: ts.Expression | undefined,
    node: ts.Node,
    sink: string,
    environment: Environment,
    seen?: ReadonlySet<ts.Symbol>,
  ) => void;

  const inspectFunction = (
    declaration: ts.FunctionLikeDeclaration,
    call: ts.CallExpression,
    outerEnvironment: Environment,
    sink: string,
    inspectReturns: boolean,
  ): void => {
    if (callStack.has(declaration)) return;
    callStack.add(declaration);
    const environment = bindFunction(declaration, call, outerEnvironment);
    const body = declaration.body;
    if (body === undefined) {
      callStack.delete(declaration);
      return;
    }
    if (!ts.isBlock(body)) {
      if (inspectReturns) checkExpression(body, body, sink, environment);
      callStack.delete(declaration);
      return;
    }
    const visit = (node: ts.Node): void => {
      if (node !== body && ts.isFunctionLike(node)) return;
      if (inspectReturns && ts.isReturnStatement(node)) {
        checkExpression(node.expression, node, sink, environment);
      }
      ts.forEachChild(node, visit);
    };
    visit(body);
    callStack.delete(declaration);
  };

  checkExpression = (
    input: ts.Expression | undefined,
    node: ts.Node,
    sink: string,
    environment: Environment,
    seen: ReadonlySet<ts.Symbol> = new Set(),
  ): void => {
    if (input === undefined) {
      record(node, sink, "missing-expression");
      return;
    }
    const expression = unwrap(input);
    if (isRawErrorDisplayExpression(expression)) {
      record(node, sink, "raw-error-detail");
      return;
    }
    if (isDirectoryPickerInterpolation(node, sink)) return;
    if (ts.isStringLiteralLike(expression)) {
      if (isNormalOnlyBrandInterpolation(expression, node, sink)) return;
      if (!PUNCTUATION_ONLY.test(expression.text) && !TECHNICAL_PATH.test(expression.text)) {
        record(node, sink, `hard-coded:${expression.text}`);
      }
      return;
    }
    if (ts.isNumericLiteral(expression)) return;
    if (ts.isTemplateExpression(expression)) {
      for (const fragment of [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)]) {
        if (!PUNCTUATION_ONLY.test(fragment) && !TECHNICAL_FIELD_PREFIX.test(fragment)) {
          record(node, sink, `hard-coded-template:${fragment}`);
        }
      }
      for (const span of expression.templateSpans) checkExpression(span.expression, node, sink, environment, seen);
      return;
    }
    if (ts.isBinaryExpression(expression)) {
      if (expression.operatorToken.kind === ts.SyntaxKind.PlusToken
        || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
        || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        checkExpression(expression.left, node, sink, environment, seen);
        checkExpression(expression.right, node, sink, environment, seen);
        return;
      }
      record(node, sink, "unsupported-binary-expression");
      return;
    }
    if (ts.isConditionalExpression(expression)) {
      checkExpression(expression.whenTrue, node, sink, environment, seen);
      checkExpression(expression.whenFalse, node, sink, environment, seen);
      return;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      for (const property of expression.properties) {
        if (ts.isPropertyAssignment(property)) {
          checkExpression(property.initializer, property, sink, environment, seen);
        }
      }
      return;
    }
    if (ts.isArrayLiteralExpression(expression)) {
      for (const element of expression.elements) {
        if (ts.isExpression(element)) checkExpression(element, element, sink, environment, seen);
      }
      return;
    }
    if (ts.isCallExpression(expression)) {
      const callee = propertyName(expression.expression)
        ?? (ts.isIdentifier(expression.expression) ? expression.expression.text : "");
      const receiver = ts.isPropertyAccessExpression(expression.expression)
        ? expression.expression.expression
        : undefined;
      const i18nCall = isWorkbenchI18nCall(expression);
      if ((callee === "t" || callee === "number") && receiver !== undefined && !i18nCall) {
        record(node, sink, "untyped-i18n-call");
        return;
      }
      if (callee === "t" && i18nCall) {
        checkI18nCall(expression, sink, environment, checkExpression);
        return;
      }
      if (callee === "number" && i18nCall) return;
      const local = functionFor(expression);
      if (local !== undefined) {
        inspectFunction(local, expression, environment, sink, true);
        return;
      }
      if (callee === "stringify" && ts.isPropertyAccessExpression(expression.expression)
        && ts.isIdentifier(expression.expression.expression)
        && expression.expression.expression.text === "JSON") return;
      if (callee === "join" && receiver !== undefined
        && isExternalExpression(receiver, environment)) return;
      if (isExternalExpression(expression, environment)) return;
      record(node, sink, `unapproved-call:${callee || expression.expression.getText(ast)}`);
      return;
    }
    if (ts.isIdentifier(expression)) {
      if (expression.text === "undefined") return;
      const symbol = symbolAt(expression);
      if (symbol !== undefined && seen.has(symbol)) {
        record(node, sink, `alias-cycle:${expression.text}`);
        return;
      }
      const bound = symbol === undefined ? undefined : environment.get(symbol);
      const nextSeen = symbol === undefined ? seen : new Set([...seen, symbol]);
      if (bound !== undefined) {
        checkExpression(bound.expression, node, sink, bound.environment, nextSeen);
        return;
      }
      const declaration = lexicalDeclaration(expression) ?? declarationOf(symbol);
      if (declaration !== undefined && ts.isParameter(declaration)) return;
      if (declaration !== undefined && ts.isBindingElement(declaration)) {
        const sourceExpression = bindingElementSource(declaration);
        if (sourceExpression !== undefined && isExternalExpression(sourceExpression, environment)) return;
      }
      const initializer = initializerOf(declaration);
      if (initializer !== undefined) {
        checkExpression(initializer, node, sink, environment, nextSeen);
        return;
      }
      const forOfSource = declaration === undefined ? undefined : enclosingForOfSource(declaration);
      if (forOfSource !== undefined && isExternalExpression(forOfSource, environment)) return;
      record(node, sink, `unclassified-identifier:${expression.text}`);
      return;
    }
    if (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
      const values = staticMemberValues(expression, environment);
      if (values.length > 0) {
        for (const value of values) checkExpression(value, node, sink, environment, seen);
        return;
      }
      if (isExternalExpression(expression, environment)) return;
      let root: ts.Expression = expression.expression;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) root = root.expression;
      if (ts.isIdentifier(root)) {
        const rootSymbol = symbolAt(root);
        const bound = rootSymbol === undefined ? undefined : environment.get(rootSymbol);
        if (bound !== undefined) {
          checkExpression(bound.expression, node, sink, bound.environment, seen);
          return;
        }
        const initializer = initializerOf(lexicalDeclaration(root) ?? declarationOf(rootSymbol));
        if (initializer !== undefined) {
          checkExpression(initializer, node, sink, environment, seen);
          return;
        }
      }
      record(node, sink, `unclassified-member:${expression.getText(ast)}`);
      return;
    }
    record(node, sink, `unsupported-expression:${ts.SyntaxKind[expression.kind]}`);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) checkLiteralOrigin(node, node.text);
    if (ts.isTemplateExpression(node)) {
      if (!isMessageKeyContext(node)) {
        for (const fragment of [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]) {
          if (!isTechnicalLiteral(node, fragment)) record(node, "literal-origin", `hard-coded-template:${fragment}`);
        }
      }
    }
    const display = displaySink(node);
    if (display !== undefined) checkExpression(display.expression, node, display.sink, EMPTY_ENVIRONMENT);
    if (ts.isCallExpression(node)) {
      const callee = propertyName(node.expression)
        ?? (ts.isIdentifier(node.expression) ? node.expression.text : "");
      if (callee === "t" && ts.isPropertyAccessExpression(node.expression)) {
        if (isWorkbenchI18nCall(node)) {
          checkI18nCall(node, "i18n-call", EMPTY_ENVIRONMENT, checkExpression);
        } else {
          record(node, "i18n-call", "untyped-i18n-call");
        }
      }
    }
    if (ts.isMethodDeclaration(node) && declarationName(node.name) === "getDisplayText" && node.body !== undefined) {
      for (const statement of node.body.statements) {
        if (ts.isReturnStatement(statement)) {
          checkExpression(statement.expression, statement, "view-title", EMPTY_ENVIRONMENT);
        }
      }
    }
    if (ts.isPropertyAssignment(node) && declarationName(node.name) === "name") {
      checkExpression(node.initializer, node, "command-or-setting-name", EMPTY_ENVIRONMENT);
    }
    if (ts.isPropertyAssignment(node) && declarationName(node.name) === "desc") {
      checkExpression(node.initializer, node, "setting-description", EMPTY_ENVIRONMENT);
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return [...new Map(findings.map((finding) => [
    `${finding.file}:${finding.line}:${finding.sink}:${finding.reason}`,
    finding,
  ])).values()];
};

const findingsFor = (file: SurfaceFile): readonly Finding[] => findingsForSource(
  file,
  readFileSync(resolve(ROOT, file), "utf8"),
);

describe("user-facing localization boundary", () => {
  it("proves every display sink has localized or explicitly classified provenance", () => {
    expect((Object.keys(SURFACE_NAMESPACES) as SurfaceFile[]).flatMap(findingsFor)).toEqual([]);
  }, 20_000);

  it("keeps both dictionaries complete, non-empty, symmetric, and namespace-owned", () => {
    expect(DICTIONARY.findings).toEqual([]);
  });

  it.each([
    ["const leaked = 'Alias leak'; node.textContent = (leaked as string) satisfies string;", "hard-coded"],
    ["input.placeholder = 'Placeholder leak';", "hard-coded"],
    ["modal.setTitle('Title leak');", "hard-coded"],
    ["node.setAttribute('aria-label', 'ARIA leak');", "hard-coded"],
    ["node.title = 'Tooltip leak';", "hard-coded"],
    ["appendButton(node, 'Button leak', action);", "hard-coded"],
    ["plugin.addCommand({ name: 'Command leak' });", "hard-coded"],
    ["plugin.addRibbonIcon('network', 'Ribbon leak', action);", "hard-coded"],
    ["class View { getDisplayText(): string { return 'View leak'; } }", "hard-coded"],
    [`import type { WorkbenchI18n } from "../i18n/workbench-i18n";
      function render(i18n: WorkbenchI18n) { node.textContent = i18n.t("catalog.title"); }`, "wrong-namespace"],
    [`import type { WorkbenchI18n } from "../i18n/workbench-i18n";
      function render(i18n: WorkbenchI18n) { node.textContent = i18n.t("today.missing"); }`, "missing-i18n-key"],
    ["const i18n = { t: () => 'Leak' }; node.textContent = i18n.t('today.title');", "untyped-i18n-call"],
    ["node.textContent = unsafeIdentifier;", "unclassified-identifier"],
    ["node.textContent = unsafeCall();", "unapproved-call"],
  ] as const)("rejects mutation provenance: %s", (source, reason) => {
    expect(findingsForSource("src/ui/today-pane.ts", source)
      .some((finding) => finding.reason.startsWith(reason))).toBe(true);
  });

  it.each([
    [
      "src/ui/today-pane.ts",
      `const label = "Hard-coded"; node.textContent = label;`,
    ],
    [
      "src/ui/today-pane.ts",
      `const item = { path: "Hard-coded" }; node.textContent = item.path;`,
    ],
    [
      "src/ui/suggestions-tab.ts",
      `const operationSummary = (): string => "Hard-coded"; node.textContent = operationSummary();`,
    ],
    [
      "src/ui/settings-sections.ts",
      `const SETTINGS_ZH_CN = Object.freeze({ "Hard-coded": "硬编码" });
       const copy = (english: string): string => SETTINGS_ZH_CN[english] ?? english;
       node.textContent = copy("Hard-coded");`,
    ],
    [
      "src/ui/map-pane.ts",
      `function render(i18n: WorkbenchI18n): void {
         node.textContent = i18n.t("map.details.none", { value: "Hard-coded" });
       }`,
    ],
  ] as const)("rejects reviewer false-green mutation in %s: %s", (file, source) => {
    expect(findingsForSource(file, source)).not.toEqual([]);
  });

  it.each([
    [
      "src/ui/today-pane.ts",
      `function paint(value: string): void { node.textContent = value; }
       paint("Hard-coded");`,
      "hard-coded",
    ],
    [
      "src/ui/today-pane.ts",
      `import type { WorkbenchI18n, WorkbenchMessageKey } from "../i18n/workbench-i18n";
       function paint(i18n: WorkbenchI18n, key: WorkbenchMessageKey): void {
         node.textContent = i18n.t(key);
       }
       paint(i18n, "catalog.title");`,
      "wrong-namespace",
    ],
    [
      "src/ui/today-pane.ts",
      `const make = (): { label: string } => ({ label: "Hard-coded" });
       function paint(value: string): void { node.textContent = value; }
       paint(make().label);`,
      "hard-coded",
    ],
    [
      "src/ui/today-pane.ts",
      `class Card {
         label = "Hard-coded";
         update(value: string): void { this.label = value; }
       }
       const card = new Card();
       card.update(externalValue);
       node.textContent = card.label;`,
      "hard-coded",
    ],
    [
      "src/ui/settings-sections.ts",
      `createCollapsibleSection(host, "Hard-coded title", "Hard-coded summary");`,
      "hard-coded",
    ],
  ] as const)("rejects literal-origin reviewer mutation in %s: %s", (file, source, reason) => {
    const findings = findingsForSource(file, source);
    expect(
      findings.some((finding) => finding.reason.startsWith(reason)),
      JSON.stringify(findings),
    ).toBe(true);
  });

  it("allows only structurally technical literals in their exact AST contexts", () => {
    expect(findingsForSource("src/ui/today-pane.ts", `
      import type { WorkbenchI18n } from "../i18n/workbench-i18n";
      declare const doc: Document;
      declare const node: HTMLElement;
      declare const popup: Window;
      declare const source: string;
      declare const i18n: WorkbenchI18n;
      declare const value: unknown;
      node.className = "knowledge-workbench__technical";
      node.dataset.action = "open-workbench";
      doc.createElement("button");
      node.setAttribute("role", "status");
      node.addEventListener("click", () => undefined);
      popup.open("https://example.invalid", "_blank", "noopener,noreferrer");
      source.includes("technical-token");
      node.textContent = i18n.t("today.title");
      const technical = { "technical-key": value };
      const endpoint = new URL("relative-path", "https://example.invalid");
      type Mode = "read-only";
      const mode: Mode = "read-only";
      if (mode === "read-only") throw new RangeError("internal-code");
      void endpoint;
      void technical;
    `)).toEqual([]);
  });

  it.each([
    `function paint(value: string): void { node.textContent = value; }
     paint("knowledge-workbench__visible");`,
    `function createElement(value: string): void { node.textContent = value; }
     createElement("Hard-coded");`,
    `const fake = { setAttribute(_name: string, value: string): void { node.textContent = value; } };
     fake.setAttribute("role", "Hard-coded");`,
    `function listen(_node: unknown, value: string): void { node.textContent = value; }
     listen(node, "Hard-coded");`,
    `function triggerHistoryDownload(_host: unknown, _json: string, filename: string): void {
       node.textContent = filename;
     }
     triggerHistoryDownload(node, "{}", "Hard-coded");`,
  ])("rejects a technical-lookalike outside its exact context: %s", (source) => {
    expect(findingsForSource("src/ui/today-pane.ts", source)
      .some((finding) => finding.reason.startsWith("hard-coded"))).toBe(true);
  });

  it.each([
    `class FakeDocument {
       createElement(value: string): HTMLElement { node.textContent = value; return node; }
     }
     new FakeDocument().createElement("Hard-coded");`,
    `class FakeWorkbenchI18n {
       t(_key: string): string { return new Error("Hard-coded").message; }
     }
     const i18n = new FakeWorkbenchI18n();
     node.textContent = i18n.t("today.title");`,
    `class MyEventTarget {
       addEventListener(value: string, _listener: () => void): void { node.textContent = value; }
     }
     new MyEventTarget().addEventListener("Hard-coded", () => undefined);`,
    `class PopupWindow {
       open(_url: string, value: string): void { node.textContent = value; }
     }
     new PopupWindow().open("https://example.invalid", "Hard-coded");`,
    `class StringPresenter {
       includes(value: string): boolean { node.textContent = value; return false; }
     }
     new StringPresenter().includes("Hard-coded");`,
    `function paint(value: string): void { node.textContent = value; }
     Object.keys({ "Hard-coded": true }).forEach(paint);`,
    `class DisplayError {
       constructor(message: string) { node.textContent = message; }
     }
     new DisplayError("Hard-coded");`,
    `export {};
     class URL {
       constructor(value: string) { node.textContent = value; }
     }
     new URL("Hard-coded");`,
  ])("rejects a local declaration masquerading as a technical source: %s", (source) => {
    expect(findingsForSource("src/ui/today-pane.ts", source)).not.toEqual([]);
  });

  it.each([
    `Promise.reject(new Error("Hard-coded")).catch((error: Error) => {
       node.textContent = error.message;
     });`,
    `async function fail(): Promise<void> { throw new Error("Hard-coded"); }
     void fail().catch((error) => { node.textContent = error.message; });`,
    `Promise.reject(new Error("Hard-coded")).catch((error: Error) => {
       node.textContent = error.stack ?? "";
     });`,
    `function render(error: unknown): void {
       if (error instanceof Error) node.textContent = error.message;
     }`,
    `Promise.reject(new Error("Hard-coded")).catch((error: Error) => {
       node.textContent = String(error);
    });`,
    `Promise.reject(new Error("Hard-coded")).catch((error: Error) => {
       node.textContent = \`\${error}\`;
     });`,
  ])("rejects raw standard Error detail at a display sink: %s", (source) => {
    expect(findingsForSource("src/ui/today-pane.ts", source)
      .some((finding) => finding.reason === "raw-error-detail")).toBe(true);
  });

  it.each([
    [
      "src/ui/today-pane.ts",
      `function render(userInput: string): void {
         const dto = { message: userInput };
         node.textContent = dto.message;
       }`,
    ],
    [
      "src/ui/workbench-view.ts",
      `import type { WorkbenchI18n } from "../i18n/workbench-i18n";
       function render(i18n: WorkbenchI18n): void {
         node.textContent = i18n.t("ai.error.safe");
       }`,
    ],
  ] as const)("keeps safe error-adjacent display provenance valid in %s: %s", (file, source) => {
    expect(findingsForSource(file, source)).toEqual([]);
  });

  it.each([
    [
      "src/ui/today-pane.ts",
      `function render(item: TodayItem): void { node.textContent = item.path; }`,
    ],
    [
      "src/ui/ai-payload-preview-modal.ts",
      `function render(preview: AiPayloadPreview): void { node.textContent = preview.filename; }`,
    ],
    [
      "src/ui/suggestions-tab.ts",
      `function render(suggestion: SuggestedOperation): void {
         node.textContent = suggestion.rationale.summary;
       }`,
    ],
  ] as const)("keeps dynamic user provenance valid in %s: %s", (file, source) => {
    expect(findingsForSource(file, source)).toEqual([]);
  });

  it("rejects missing and empty bilingual dictionary entries", () => {
    const mutated = dictionaryShape(`
      const en = { "today.present": "Present", "today.empty": "", "today.params": "{count}" } as const;
      const zhCN: Record<keyof typeof en, string> = { "today.present": "存在", "today.params": "数量" };
    `);
    expect(mutated.findings).toEqual(expect.arrayContaining([
      "empty-value:en:today.empty",
      "missing-key:zhCN:today.empty",
      "placeholder-mismatch:today.params",
    ]));
  });
});
