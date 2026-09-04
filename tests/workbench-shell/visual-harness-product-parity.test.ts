/* The QA visual workbench (`tests/workbench-shell/visual-harness/`) exists to
   show the owner what the product looks like. When it silently drifts from the
   product it is worse than no workbench at all, because it produces confident
   acceptance of things it never actually showed: the harness once loaded four
   of the product's five stylesheets and drew a Project header one child short
   of the shipped one, so the wrap defect recorded as `F118` could not have
   appeared in any QA look ever taken through it.

   Every expectation in this file is DERIVED from the product sources at test
   time. Nothing here records today's answer. If the product entry gains a sixth
   stylesheet, or the Project header gains a sixth child, these tests go RED
   until the harness is brought along — which is the whole point. Where a
   derivation cannot be completed the test FAILS rather than passing quietly;
   an underivable answer is never treated as agreement. */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import ts from "typescript";

import { visualFixture } from "./visual-harness/fixture.ts";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

const productEntryPath = fileURLToPath(
  new URL("../../src/workbench-shell/renderer/index.tsx", import.meta.url),
);
const productMountPath = fileURLToPath(
  new URL("../../src/workbench-shell/renderer/mount.tsx", import.meta.url),
);
const productProjectRailPath = fileURLToPath(
  new URL(
    "../../src/workbench-shell/renderer/project-rail.tsx",
    import.meta.url,
  ),
);
const harnessEntryPath = fileURLToPath(
  new URL("./visual-harness/main.tsx", import.meta.url),
);

/* The container this guard compares. Named once, resolved by parsing both
   sides; if the product renames it, `locateSoleElementByClass` fails loudly. */
const projectHeaderClass = "proj-head";

test("the visual workbench loads the product's stylesheets, all of them, in the product's cascade order", () => {
  const productSheets = sideEffectStylesheetImports(productEntryPath);
  const harnessSheets = sideEffectStylesheetImports(harnessEntryPath);

  /* Anti-vacuity: if the product ever stops declaring its cascade in the entry
     module, this guard is comparing nothing and must say so rather than pass. */
  assert.ok(
    productSheets.length > 0,
    `${repositoryRelative(productEntryPath)} declares no stylesheet imports, so this guard can no longer derive the product cascade. Find where the product cascade now lives and re-derive it here.`,
  );

  for (const sheet of new Set([...productSheets, ...harnessSheets])) {
    assert.ok(
      existsSync(resolve(repositoryRoot, sheet)),
      `a stylesheet import resolves to ${sheet}, which does not exist on disk`,
    );
  }

  /* Order, not just membership: the harness exists to show a cascade, and a
     sheet loaded in the wrong position is a different cascade. */
  assert.deepEqual(
    harnessSheets,
    productSheets,
    `the visual workbench cascade diverges from the product cascade.\n  product (${repositoryRelative(productEntryPath)}):\n    ${productSheets.join("\n    ")}\n  workbench (${repositoryRelative(harnessEntryPath)}):\n    ${harnessSheets.join("\n    ")}`,
  );
});

test("the visual workbench draws every child of the Project header the product draws", () => {
  const projectRailComponent = parseSource(productProjectRailPath);
  const mountComponent = parseSource(productMountPath);
  const header = locateSoleElementByClass(
    projectRailComponent,
    projectHeaderClass,
    productProjectRailPath,
  );
  const slots = classifyChildSlots(header, productProjectRailPath);

  const harnessCapabilities = bridgeCapabilities(harnessEntryPath);

  const unmet: string[] = [];
  for (const slot of slots) {
    if (slot.kind === "always") continue;
    const capability = bridgeCapabilityBehind(
      mountComponent,
      slot.gateProperty,
      productMountPath,
    );
    if (!harnessCapabilities.has(capability)) {
      unmet.push(
        `${slot.description} is drawn only when \`props.${slot.gateProperty}\` is supplied, which the renderer derives from the optional bridge capability \`${capability}\`; the visual workbench bridge does not provide it`,
      );
    }
  }

  const productChildren = slots.length;
  const harnessChildren = productChildren - unmet.length;

  assert.equal(
    harnessChildren,
    productChildren,
    `the visual workbench renders a .${projectHeaderClass} with ${harnessChildren} of the product's ${productChildren} children, so any defect in the missing children cannot appear in a QA look.\n  ${unmet.join("\n  ")}`,
  );
});

