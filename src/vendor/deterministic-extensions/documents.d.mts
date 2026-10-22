// Typings for the vendored documents.mjs (deterministic-extensions core).
// Keep in sync with the revision recorded in provenance.json.

export interface CoreDocument {
  readonly raw: string;
  readonly bom: boolean;
}

export declare const DOCUMENT_LIMITS: Readonly<{ maxBytes: number; maxCodeUnits: number; maxLines: number }>;

/** LF-normalized text for comparison only; the raw document is not modified */
export declare function normalizedText(document: CoreDocument): string;
/** Throws TypeError (code invalid-document) or RangeError (code limit-exceeded) */
export declare function validateDocument(document: CoreDocument): CoreDocument;
export declare function makeDocument(raw?: string, bom?: boolean): CoreDocument;
/** Rejects invalid UTF-8; separates exactly one leading BOM */
export declare function decodeUtf8(bytes: Uint8Array): CoreDocument;
export declare function encodeUtf8(document: CoreDocument): Uint8Array;
export declare function sameDocument(a: CoreDocument, b: CoreDocument): boolean;
