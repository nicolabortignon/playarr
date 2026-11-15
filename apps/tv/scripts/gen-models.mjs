#!/usr/bin/env node
// TypeScript API types → Kotlin models for the TV app (`make -C apps/tv models`), as apps/ios/scripts/gen-models.mjs
// makes the Swift ones, from the same JSON Schema (scripts/api-schema.mjs). The output is committed; `--check` fails
// when it is out of date (CI).
//
// Rules (docs/tv/README.md), the Swift ones in Kotlin:
// - interface / object type → @Serializable data class (a class when it has no properties).
// - optional property → `T? = null` (left out when null); `T | null` → `T?` (sent as null); optional and nullable →
//   `T? = null` (Kotlin can't tell a missing value from a null one: the TV sends no patch bodies that need it).
// - string literal union → a value class over the string, its known values as constants, so a value added on the
//   server decodes (Swift's `case unknown(String)`).
// - numeric literal union → Int.
// - number → Double, except ids, counts and the integers listed in api-schema.mjs → Int, and byte counts and
//   timestamps among them → Long.
// - Record<string, T> → Map<String, T>; arrays and tuples → List<T>.
// - union of objects tagged by one string property (TransitionAnswer.status) → sealed interface, a data class per
//   tag and `Unknown` for a tag this version doesn't know.
// - inline object types → nested classes named after the property (+ "Item" inside arrays).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  camel, isIntegerName, isNumberEnum, isObject, isRecord, isStringEnum, loadDefinitions, mixMapVersion, pascal, refName, splitNull, tagOf, trimEnd,
} from '../../../scripts/api-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = 'me.tracklistme.playarr.api';
const OUTPUT = resolve(here, `../api/src/main/kotlin/${PACKAGE.replaceAll('.', '/')}/Models.generated.kt`);
/** Whole numbers that can pass 2³¹: byte counts and times in milliseconds. */
const LONGS = new Set(['freeSpace', 'heapTotalBytes', 'heapUsedBytes', 'lastCheck', 'lastUpdate', 'rssBytes', 'size', 'sizeBytes']);
const KEYWORDS = new Set([
  'as', 'break', 'class', 'continue', 'do', 'else', 'false', 'for', 'fun', 'if', 'in', 'interface', 'is', 'null', 'object',
  'package', 'return', 'super', 'this', 'throw', 'true', 'try', 'typealias', 'typeof', 'val', 'var', 'when', 'while',
]);

const ident = (name) => (KEYWORDS.has(name) ? `\`${name}\`` : name);
/** A property's Kotlin name: the JSON key when it's a plain identifier, else camelCased (and @SerialName keeps the key). */
const propName = (key) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? ident(key) : ident(camel(key)));
/** A known value's constant: PascalCase, prefixed when it would start with a digit. */
const constantName = (value) => {
  const name = pascal(value);
  return /^[0-9]/.test(name) ? `V${name}` : name || 'Empty';
};
/** A Kotlin string literal. */
const literal = (value) => JSON.stringify(value).replaceAll('$', '\\$');

/** KDoc lines; `/*` and `*\/` inside would open or close a comment. */
function docLines(description, indent) {
  if (!description) return [];
  const lines = description.replaceAll('*/', '*&#47;').replaceAll('/*', '/&#42;').split('\n');
  return [`${indent}/**`, ...lines.map((line) => `${indent} * ${line}`.trimEnd()), `${indent} */`];
}

