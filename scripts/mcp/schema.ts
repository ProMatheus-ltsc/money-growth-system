/**
 * 录入载荷 schema 校验（COMP-001 / 契约 §2 E_SCHEMA）。
 * 直接读取 config/recorder.schema.json，实现所需 JSON Schema 子集：
 * type/required/properties/additionalProperties/items/enum/pattern/minimum/minItems/minLength/maxLength。
 * 纯函数、无外部依赖，便于单测与门禁。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export interface SchemaIssue {
  field: string;
  message: string;
}

export type SchemaNode = Record<string, unknown>;

const SCHEMA_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../config/recorder.schema.json');

let cachedSchema: SchemaNode | null = null;

export function loadRecorderSchema(): SchemaNode {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')) as SchemaNode;
  }
  return cachedSchema;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesType(value: unknown, declared: unknown): boolean {
  const list = Array.isArray(declared) ? declared : [declared];
  const actual = typeOf(value);
  return list.some((t) => {
    if (t === 'integer') return actual === 'number' && Number.isInteger(value as number);
    if (t === 'number') return actual === 'number';
    return t === actual;
  });
}

function validate(value: unknown, schema: SchemaNode, path: string, issues: SchemaIssue[]): void {
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    issues.push({ field: path || '(root)', message: `类型应为 ${String(schema.type)}，实际 ${typeOf(value)}` });
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ field: path || '(root)', message: `取值必须属于 ${JSON.stringify(schema.enum)}` });
  }
  if (typeof value === 'string') {
    if (typeof schema.pattern === 'string' && !new RegExp(String(schema.pattern)).test(value)) {
      issues.push({ field: path || '(root)', message: `不符合格式 ${String(schema.pattern)}` });
    }
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      issues.push({ field: path || '(root)', message: `长度不能小于 ${schema.minLength}` });
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      issues.push({ field: path || '(root)', message: `长度不能超过 ${schema.maxLength}` });
    }
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    issues.push({ field: path || '(root)', message: `不能小于 ${schema.minimum}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      issues.push({ field: path || '(root)', message: `至少需要 ${schema.minItems} 项` });
    }
    const itemSchema = schema.items as SchemaNode | undefined;
    if (itemSchema) value.forEach((item, i) => validate(item, itemSchema, `${path}[${i}]`, issues));
  }
  if (typeOf(value) === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const required = (schema.required as string[] | undefined) ?? [];
    for (const key of required) {
      if (obj[key] === undefined) issues.push({ field: path ? `${path}.${key}` : key, message: '为必填项' });
    }
    const props = (schema.properties as Record<string, SchemaNode> | undefined) ?? {};
    for (const [key, child] of Object.entries(props)) {
      if (obj[key] !== undefined) validate(obj[key], child, path ? `${path}.${key}` : key, issues);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in props)) issues.push({ field: path ? `${path}.${key}` : key, message: '不允许的字段' });
      }
    }
  }
}

/** 校验录入载荷；返回空数组表示通过 */
export function validateRecorderPayload(payload: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validate(payload, loadRecorderSchema(), '', issues);
  return issues;
}
