import * as Predicate from "effect/Predicate";
import type * as SchemaAST from "effect/SchemaAST";
import { Tool } from "effect/ai";

type Json = unknown;
type JsonObject = { [key: string]: Json };

const isNullSchema = (value: Json) =>
  Predicate.isObject(value) && value.type === "null" && Object.keys(value).length === 1;

const isBareAnyOf = (value: Json): value is { anyOf: Array<Json> } =>
  Predicate.isObject(value) && Array.isArray(value.anyOf) && Object.keys(value).length === 1;

// A `Schema.fromJsonString` fallback. Advertised beside object shapes, it invites stringified input.
const isJsonStringSchema = (value: Json) =>
  Predicate.isObject(value) &&
  value.type === "string" &&
  value.contentMediaType === "application/json";

const SAFE_INTEGER_BOUNDS: Record<string, number> = {
  maximum: Number.MAX_SAFE_INTEGER,
  minimum: Number.MIN_SAFE_INTEGER,
};

const tagOf = (branch: JsonObject, key: string): Json => {
  const property = Predicate.isObject(branch.properties) ? branch.properties[key] : undefined;
  return Predicate.isObject(property) && Array.isArray(property.enum) && property.enum.length === 1
    ? property.enum[0]
    : undefined;
};

/** One object for a tagged union of objects: each property once, the tag listing every value. */
const mergeTaggedObjects = (branches: ReadonlyArray<Json>): JsonObject | undefined => {
  if (branches.length < 2) return undefined;
  const objects = branches.filter(
    (branch): branch is JsonObject & { properties: JsonObject } =>
      Predicate.isObject(branch) &&
      branch.type === "object" &&
      Predicate.isObject(branch.properties),
  );
  if (objects.length !== branches.length) return undefined;
  const tag = Object.keys(objects[0]!.properties).find((key) => {
    const values = objects.map((object) => tagOf(object, key));
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
  if (tag === undefined) return undefined;
  const properties: JsonObject = {
    [tag]: { type: "string", enum: objects.map((object) => tagOf(object, tag)) },
  };
  for (const object of objects) {
    for (const [name, property] of Object.entries(object.properties)) {
      if (name === tag) continue;
      const seen = properties[name];
      if (seen === undefined) properties[name] = property;
      else if (JSON.stringify(seen) !== JSON.stringify(property)) {
        const options = Predicate.isObject(seen) && isBareAnyOf(seen) ? seen.anyOf : [seen];
        if (!options.some((option) => JSON.stringify(option) === JSON.stringify(property)))
          properties[name] = { anyOf: [...options, property] };
      }
    }
  }
  const [first = [], ...others] = objects.map((object) =>
    Array.isArray(object.required) ? object.required : [],
  );
  const requiredByAll = first.filter(
    (name) => name !== tag && others.every((required) => required.includes(name)),
  );
  return { type: "object", properties, required: [tag, ...requiredByAll] };
};

const sourceProperty = (
  source: SchemaAST.AST | undefined,
  name: string,
): SchemaAST.AST | undefined => {
  if (source?._tag === "Objects")
    return source.propertySignatures.find((property) => property.name === name)?.type;
  if (source?._tag === "Union")
    return source.types
      .map((type) => sourceProperty(type, name))
      .find((type) => type !== undefined);
  return undefined;
};
const explicitlyNullable = (source: SchemaAST.AST | undefined): boolean =>
  source?._tag === "Null" || (source?._tag === "Union" && source.types.some(explicitlyNullable));

const compact = (schema: Json, optional: boolean, source?: SchemaAST.AST): Json => {
  if (Array.isArray(schema)) return schema.map((item) => compact(item, false));
  if (!Predicate.isObject(schema)) return schema;
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  let result: JsonObject = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "additionalProperties" && value === true) continue;
    if (SAFE_INTEGER_BOUNDS[key] === value) continue;
    result[key] =
      key === "properties" && Predicate.isObject(value)
        ? Object.fromEntries(
            Object.entries(value).map(([name, property]) => [
              name,
              compact(property, !required.has(name), sourceProperty(source, name)),
            ]),
          )
        : compact(value, false);
  }
  if (Array.isArray(result.anyOf)) {
    const branches = result.anyOf
      .flatMap((branch) => (isBareAnyOf(branch) ? branch.anyOf : [branch]))
      .filter(
        (branch) =>
          !(optional && isNullSchema(branch) && !explicitlyNullable(source)) &&
          !isJsonStringSchema(branch),
      );
    const nonNull = branches.filter((branch) => !isNullSchema(branch));
    const merged = mergeTaggedObjects(nonNull);
    const distinct = [
      ...(merged === undefined ? nonNull : [merged]),
      ...(branches.some(isNullSchema) ? [{ type: "null" }] : []),
    ];
    const { anyOf: _anyOf, ...rest } = result;
    const only = distinct.length === 1 ? distinct[0] : undefined;
    result = Predicate.isObject(only) ? { ...only, ...rest } : { ...rest, anyOf: distinct };
  }
  return result;
};

/**
 * Compact advertised schemas keep explicit null clears, but omit synthesized optional nulls.
 * Tagged object unions merge for display; decoding still enforces each tag's required fields.
 */
export const advertisedJsonSchema = (tool: Tool.Any) =>
  compact(Tool.getJsonSchema(tool), false, tool.parametersSchema.ast) as ReturnType<
    typeof Tool.getJsonSchema
  >;