/** Kotlin source for every definition. */
function emitKotlin(definitions) {
  const out = [];
  const names = Object.keys(definitions).sort();

  /** A nested type's name, which mustn't hide a top-level type inside its parent. */
  const nestedName = (name) => {
    const typeName = pascal(name);
    if (definitions[typeName]) throw new Error(`The nested type ${typeName} would hide the top-level ${typeName}: rename the property`);
    return typeName;
  };

  /** Kotlin type for `schema`; nested declarations it needs go into `nested`. */
  function typeOf(schema, name, prop, nested, indent) {
    const ref = refName(schema);
    if (ref) return ref;
    if (schema.anyOf && tagOf(schema)) {
      const typeName = nestedName(name);
      nested.push(...emitTaggedUnion(typeName, schema, indent));
      return typeName;
    }
    if (schema.anyOf) throw new Error(`${prop}: unions other than tagged objects and null aren't supported`);
    if (isStringEnum(schema)) {
      const typeName = nestedName(name);
      nested.push(...emitEnum(typeName, schema, indent));
      return typeName;
    }
    if (isNumberEnum(schema)) return 'Int';
    if (schema.const === true || schema.const === false) return 'Boolean';
    switch (Array.isArray(schema.type) ? 'mixed' : schema.type) {
      case 'string':
        return 'String';
      case 'boolean':
        return 'Boolean';
      case 'number':
      case 'integer':
        return LONGS.has(prop) ? 'Long' : isIntegerName(prop) ? 'Int' : 'Double';
      case 'array': {
        const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
        const { schema: item, nullable } = splitNull(items);
        const element = typeOf(item, `${name}Item`, prop, nested, indent);
        return `List<${element}${nullable ? '?' : ''}>`;
      }
      case 'object': {
        if (isRecord(schema)) return `Map<String, ${typeOf(schema.additionalProperties, `${name}Value`, prop, nested, indent)}>`;
        const typeName = nestedName(name);
        nested.push(...emitClass(typeName, schema, indent));
        return typeName;
      }
      default:
        throw new Error(`${prop}: can't map ${JSON.stringify(schema)}`);
    }
  }

  /** A data class; `tag` (a tagged union's variant) is the tag property, kept last with its value as the default. */
  function emitClass(typeName, schema, indent, variant) {
    const inner = `${indent}    `;
    const nested = [];
    const fields = [];
    const required = new Set(schema.required ?? []);
    for (const [key, raw] of Object.entries(schema.properties ?? {})) {
      if (key === variant?.tag) continue;
      const { schema: s, nullable } = splitNull(raw);
      const base = typeOf({ ...s, description: undefined }, key, key, nested, inner);
      const optional = !required.has(key);
      fields.push({ key, name: propName(key), type: optional || nullable ? `${base}?` : base, description: raw.description, optional });
    }
    const lines = [...docLines(schema.description, indent), `${indent}@Serializable`];
    const parent = variant ? ` : ${variant.parent}` : '';
    if (!fields.length && !variant) {
      lines.push(`${indent}public class ${typeName}${nested.length ? ' {' : ''}`);
    } else {
      lines.push(`${indent}public data class ${typeName}(`);
      for (const f of fields) {
        lines.push(...docLines(f.description, inner));
        const serialName = f.name.replaceAll('`', '') !== f.key ? `@SerialName(${literal(f.key)}) ` : '';
        lines.push(`${inner}${serialName}public val ${f.name}: ${f.type}${f.optional ? ' = null' : ''},`);
      }
      if (variant) lines.push(`${inner}@EncodeDefault override val ${ident(variant.tag)}: String = ${literal(variant.value)},`);
      lines.push(`${indent})${parent}${nested.length ? ' {' : ''}`);
    }
    if (nested.length) lines.push(...trimEnd(nested), `${indent}}`);
    lines.push('');
    return lines;
  }

  function emitEnum(typeName, schema, indent) {
    const inner = `${indent}    `;
    const values = schema.enum.map((value) => ({ value, name: constantName(value) }));
    const seen = new Set();
    for (const v of values) {
      if (seen.has(v.name)) throw new Error(`${typeName}: two values make the constant ${v.name}`);
      seen.add(v.name);
    }
    return [
      ...docLines(schema.description, indent),
      `${indent}@Serializable`,
      `${indent}@JvmInline`,
      `${indent}public value class ${typeName}(public val value: String) {`,
      `${inner}/** One of the values this version of the app knows. */`,
      `${inner}public val isKnown: Boolean get() = this in entries`,
      '',
      `${inner}override fun toString(): String = value`,
      '',
      `${inner}public companion object {`,
      ...values.map((v) => `${inner}    public val ${v.name}: ${typeName} = ${typeName}(${literal(v.value)})`),
      `${inner}    public val entries: List<${typeName}> = listOf(${values.map((v) => v.name).join(', ')})`,
      `${inner}}`,
      `${indent}}`,
      '',
    ];
  }

  function emitTaggedUnion(typeName, schema, indent) {
    const inner = `${indent}    `;
    const tag = tagOf(schema);
    const variants = schema.anyOf.map((o) => ({ value: o.properties[tag].const, schema: o, type: pascal(o.properties[tag].const) }));
    if (variants.some((v) => v.type === 'Unknown' || v.type === 'ByTag')) throw new Error(`${typeName}: a tag named Unknown or ByTag`);
    const lines = [
      ...docLines(schema.description, indent),
      `${indent}@Serializable(with = ${typeName}.ByTag::class)`,
      `${indent}public sealed interface ${typeName} {`,
      `${inner}public val ${ident(tag)}: String`,
      '',
    ];
    for (const v of variants) lines.push(...emitClass(v.type, v.schema, inner, { tag, value: v.value, parent: typeName }));
    lines.push(
      `${inner}/** A \`${tag}\` this version of the app doesn't know yet. */`,
      `${inner}@Serializable`,
      `${inner}public data class Unknown(override val ${ident(tag)}: String) : ${typeName}`,
      '',
      `${inner}/** Picks the variant by \`${tag}\`. */`,
      `${inner}public object ByTag : JsonContentPolymorphicSerializer<${typeName}>(${typeName}::class) {`,
      `${inner}    override fun selectDeserializer(element: JsonElement): DeserializationStrategy<${typeName}> =`,
      `${inner}        when ((element as? JsonObject)?.get(${literal(tag)})?.let { (it as? JsonPrimitive)?.contentOrNull }) {`,
      ...variants.map((v) => `${inner}            ${literal(v.value)} -> ${v.type}.serializer()`),
      `${inner}            else -> Unknown.serializer()`,
      `${inner}        }`,
      `${inner}}`,
      `${indent}}`,
      '',
    );
    return lines;
  }

  for (const name of names) {
    const def = definitions[name];
    if (def.anyOf && tagOf(def)) out.push(...emitTaggedUnion(name, def, ''));
    else if (isStringEnum(def)) out.push(...emitEnum(name, def, ''));
    else if (isObject(def) || (def.type === 'object' && !isRecord(def))) out.push(...emitClass(name, def, ''));
    else {
      const nested = [];
      const type = typeOf(def, name, name, nested, '');
      out.push(...docLines(def.description, ''), `public typealias ${name} = ${type}`, '', ...nested);
    }
  }
  return out;
}

