// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser stub - DistributedTable runs server-side only
export class DistributedTable {
	constructor(...args: any[]) {}
}
export { DistributedTableErrors } from './errors.js';
export type {
	DeleteOptions,
	DistributedTableOperation,
	DistributedTableOptions,
	ExternalKmsKeyRef,
	ExternalTableRef,
	KeyCondition,
	PartitionKeyCondition,
	PutOptions,
	QueryOptions,
	ReadValidationMode,
	ScanOptions,
	SortKeyCondition,
	TableKey,
	TableKeyConfig,
} from './types.js';
