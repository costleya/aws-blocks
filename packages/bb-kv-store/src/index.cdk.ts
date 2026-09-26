// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ScopeParent } from '@aws-blocks/core';
import {
	BuildingBlockScope,
	getComputeIdentityProvider,
	grantComputeIdentityAccess,
	interpolateIdentityKeyPatternForIam,
	synthGuard,
} from '@aws-blocks/core/cdk';
import { RemovalPolicy } from 'aws-cdk-lib';
import { AttributeType, BillingMode, type ITable, Table } from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { TTL_ATTRIBUTE } from './ttl.js';
import type { ExternalTableRef, KVStoreOperation, KVStoreOptions } from './types.js';

// Re-export public types and errors (no runtime dependencies)
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

export class KVStore extends BuildingBlockScope {
	private table: ITable;

	/**
	 * Reference an existing DynamoDB table instead of provisioning a new one.
	 * Mirrors the same factory exposed by the runtime build so the same code
	 * works in both contexts.
	 */
	static fromExisting(tableName: string): ExternalTableRef {
		return { __brand: 'ExternalTableRef' as const, tableName };
	}

	constructor(scope: ScopeParent, id: string, options?: KVStoreOptions<unknown>) {
		super(id, { parent: scope, vpc: { gatewayEndpoints: [ec2.GatewayVpcEndpointAwsService.DYNAMODB] } });

		if (options?.table) {
			// `fromExisting`: don't provision; bind to the pre-existing table by name
			// and apply this store's ordinary or identity-scoped access grant below.
			this.table = Table.fromTableName(this, 'table', options.table.tableName);
		} else {
			// Resolve durability from the per-block option (a `'destroy'|'retain'`
			// string, normalized to a CDK RemovalPolicy) falling back to the
			// stack-wide `defaults`. The stack `defaults` replace the old
			// `RemovalPolicies.of(stack).destroy()` + `SandboxDisableDeletionProtection`
			// mixin dance — the sandbox posture now flows in through the chosen preset.
			const removalPolicy =
				options?.removalPolicy === 'destroy'
					? RemovalPolicy.DESTROY
					: options?.removalPolicy === 'retain'
						? RemovalPolicy.RETAIN
						: this.defaults.removalPolicy;

			this.table = new Table(this, 'table', {
				tableName: this.fullId.substring(0, 255),
				partitionKey: { name: 'pk', type: AttributeType.STRING },
				billingMode: BillingMode.PAY_PER_REQUEST,
				removalPolicy,
				deletionProtection: options?.deletionProtection ?? this.defaults.deletionProtection,
				// Opt-in: enabling TTL on an already-deployed table is a live table
				// update, so it must never happen implicitly.
				timeToLiveAttribute: options?.ttl ? TTL_ATTRIBUTE : undefined,
			});
		}

		if (getComputeIdentityProvider(this)) {
			for (const grant of options?.identityAccess ?? []) {
				this.grantIdentityAccess(grant);
			}
		} else {
			this.table.grantReadWriteData(this.executionRole);
		}
	}

	private grantIdentityAccess(
		grant: import('@aws-blocks/core/bb-utils').IdentityResourceGrant<KVStoreOperation>,
	): void {
		if (grant.operations.length === 0) {
			throw new Error('Identity resource grants must declare at least one operation.');
		}
		if (grant.operations.includes('scan') && grant.keyPatterns) {
			throw new Error('KVStore scan identity grants cannot declare keyPatterns.');
		}

		const actionByOperation: Record<KVStoreOperation, string> = {
			get: 'dynamodb:GetItem',
			put: 'dynamodb:PutItem',
			delete: 'dynamodb:DeleteItem',
			scan: 'dynamodb:Scan',
		};
		const actions = grant.operations.map((operation) => {
			const action = actionByOperation[operation];
			if (!action) throw new Error(`Unsupported KVStore identity operation: ${operation}`);
			return action;
		});

		grantComputeIdentityAccess(this, grant.access, (role) => {
			role.addToPrincipalPolicy(
				new PolicyStatement({
					actions,
					resources: [this.table.tableArn],
					conditions: grant.keyPatterns
						? {
								'ForAllValues:StringLike': {
									'dynamodb:LeadingKeys': grant.keyPatterns.map(interpolateIdentityKeyPatternForIam),
								},
								Null: { 'dynamodb:LeadingKeys': 'false' },
							}
						: undefined,
				}),
			);
		});
	}

	// ── Runtime methods are not available during CDK synth ────────────────
	// Under `--conditions=cdk` a KVStore resolves to this construct, which only
	// provisions infrastructure. The data methods (get/put/delete/scan) live in
	// the runtime build. Calling them at module top-level (which runs during
	// synth) would otherwise fail with a cryptic `X is not a function`; these
	// stubs turn that into an actionable message.
	get(..._args: unknown[]): never {
		return synthGuard('KVStore', 'get');
	}
	put(..._args: unknown[]): never {
		return synthGuard('KVStore', 'put');
	}
	delete(..._args: unknown[]): never {
		return synthGuard('KVStore', 'delete');
	}
	scan(..._args: unknown[]): never {
		return synthGuard('KVStore', 'scan');
	}
}
