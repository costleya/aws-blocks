// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - KVStore runs server-side only
export class KVStore {
	constructor(...args: any[]) {}
}
export { KVStoreErrors } from './errors.js';
export type {
	ConditionalDeleteOptions,
	ConditionalWriteOptions,
	ExternalTableRef,
	KVStoreOperation,
	KVStoreOptions,
	PutOptions,
	ScanOptions,
} from './types.js';
