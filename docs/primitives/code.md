# Code Primitives

Code primitives describe the structure and content of source code. The base JS extractor produces them. Any language plugin produces them too, using the same vocabulary. The point is that everything, core and plugins, writes to a shared schema. I think this shared vocabulary is the most important thing to get right in the whole system, because it's what allows plugins to build on each other's work without tight coupling.

The v1 vocabulary is shaped for JavaScript and TypeScript. The enum values like `scopeKind` are intentionally designed around how JS scoping actually works. Future language plugins may propose additions, but the existing values have to stay meaningful.

---

## Nodes

### `Module`

A unit of code that defines its own top-level scope. One source file = one `Module` node.

| Property | Type | Notes |
|---|---|---|
| `repo` | string | Repository identifier from config |
| `path` | string | Path relative to repo root |
| `language` | string | e.g., `javascript`, `typescript` |
| `dialect` | string | `modern`, `legacy`, `auto`; set by extractor |
| `hash` | string | Content hash (BLAKE3 or SHA-256) |
| `loc` | integer | Lines of code |
| `hasSideEffects` | boolean | Top-level code produces observable effects |
| `isBarrel` | boolean | File's sole purpose is re-exporting other modules |
| `moduleSystem` | string | `commonjs`, `esm`, `amd`, `iife`, `none`, `mixed` |

---

### `Symbol`

A named declaration within a module. Covers functions, classes, variables, and anything else that introduces a name into a scope.

| Property | Type | Notes |
|---|---|---|
| `name` | string | Declared name; synthetic for anonymous symbols (`<anon:42>`) |
| `kind` | string | `function`, `class`, `variable`, `parameter`, `property`, etc. |
| `scopeKind` | string | `function`, `block`, `module`, `global` |
| `isExported` | boolean | Whether the symbol is reachable from outside its module |
| `exportKind` | string | `default`, `named`, `namespace`, or null |
| `isAsync` | boolean | For function-like symbols |
| `isGenerator` | boolean | For function-like symbols |
| `mutability` | string | `const`, `let`, `var`, `readonly`, or null |
| `lineStart` | integer | 1-indexed |
| `lineEnd` | integer | |
| `signature` | string | Normalized signature string for lookup and display |

The `scopeKind` values map directly to how JavaScript scoping works: `var` declarations get `function` scope, `let` and `const` get `block` scope. That specificity is intentional.

---

### `Scope`

An explicit scope region. Created for every function, block, module, and certain special constructs like IIFEs and `with` statements. Scope nodes are what make precise reference resolution possible. Without them, you can find where a name is used but not which declaration it refers to.

| Property | Type | Notes |
|---|---|---|
| `kind` | string | `module`, `function`, `block`, `iife`, `catch`, `with` |
| `lineStart` | integer | |
| `lineEnd` | integer | |
| `isStrict` | boolean | Strict mode in effect |

---

### `Reference`

A usage of a name within code. The counterpart to `Symbol`. Every identifier reference becomes a `Reference` node, linked to the `Symbol` it resolves to when resolution succeeds.

| Property | Type | Notes |
|---|---|---|
| `name` | string | As written in source |
| `bindingKind` | string | `static`, `dynamic`, `computed`: covers `require('./x')`, `require(v)`, `obj[k]` |
| `isRead` | boolean | Referenced value is read |
| `isWrite` | boolean | Referenced value is assigned to |
| `isCall` | boolean | Reference is in call position |
| `line` | integer | |
| `column` | integer | |
| `confidence` | string | `exact`, `inferred`, `heuristic`, `unresolved` |

---

### `CallSite`

A function or method invocation. Distinct from `Reference` because calls have argument shapes and may have multiple resolution candidates. A `Reference` in call position tells you the name was invoked. A `CallSite` tells you the shape of the invocation.

| Property | Type | Notes |
|---|---|---|
| `calleeExpression` | string | Raw callee text (`obj.method`, `retry`, `require('x')`) |
| `argumentCount` | integer | |
| `argumentShapes` | string[] | Inferred shape classifications per argument |
| `isNewExpression` | boolean | `new Foo()` vs `foo()` |
| `line` | integer | |
| `resolutionStatus` | string | `exact`, `inferred`, `heuristic`, `unresolved` |

---

### `DataContainer`

An object or array literal captured as data. Represents structured values passed around in code: configuration objects, function argument bags, exported constants, and so on.