test("the visual workbench bridge supplies every optional capability the renderer gates UI on", () => {
  const component = parseSource(productMountPath);
  const gated = optionalBridgeCapabilities(component);
  const supplied = bridgeCapabilities(harnessEntryPath);

  assert.ok(
    supplied.size > 0,
    `no bridge object literal was found in ${repositoryRelative(harnessEntryPath)}; this guard can no longer derive what the visual workbench supplies`,
  );

  const missing = [...gated].filter((name) => !supplied.has(name)).sort();
  assert.deepEqual(
    missing,
    [],
    `the renderer draws different UI depending on whether these optional bridge capabilities exist, and the visual workbench omits them, so it shows a product build that does not ship: ${missing.join(", ")}`,
  );
});

test("the visual workbench can set every root flag the product entry sets at startup", () => {
  /* A stylesheet is only half of a cascade: the product entry also stamps root
     `data-*` flags that whole rule blocks select on, and a flag the harness
     cannot stamp is a branch of the product's own CSS that no QA look can ever
     reach. Product ⊆ harness, one-directional on purpose — the harness adds its
     own `qa*` instrumentation flags, which the product must never carry. */
  const productFlags = rootDatasetFlags(productEntryPath);
  const harnessFlags = rootDatasetFlags(harnessEntryPath);

  assert.ok(
    productFlags.size > 0,
    `${repositoryRelative(productEntryPath)} sets no root dataset flag, so this guard can no longer derive what the harness must reproduce`,
  );

  const unreachable = [...productFlags]
    .filter((flag) => !harnessFlags.has(flag))
    .sort();
  assert.deepEqual(
    unreachable,
    [],
    `the product entry stamps root flags the visual workbench never stamps, so every CSS rule selecting on them is invisible to QA: ${unreachable.map((flag) => `data-${flag}`).join(", ")}`,
  );
});

test("the visual workbench fixture actually contains a Project, so the header comparison is not vacuous", () => {
  /* A Project header is rendered per Project row. With no Project in the
     default fixture the harness draws zero headers and every claim above about
     header children would be true of an empty screen. */
  assert.ok(
    visualFixture.projectSelection.projects.length > 0,
    "the default visual fixture registers no Project, so the visual workbench renders no Project header at all",
  );
});

/* -------------------------------------------------------------------------
   Derivations. Each returns a fact read out of a source file; none of them
   contains a remembered answer.
   ---------------------------------------------------------------------- */

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TSX,
  );
}

function repositoryRelative(path: string): string {
  return relative(repositoryRoot, path).replaceAll("\\", "/");
}

/** Side-effect-only `.css` imports, in source order, resolved so that the two
    entries' different relative depths cannot hide a difference or invent one. */
function sideEffectStylesheetImports(path: string): readonly string[] {
  const source = parseSource(path);
  const directory = dirname(path);
  const sheets: string[] = [];
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (statement.importClause !== undefined) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.endsWith(".css")) continue;
    sheets.push(repositoryRelative(resolve(directory, specifier)));
  }
  return sheets;
}

