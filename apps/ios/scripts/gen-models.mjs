#!/usr/bin/env node
// TypeScript API types → Swift Codable models (`pnpm ios:models`).
//
// ts-json-schema-generator reads the shared TypeScript types into JSON Schema; the emitter below turns
// that schema into Swift. The output is committed; `--check` fails when it is out of date (CI).
//
// Rules (docs/ios/README.md):
// - interface / object type → struct (Codable, Hashable, Sendable; Identifiable when it has `id`).
// - optional property → `T?`; `T | null` → `T?`; optional and nullable → `T??` (nil leaves it out,
//   .some(nil) sends null, as patch bodies need).
// - string literal union → enum with `case unknown(String)`, so a value added on the server decodes.
// - numeric literal union → Int.
// - number → Double, except ids, counts and the INTEGERS below → Int (SQLite integers on the server).
// - Record<string, T> → [String: T]; arrays → [T]; tuples → [T].
// - union of objects tagged by one string property (TransitionAnswer.status) → enum with associated
//   values and `case unknown(String)`.
// - inline object types → nested structs named after the property (+ "Item" inside arrays).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const INPUTS = ['packages/shared/src/index.ts', 'packages/mix/src/types.ts'];
const OUTPUT = resolve(here, '../Packages/PlayarrAPI/Sources/PlayarrAPI/Models.generated.swift');
/** Exported, but not part of the API. */
const SKIP = new Set(['parseRange', 'ByteRange', 'wavFallbackOf']);
/** Numbers that are whole: what the server stores as SQLite integers or counts. */
const INTEGERS = new Set([
  'albums', 'albumsComplete', 'albumsIncomplete', 'albumsUnknown', 'analyzed', 'artists', 'audioFiles', 'background', 'batchId', 'beatModel', 'bits', 'channels',
  'currentStreak', 'days', 'decadeMixes', 'disc', 'discNumber', 'earlier', 'era', 'failed', 'files', 'freeSpace', 'genreMixes',
  'have', 'hour', 'ignored', 'lastCheck', 'lastUpdate', 'longestStreak', 'loudnessWaiting', 'loudnessWorking', 'matches',
  'matched', 'matching', 'moved', 'newArtists', 'pending', 'plays', 'playlists', 'port', 'position', 'profile', 'queued', 'ready',
  'recorded', 'restored', 'review', 'sampleRate', 'sent', 'size', 'sizeBytes', 'songs', 'songsComplete', 'songsIncomplete', 'songsUnknown', 'sources',
  'tagsWaiting', 'total', 'trackNumber', 'trackTotal', 'tracks', 'variant', 'version', 'waiting', 'weekday',
  'working', 'year', 'years',
]);
const isIntegerName = (name) => name === 'id' || /(Id|Ids|Count)$/.test(name) || INTEGERS.has(name);
const KEYWORDS = new Set([
  'associatedtype', 'class', 'deinit', 'enum', 'extension', 'func', 'import', 'init', 'inout', 'internal', 'let',
  'operator', 'private', 'protocol', 'public', 'static', 'struct', 'subscript', 'typealias', 'var', 'break',
  'case', 'continue', 'default', 'defer', 'do', 'else', 'fallthrough', 'for', 'guard', 'if', 'in', 'repeat',
  'return', 'switch', 'where', 'while', 'as', 'catch', 'false', 'is', 'nil', 'rethrows', 'super', 'self',
  'Self', 'throw', 'throws', 'true', 'try', 'Type', 'Protocol', 'any', 'some',
]);

function loadDefinitions() {
  const definitions = {};
  for (const input of INPUTS) {
    const schema = createGenerator({
      path: resolve(root, input),
      type: '*',
      expose: 'export',
      topRef: true,
      jsDoc: 'extended',
      skipTypeCheck: true,
      additionalProperties: false,
    }).createSchema('*');
    for (const [name, def] of Object.entries(schema.definitions ?? {})) {
      if (SKIP.has(name)) continue;
      if (definitions[name]) throw new Error(`${name} is exported by two inputs`);
      definitions[name] = def;
    }
  }
  return definitions;
}