| Property | Type | Notes |
|---|---|---|
| `shape` | string | `object`, `array`, `tuple` |
| `keyNames` | string[] | For object-shaped containers |
| `isFrozen` | boolean | `Object.freeze` was applied |
| `isComputed` | boolean | Contains computed property names |
| `nestingDepth` | integer | |

---

### `LiteralValue`

A classified primitive literal. Strings and templates get classified by content. The extractor tries to identify whether a string looks like a URL, a path, an ARN, SQL, a shell command, etc.

| Property | Type | Notes |
|---|---|---|
| `kind` | string | `string`, `template`, `number`, `boolean`, `null`, `regex` |
| `classifiedAs` | string | `url`, `path`, `sql`, `shell`, `regex`, `arn`, `mime`, `opaque` |
| `classifyConfidence` | number | 0.0 to 1.0 |
| `rawValue` | string | The literal text, truncated if excessively long |
| `interpolations` | integer | Number of `${...}` for template literals |

---

### `Comment`

A first-class node, not a property on the symbol it annotates. This is deliberate. A comment that describes multiple things, a module-level comment, a license header: none of these have a clean one-to-one relationship with a single symbol. Making comments their own nodes keeps them queryable in their own right.

| Property | Type | Notes |
|---|---|---|
| `kind` | string | `line`, `block`, `jsdoc`, `license`, `shebang` |
| `text` | string | Full comment text |
| `lineStart` | integer | |
| `lineEnd` | integer | |
| `hasDocTags` | boolean | Contains at least one structured tag |

---

### `DocAnnotation`

A structured annotation extracted from a JSDoc comment (or equivalent). Each tag becomes its own node. This is what makes documentation queryable at the tag level. You can ask "what functions have a `@deprecated` tag" without parsing comment text.

| Property | Type | Notes |
|---|---|---|
| `tag` | string | e.g., `param`, `returns`, `typedef`, `deprecated`, `throws` |
| `name` | string | e.g., parameter name for `@param` |
| `typeExpression` | string | Raw type expression as written |
| `description` | string | Free-form description text |

---

### `Decorator`

A language-level decorator applied to a symbol. The core extractor captures decorator usage without knowing what each decorator means. That interpretation is a plugin's job. Core just captures the structure.

| Property | Type | Notes |
|---|---|---|
| `name` | string | Decorator name as written |
| `arguments` | string[] | Raw argument expressions |

---

### `ErrorFlow`

A node representing an error-handling construct: `try`/`catch`/`finally`, a `.catch()` call, an error-first callback pattern, a `throw` statement, or a custom error class.

| Property | Type | Notes |
|---|---|---|
| `kind` | string | `try_catch`, `promise_catch`, `callback`, `throw` |
| `errorType` | string | Type name if known, else null |
| `line` | integer | |

---

### `EventBinding`

A generic pub/sub registration detected at the language level. Covers `emitter.on`, `emitter.emit`, DOM events, message handlers: anything with the shape "bind a handler to a named event."

| Property | Type | Notes |
|---|---|---|
| `direction` | string | `subscribe`, `emit` |
| `eventName` | string | Literal name, or `<dynamic>` for computed names |
| `line` | integer | |

---

## Edges

These are the relationships between code nodes. The source and target columns describe what node types are valid on each end.

| Edge | From | To | Properties |
|---|---|---|---|
| `CONTAINS` | Module | Symbol, Scope, Comment | |
| `DEFINES` | Scope | Symbol | |
| `PARENT_SCOPE` | Scope | Scope | |
| `RESOLVES_TO` | Reference | Symbol | `confidence` |
| `CALLS` | CallSite | Symbol | `confidence` |
| `MEMBER_OF` | Symbol | Symbol (class) | |
| `EXTENDS` | Symbol | Symbol | |
| `IMPLEMENTS` | Symbol | Symbol | |
| `IMPORTS` | Module | Module or ExternalPackage | `kind`, `specifiers`, `line` |
| `EXPORTS` | Module | Symbol | `exportName`, `isDefault` |
| `ANNOTATED_BY` | Symbol | Comment | |
| `HAS_TAG` | Comment | DocAnnotation | |
| `DECORATED_BY` | Symbol | Decorator | |
| `HANDLES_ERROR` | Symbol | ErrorFlow | |
| `THROWS` | Symbol | ErrorFlow | |
| `BINDS_EVENT` | Symbol | EventBinding | |
| `MUTATES` | Symbol | Symbol | Parameter mutation tracking |
