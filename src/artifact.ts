// 共享工件工具：只接受普通数据对象，拒绝 Proxy、getter、符号键与危险键。
// 这里只做形状与所有权校验；签发权威始终由各模块自己的过程内注册表决定。
import { types as nodeTypes } from 'node:util';
import { GilError } from './ast.ts';

export const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
export const DANGEROUS_KEYS = ['__proto__', 'constructor', 'prototype'];

export function fail(code: string, message: string): never { throw new GilError(code, message); }

/** 在任何反射之前拒绝 Proxy，确保没有 trap 或 getter 会被执行。 */
export function plainRecord(value: unknown, code: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code, 'Expected a plain object');
  if (nodeTypes.isProxy(value)) fail(code, 'Proxies are not accepted as artifact input');
  const proto = Object.getPrototypeOf(value as object);
  if (proto !== Object.prototype && proto !== null) fail(code, 'Only plain objects are accepted');
  if (Object.getOwnPropertySymbols(value as object).length) fail(code, 'Symbol keys are not accepted');
  return value as Record<string, unknown>;
}

/** 只读自有数据属性；访问器一律拒绝而不是调用。 */
export function readOwn(record: Record<string, unknown>, key: string, code: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return undefined;
  if (!Object.hasOwn(descriptor, 'value')) fail(code, `Property ${key} must be a data property, not a getter`);
  if (!descriptor.enumerable) fail(code, `Property ${key} must be enumerable`);
  return descriptor.value;
}

export function text(record: Record<string, unknown>, key: string, code: string): string {
  const value = readOwn(record, key, code);
  if (typeof value !== 'string' || value.trim().length === 0) fail(code, `${key} must be a non-empty string`);
  return value;
}

/** 非空字符串的独立校验，用于数组元素与参数。 */
export function nonEmpty(value: unknown, code: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) fail(code, `${label} must be a non-empty string`);
  return value;
}

export function finiteNumber(value: unknown, code: string, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(code, `${label} must be a finite number`);
  return value;
}

export function rejectUnknown(record: Record<string, unknown>, allowed: readonly string[], code: string): void {
  for (const key of Object.keys(record)) if (!allowed.includes(key)) fail(code, `Unknown field ${key}`);
}

/** 拒绝非稠密数组：稀疏数组与附加属性都无法内容寻址。 */
export function denseArray(value: unknown, code: string, label: string): unknown[] {
  if (!Array.isArray(value)) fail(code, `${label} must be an array`);
  if (nodeTypes.isProxy(value)) fail(code, 'Proxies are not accepted as artifact input');
  const keys = Object.keys(value);
  if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
    fail(code, `${label} must be a dense array without extra properties`);
  }
  return value as unknown[];
}

export function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