function render() {
  return [
    '// Generated by apps/tv/scripts/gen-models.mjs from packages/shared and packages/mix. Do not edit:',
    '// change the TypeScript types and run `make -C apps/tv models`.',
    '@file:OptIn(ExperimentalSerializationApi::class)',
    '@file:Suppress("unused", "RedundantVisibilityModifier")',
    '',
    `package ${PACKAGE}`,
    '',
    'import kotlin.jvm.JvmInline',
    'import kotlinx.serialization.DeserializationStrategy',
    'import kotlinx.serialization.EncodeDefault',
    'import kotlinx.serialization.ExperimentalSerializationApi',
    'import kotlinx.serialization.SerialName',
    'import kotlinx.serialization.Serializable',
    'import kotlinx.serialization.json.JsonContentPolymorphicSerializer',
    'import kotlinx.serialization.json.JsonElement',
    'import kotlinx.serialization.json.JsonObject',
    'import kotlinx.serialization.json.JsonPrimitive',
    'import kotlinx.serialization.json.contentOrNull',
    '',
    '/** Mix maps stored with an older version are measured again (packages/mix MIX_MAP_VERSION). */',
    `public const val MIX_MAP_VERSION: Int = ${mixMapVersion()}`,
    '',
    ...emitKotlin(loadDefinitions()),
  ]
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n*$/, '\n');
}

const kotlin = render();
if (process.argv.includes('--check')) {
  const current = existsSync(OUTPUT) ? readFileSync(OUTPUT, 'utf8') : '';
  if (current !== kotlin) {
    console.error('Models.generated.kt is out of date: run `make -C apps/tv models` and commit it.');
    process.exit(1);
  }
  console.log('Models.generated.kt is up to date.');
} else {
  writeFileSync(OUTPUT, kotlin);
  console.log(`Wrote ${OUTPUT}`);
}