/** Every `<key>` assigned by `document.documentElement.dataset.<key> = …`. */
function rootDatasetFlags(path: string): ReadonlySet<string> {
  const source = parseSource(path);
  const flags = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(node.left)
    ) {
      const dataset = node.left.expression;
      if (
        ts.isPropertyAccessExpression(dataset) &&
        dataset.name.getText() === "dataset" &&
        ts.isPropertyAccessExpression(dataset.expression) &&
        dataset.expression.name.getText() === "documentElement"
      ) {
        flags.add(node.left.name.getText());
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return flags;
}

type ChildSlot =
  | { readonly kind: "always"; readonly description: string }
  | {
      readonly kind: "gated";
      readonly description: string;
      readonly gateProperty: string;
    };

/** The one JSX element carrying `class="… <className> …"`. Zero or several is a
    failure: the guard must not quietly compare the wrong container. */
function locateSoleElementByClass(
  source: ts.SourceFile,
  className: string,
  path: string,
): ts.JsxElement {
  const found: ts.JsxElement[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isJsxElement(node)) {
      const literal = staticClassAttribute(node.openingElement);
      if (literal !== undefined && literal.split(/\s+/u).includes(className)) {
        found.push(node);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(
    found.length,
    1,
    `expected exactly one element with class "${className}" in ${repositoryRelative(path)}, found ${found.length}; this guard can no longer locate the Project header and must be re-derived rather than deleted`,
  );
  return found[0]!;
}

function staticClassAttribute(
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): string | undefined {
  for (const attribute of opening.attributes.properties) {
    if (!ts.isJsxAttribute(attribute)) continue;
    if (attribute.name.getText() !== "class") continue;
    const initializer = attribute.initializer;
    if (initializer !== undefined && ts.isStringLiteral(initializer)) {
      return initializer.text;
    }
  }
  return undefined;
}

/** One entry per DOM child the container can place, each marked as always
    drawn or drawn only when a named prop is supplied. Any child shape this
    routine cannot account for fails the test — an unknown child is never
    silently counted as agreement in either direction. */
function classifyChildSlots(
  container: ts.JsxElement,
  path: string,
): readonly ChildSlot[] {
  const slots: ChildSlot[] = [];
  for (const child of container.children) {
    if (ts.isJsxText(child)) {
      assert.ok(
        child.containsOnlyTriviaWhiteSpaces,
        `unexpected text content inside .${projectHeaderClass} in ${repositoryRelative(path)}`,
      );
      continue;
    }
    if (ts.isJsxExpression(child)) {
      // `{/* comment */}` carries no expression and places no DOM node.
      assert.equal(
        child.expression,
        undefined,
        `a computed child of .${projectHeaderClass} in ${repositoryRelative(path)} places an unknown number of DOM nodes; this guard cannot derive the child count and must be extended rather than left green`,
      );
      continue;
    }
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) {
      const opening = ts.isJsxElement(child) ? child.openingElement : child;
      const tag = opening.tagName.getText();
      if (isIntrinsicTag(tag)) {
        slots.push({ kind: "always", description: describe(tag, opening) });
        continue;
      }
      if (tag === "Show") {
        slots.push(showSlot(child, path));
        continue;
      }
      assert.fail(
        `<${tag}> is a direct child of .${projectHeaderClass} in ${repositoryRelative(path)} and may place any number of DOM nodes; this guard cannot derive the child count and must be extended rather than left green`,
      );
    }
    assert.fail(
      `an unrecognised child node inside .${projectHeaderClass} in ${repositoryRelative(path)}`,
    );
  }
  return slots;
}

function isIntrinsicTag(tag: string): boolean {
  return /^[a-z][a-z0-9-]*$/u.test(tag);
}

function describe(
  tag: string,
  opening: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): string {
  const className = staticClassAttribute(opening);
  return className === undefined
    ? `<${tag}>`
    : `<${tag} class="${className}">`;
}

/** A `<Show>` places exactly one DOM child. Without a fallback that child
    exists only when the condition holds, so it is a gated slot; with a fallback
    something is always placed, so it is unconditional. Anything else — a
    condition that is not a plain `props.x`, or a branch that is not a single
    element — is underivable and fails. */
function showSlot(
  show: ts.JsxElement | ts.JsxSelfClosingElement,
  path: string,
): ChildSlot {
  const opening = ts.isJsxElement(show) ? show.openingElement : show;
  const where = `${repositoryRelative(path)} (.${projectHeaderClass})`;
  let condition: string | undefined;
  let hasFallback = false;
  for (const attribute of opening.attributes.properties) {
    assert.ok(
      ts.isJsxAttribute(attribute),
      `a spread attribute on <Show> in ${where} makes its condition underivable`,
    );
    const name = attribute.name.getText();
    if (name === "fallback") hasFallback = true;
    if (name !== "when") continue;
    const initializer = attribute.initializer;
    assert.ok(
      initializer !== undefined &&
        ts.isJsxExpression(initializer) &&
        initializer.expression !== undefined &&
        ts.isPropertyAccessExpression(initializer.expression) &&
        ts.isIdentifier(initializer.expression.expression) &&
        initializer.expression.expression.text === "props",
      `<Show when={…}> in ${where} is not a plain \`props.<name>\` condition, so this guard cannot derive whether the visual workbench satisfies it`,
    );
    condition = initializer.expression.name.getText();
  }
  assert.ok(condition !== undefined, `<Show> in ${where} has no when=`);

  const placed = ts.isJsxElement(show)
    ? show.children.filter(
        (child) => !(ts.isJsxText(child) && child.containsOnlyTriviaWhiteSpaces),
      ).length
    : 0;
  assert.equal(
    placed,
    1,
    `<Show when={props.${condition}}> in ${where} has ${placed} branch expressions where this guard can only account for one placed child`,
  );

  return hasFallback
    ? { kind: "always", description: `<Show when={props.${condition}}>` }
    : {
        kind: "gated",
        description: `the child of <Show when={props.${condition}}>`,
        gateProperty: condition,
      };
}

/** Which optional bridge capability decides whether `gateProperty` is supplied.
    Read out of the renderer's own wiring, so a new gate keyed on a new
    capability resolves automatically — and an unresolvable one fails. */
function bridgeCapabilityBehind(
  source: ts.SourceFile,
  gateProperty: string,
  path: string,
): string {
  const capabilities = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText() === gateProperty &&
      node.initializer !== undefined &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression !== undefined
    ) {
      for (const name of optionalBridgeCapabilities(
        node.initializer.expression,
      )) {
        capabilities.add(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.equal(
    capabilities.size,
    1,
    `\`props.${gateProperty}\` gates a Project-header child, but ${repositoryRelative(path)} does not derive it from exactly one optional bridge capability (found ${capabilities.size}: ${[...capabilities].join(", ")}); this guard cannot tell what the visual workbench would have to supply`,
  );
  return [...capabilities][0]!;
}

/** Every `props.bridge.<name> === undefined` branched on anywhere below `root`. */
function optionalBridgeCapabilities(root: ts.Node): ReadonlySet<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    for (const name of bridgeUndefinedChecks(node)) names.add(name);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return names;
}

function bridgeUndefinedChecks(node: ts.Node): readonly string[] {
  if (!ts.isBinaryExpression(node)) return [];
  const operator = node.operatorToken.kind;
  if (
    operator !== ts.SyntaxKind.EqualsEqualsEqualsToken &&
    operator !== ts.SyntaxKind.ExclamationEqualsEqualsToken
  ) {
    return [];
  }
  const undefinedSide =
    ts.isIdentifier(node.right) && node.right.text === "undefined"
      ? node.left
      : ts.isIdentifier(node.left) && node.left.text === "undefined"
        ? node.right
        : undefined;
  if (undefinedSide === undefined) return [];
  if (!ts.isPropertyAccessExpression(undefinedSide)) return [];
  const target = undefinedSide.expression;
  if (!ts.isPropertyAccessExpression(target)) return [];
  if (!ts.isIdentifier(target.expression)) return [];
  if (target.expression.text !== "props") return [];
  if (target.name.getText() !== "bridge") return [];
  return [undefinedSide.name.getText()];
}

/** The capability names the visual workbench's bridge literal actually
    defines. Read from the object literal so a method that is declared in a type
    but never implemented cannot be mistaken for one that is. */
function bridgeCapabilities(path: string): ReadonlySet<string> {
  const source = parseSource(path);
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "bridge" &&
      node.initializer !== undefined
    ) {
      const literal = unwrapObjectLiteral(node.initializer);
      if (literal !== undefined) {
        for (const property of literal.properties) {
          if (property.name === undefined) continue;
          names.add(property.name.getText());
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function unwrapObjectLiteral(
  expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
  let current = expression;
  // `Object.freeze({ … })` and `{ … } satisfies X` both wrap the literal.
  for (let depth = 0; depth < 4; depth += 1) {
    if (ts.isObjectLiteralExpression(current)) return current;
    if (ts.isCallExpression(current) && current.arguments.length === 1) {
      current = current.arguments[0]!;
      continue;
    }
    if (ts.isSatisfiesExpression(current) || ts.isAsExpression(current)) {
      current = current.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(current)) {
      current = current.expression;
      continue;
    }
    return undefined;
  }
  return undefined;
}