const pascal = (s) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_, __, c) => c.toUpperCase());
const camel = (s) => {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
};
const ident = (name) => (KEYWORDS.has(name) ? `\`${name}\`` : name);
const caseName = (value) => {
  if (value === 'none') return 'noneValue'; // `.none` would be read as Optional.none
  if (value === 'unknown') throw new Error('"unknown" is the fallback case name');
  return ident(camel(value));
};
const refName = (schema) => schema.$ref?.replace('#/definitions/', '');
const trimEnd = (lines) => {
  while (lines.at(-1) === '') lines.pop();
  return lines;
};
const nonNull = (types) => (Array.isArray(types) ? types.filter((t) => t !== 'null') : [types]);

/** Strips `null` from a schema: { schema, nullable }. */
function splitNull(schema) {
  if (Array.isArray(schema.type) && schema.type.includes('null')) {
    const rest = nonNull(schema.type);
    return { schema: { ...schema, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  const options = schema.anyOf;
  if (options?.some((o) => o.type === 'null')) {
    const rest = options.filter((o) => o.type !== 'null');
    return { schema: rest.length === 1 ? { ...rest[0], description: schema.description } : { ...schema, anyOf: rest }, nullable: true };
  }
  return { schema, nullable: false };
}

const isStringEnum = (s) => s.type === 'string' && Array.isArray(s.enum);
const isNumberEnum = (s) => s.type === 'number' && Array.isArray(s.enum);
const isObject = (s) => s.type === 'object' && s.properties;
const isRecord = (s) => s.type === 'object' && !s.properties && typeof s.additionalProperties === 'object';
const tagOf = (s) => {
  const options = s.anyOf;
  if (!options?.length || !options.every(isObject)) return undefined;
  const tag = Object.keys(options[0].properties).find((key) => options.every((o) => typeof o.properties[key]?.const === 'string'));
  return tag;
};

function docLines(description, indent) {
  if (!description) return [];
  return description.split('\n').map((line) => `${indent}/// ${line}`.trimEnd());
}

/** Swift source for every definition. */
function emitSwift(definitions) {
  const out = [];
  const names = Object.keys(definitions).sort();

  /** A nested type's name, which mustn't hide a top-level type inside its parent. */
  const nestedName = (name) => {
    const typeName = pascal(name);
    if (definitions[typeName]) throw new Error(`The nested type ${typeName} would hide the top-level ${typeName}: rename the property`);
    return typeName;
  };

  /** Swift type for `schema`; nested declarations it needs go into `nested`. */
  function typeOf(schema, name, propName, nested, indent) {
    const ref = refName(schema);
    if (ref) return ref;
    if (schema.anyOf && tagOf(schema)) {
      const typeName = nestedName(name);
      nested.push(...emitTaggedUnion(typeName, schema, indent));
      return typeName;
    }
    if (schema.anyOf) throw new Error(`${propName}: unions other than tagged objects and null aren't supported`);
    if (isStringEnum(schema)) {
      const typeName = nestedName(name);
      nested.push(...emitEnum(typeName, schema, indent));
      return typeName;
    }
    if (isNumberEnum(schema)) return 'Int';
    if (schema.const === true || schema.const === false) return 'Bool';
    switch (Array.isArray(schema.type) ? 'mixed' : schema.type) {
      case 'string':
        return 'String';
      case 'boolean':
        return 'Bool';
      case 'number':
      case 'integer':
        return isIntegerName(propName) ? 'Int' : 'Double';
      case 'array': {
        const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
        const { schema: item, nullable } = splitNull(items);
        const element = typeOf(item, `${name}Item`, propName, nested, indent);
        return `[${element}${nullable ? '?' : ''}]`;
      }
      case 'object': {
        if (isRecord(schema)) return `[String: ${typeOf(schema.additionalProperties, `${name}Value`, propName, nested, indent)}]`;
        const typeName = nestedName(name);
        nested.push(...emitStruct(typeName, schema, indent));
        return typeName;
      }
      default:
        throw new Error(`${propName}: can't map ${JSON.stringify(schema)}`);
    }
  }

  function emitStruct(typeName, schema, indent, skip) {
    const inner = `${indent}    `;
    const nested = [];
    const fields = [];
    const required = new Set(schema.required ?? []);
    for (const [prop, raw] of Object.entries(schema.properties ?? {})) {
      if (prop === skip) continue;
      const { schema: s, nullable } = splitNull(raw);
      const base = typeOf({ ...s, description: undefined }, prop, prop, nested, inner);
      const optional = !required.has(prop);
      const type = optional && nullable ? `${base}??` : optional || nullable ? `${base}?` : base;
      fields.push({ prop, type, description: raw.description, explicitNull: nullable && !optional, defaulted: optional });
    }
    const conformances = ['Codable', 'Hashable', 'Sendable'];
    if (fields.some((f) => f.prop === 'id' && !f.type.endsWith('?'))) conformances.push('Identifiable');
    const lines = [...docLines(schema.description, indent), `${indent}public struct ${typeName}: ${conformances.join(', ')} {`];
    for (const f of fields) lines.push(...docLines(f.description, inner), `${inner}public var ${ident(f.prop)}: ${f.type}`);
    if (fields.length) lines.push('');
    const params = fields.map((f) => `${ident(f.prop)}: ${f.type}${f.defaulted ? ' = nil' : ''}`).join(', ');
    lines.push(`${inner}public init(${params}) {`);
    for (const f of fields) lines.push(`${inner}    self.${ident(f.prop)} = ${ident(f.prop)}`);
    lines.push(`${inner}}`);
    if (fields.some((f) => f.explicitNull)) {
      // Required but nullable (Account.sources): null is a value the server reads, so it's sent.
      lines.push('', `${inner}public func encode(to encoder: any Encoder) throws {`, `${inner}    var container = encoder.container(keyedBy: CodingKeys.self)`);
      for (const f of fields) {
        const method = f.explicitNull || !f.type.endsWith('?') ? 'encode' : 'encodeIfPresent';
        lines.push(`${inner}    try container.${method}(${ident(f.prop)}, forKey: .${ident(f.prop)})`);
      }
      lines.push(`${inner}}`);
    }
    if (nested.length) lines.push('', ...trimEnd(nested));
    lines.push(`${indent}}`, '');
    return lines;
  }

  function emitEnum(typeName, schema, indent) {
    const inner = `${indent}    `;
    const cases = schema.enum.map((value) => ({ value, name: caseName(value) }));
    return [
      ...docLines(schema.description, indent),
      `${indent}public enum ${typeName}: RawRepresentable, Codable, Hashable, Sendable, CaseIterable {`,
      ...cases.map((c) => `${inner}case ${c.name}`),
      `${inner}/// A value this version of the app doesn't know yet.`,
      `${inner}case unknown(String)`,
      '',
      `${inner}public static let allCases: [${typeName}] = [${cases.map((c) => `.${c.name}`).join(', ')}]`,
      '',
      `${inner}public init(rawValue: String) {`,
      `${inner}    switch rawValue {`,
      ...cases.map((c) => `${inner}    case ${JSON.stringify(c.value)}: self = .${c.name}`),
      `${inner}    default: self = .unknown(rawValue)`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public var rawValue: String {`,
      `${inner}    switch self {`,
      ...cases.map((c) => `${inner}    case .${c.name}: ${JSON.stringify(c.value)}`),
      `${inner}    case .unknown(let value): value`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public init(from decoder: any Decoder) throws {`,
      `${inner}    self.init(rawValue: try decoder.singleValueContainer().decode(String.self))`,
      `${inner}}`,
      '',
      `${inner}public func encode(to encoder: any Encoder) throws {`,
      `${inner}    var container = encoder.singleValueContainer()`,
      `${inner}    try container.encode(rawValue)`,
      `${inner}}`,
      `${indent}}`,
      '',
    ];
  }

  function emitTaggedUnion(typeName, schema, indent) {
    const inner = `${indent}    `;
    const tag = tagOf(schema);
    const variants = schema.anyOf.map((o) => ({ value: o.properties[tag].const, schema: o }));
    variants.forEach((v) => (v.name = caseName(v.value)));
    variants.forEach((v) => (v.type = pascal(v.value)));
    const lines = [
      ...docLines(schema.description, indent),
      `${indent}public enum ${typeName}: Codable, Hashable, Sendable {`,
      ...variants.map((v) => `${inner}case ${v.name}(${v.type})`),
      `${inner}/// A \`${tag}\` this version of the app doesn't know yet.`,
      `${inner}case unknown(String)`,
      '',
      `${inner}private enum TagKey: String, CodingKey { case ${ident(tag)} = ${JSON.stringify(tag)} }`,
      '',
      `${inner}public var ${ident(tag)}: String {`,
      `${inner}    switch self {`,
      ...variants.map((v) => `${inner}    case .${v.name}: ${JSON.stringify(v.value)}`),
      `${inner}    case .unknown(let value): value`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public init(from decoder: any Decoder) throws {`,
      `${inner}    let tag = try decoder.container(keyedBy: TagKey.self).decode(String.self, forKey: .${ident(tag)})`,
      `${inner}    switch tag {`,
      ...variants.map((v) => `${inner}    case ${JSON.stringify(v.value)}: self = .${v.name}(try ${v.type}(from: decoder))`),
      `${inner}    default: self = .unknown(tag)`,
      `${inner}    }`,
      `${inner}}`,
      '',
      `${inner}public func encode(to encoder: any Encoder) throws {`,
      `${inner}    switch self {`,
      ...variants.map((v) => `${inner}    case .${v.name}(let value): try value.encode(to: encoder)`),
      `${inner}    case .unknown: break`,
      `${inner}    }`,
      `${inner}    var container = encoder.container(keyedBy: TagKey.self)`,
      `${inner}    try container.encode(${ident(tag)}, forKey: .${ident(tag)})`,
      `${inner}}`,
      '',
    ];
    for (const v of variants) lines.push(...emitStruct(v.type, v.schema, inner, tag));
    trimEnd(lines);
    lines.push(`${indent}}`, '');
    return lines;
  }

  for (const name of names) {
    const def = definitions[name];
    if (def.anyOf && tagOf(def)) out.push(...emitTaggedUnion(name, def, ''));
    else if (isStringEnum(def)) out.push(...emitEnum(name, def, ''));
    else if (isObject(def) || (def.type === 'object' && !isRecord(def))) out.push(...emitStruct(name, def, ''));
    else {
      const nested = [];
      const type = typeOf(def, name, name, nested, '');
      out.push(...docLines(def.description, ''), `public typealias ${name} = ${type}`, '', ...nested);
    }
  }
  return out;
}

/** The MIX_MAP_VERSION constant, which JSON Schema doesn't carry. */
function mixMapVersion() {
  const match = /export const MIX_MAP_VERSION = (\d+);/.exec(readFileSync(resolve(root, 'packages/mix/src/types.ts'), 'utf8'));
  if (!match) throw new Error('MIX_MAP_VERSION not found in packages/mix/src/types.ts');
  return Number(match[1]);
}

function render() {
  return [
    '// Generated by apps/ios/scripts/gen-models.mjs from packages/shared and packages/mix. Do not edit:',
    '// change the TypeScript types and run `pnpm ios:models`.',
    '',
    '/// Mix maps stored with an older version are measured again (packages/mix MIX_MAP_VERSION).',
    `public let mixMapVersion = ${mixMapVersion()}`,
    '',
    ...emitSwift(loadDefinitions()),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}

const swift = render();
if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== swift) {
    console.error('Models.generated.swift is out of date: run `pnpm ios:models` and commit it.');
    process.exit(1);
  }
  console.log('Models.generated.swift is up to date.');
} else {
  writeFileSync(OUTPUT, swift);
  console.log(`Wrote ${OUTPUT}`);
}
