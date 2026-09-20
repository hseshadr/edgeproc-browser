/** A JSON value: the shape `model_dump(mode="json")` produces. */
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | {
    readonly [key: string]: JsonValue;
};
interface CanonicalOptions {
    /** Top-level keys to drop (mirrors Python `exclude=`), e.g. `{ signature: true }`. */
    readonly exclude?: Readonly<Record<string, true>>;
}
/** Canonical UTF-8 bytes of `obj`, dropping any top-level `exclude` keys. */
export declare function canonicalBytes(obj: JsonValue, options?: CanonicalOptions): Uint8Array;
export {};
//# sourceMappingURL=canonical.d.ts.map