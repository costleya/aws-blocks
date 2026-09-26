// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import * as cdk from 'aws-cdk-lib';
import type { IRole } from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';
import type { IdentityAccess } from '../common/identity-access.js';
import type { Scope } from './index.js';

interface IdentityPoolRoles {
	authenticated?: IRole;
	guest?: IRole;
}

const identityPoolRoles = new WeakMap<cdk.Stack, Map<string, IdentityPoolRoles>>();

function getRoles(stack: cdk.Stack): Map<string, IdentityPoolRoles> {
	let roles = identityPoolRoles.get(stack);
	if (!roles) {
		roles = new Map();
		identityPoolRoles.set(stack, roles);
	}
	return roles;
}

/**
 * Bind an Identity Pool's authenticated role to its owning stack.
 *
 * Each pool can bind exactly one role per stack. A duplicate registration is a
 * synth-time error because accepting the later role could grant a Building
 * Block permissions different from the Identity Pool that selected it.
 */
export function registerIdentityPoolRole(scope: Construct, poolFullId: string, role: IRole): void {
	const stack = cdk.Stack.of(scope);
	const roles = getRoles(stack);
	const registered = roles.get(poolFullId) ?? {};
	if (registered.authenticated) {
		throw new Error(`Identity Pool role already registered for "${poolFullId}" in stack "${stack.stackName}".`);
	}
	registered.authenticated = role;
	roles.set(poolFullId, registered);
}

/**
 * Return the authenticated role registered for an Identity Pool in this stack.
 *
 * @throws When the Identity Pool has not registered its role in this stack.
 */
export function getIdentityPoolRole(scope: Construct, poolFullId: string): IRole {
	const stack = cdk.Stack.of(scope);
	const role = getRoles(stack).get(poolFullId)?.authenticated;
	if (!role) {
		throw new Error(
			`No Identity Pool role is registered for "${poolFullId}" in stack "${stack.stackName}". ` +
				'Create the Identity Pool before constructing resources that require its scoped identity.',
		);
	}
	return role;
}

/** Register an Identity Pool's guest role for resources that explicitly grant guest access. */
export function registerIdentityPoolGuestRole(scope: Construct, poolFullId: string, role: IRole): void {
	const stack = cdk.Stack.of(scope);
	const roles = getRoles(stack);
	const registered = roles.get(poolFullId) ?? {};
	if (registered.guest) {
		throw new Error(
			`Identity Pool guest role already registered for "${poolFullId}" in stack "${stack.stackName}".`,
		);
	}
	registered.guest = role;
	roles.set(poolFullId, registered);
}

/** Return the guest role registered for an Identity Pool in this stack. */
export function getIdentityPoolGuestRole(scope: Construct, poolFullId: string): IRole {
	const stack = cdk.Stack.of(scope);
	const role = getRoles(stack).get(poolFullId)?.guest;
	if (!role) {
		throw new Error(`No Identity Pool guest role is registered for "${poolFullId}" in stack "${stack.stackName}".`);
	}
	return role;
}

interface IdentityBoundCompute {
	identityProviderFullId?: string;
	bindIdentityProvider(providerFullId: string): void;
}

function resolveCompute(scope: Scope): IdentityBoundCompute | undefined {
	const candidate = scope as unknown as Partial<IdentityBoundCompute>;
	if (typeof candidate.bindIdentityProvider === 'function') return candidate as IdentityBoundCompute;
	try {
		return scope.compute;
	} catch (error) {
		if (
			error instanceof Error &&
			error.message ===
				'Default compute not initialized — BlocksStack/BlocksBackend.create() must run before resolving `compute`.'
		) {
			// Isolated resource tests and legacy constructs can be synthesized without
			// a Blocks default compute. They are unbound and retain system identity.
			return undefined;
		}
		throw error;
	}
}

/** Bind the resolved compute to an Identity Pool provider. */
export function bindComputeIdentityProvider(scope: Scope, providerFullId: string): void {
	const registered = getRoles(cdk.Stack.of(scope)).get(providerFullId);
	if (!registered?.authenticated && !registered?.guest) {
		throw new Error(
			`No Identity Pool role is registered for "${providerFullId}" in stack "${cdk.Stack.of(scope).stackName}".`,
		);
	}
	const compute = resolveCompute(scope);
	if (!compute) {
		throw new Error(`Cannot bind identity provider "${providerFullId}" because this scope has no compute.`);
	}
	compute.bindIdentityProvider(providerFullId);
}

/** Return the Identity Pool provider bound to this scope's compute, if any. */
export function getComputeIdentityProvider(scope: Scope): string | undefined {
	if (scope.systemIdentity) return undefined;
	return resolveCompute(scope)?.identityProviderFullId;
}

/**
 * Apply one explicit resource grant to the Identity Pool role selected by this
 * scope's compute. Returns false when the compute is unbound or system-marked,
 * so the resource can retain its ordinary execution-role grant.
 */
export function grantComputeIdentityAccess(
	scope: Scope,
	access: IdentityAccess,
	grant: (role: IRole) => void,
): boolean {
	const providerFullId = getComputeIdentityProvider(scope);
	if (!providerFullId) return false;
	grant(
		access === 'authenticated'
			? getIdentityPoolRole(scope, providerFullId)
			: getIdentityPoolGuestRole(scope, providerFullId),
	);
	return true;
}

/** Mark a private framework CDK scope and descendants to retain system identity. */
export function markSystemIdentityScope(scope: Scope): void {
	scope.systemIdentity = true;
}

/**
 * Construct a direct private child with system identity without changing its
 * full ID or permanently marking its parent.
 */
export function withSystemIdentityScope<T>(scope: Scope, callback: () => T): T {
	const systemIdentity = scope.systemIdentity;
	scope.systemIdentity = true;
	try {
		return callback();
	} finally {
		scope.systemIdentity = systemIdentity;
	}
}
