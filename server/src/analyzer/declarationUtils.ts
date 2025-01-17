/*
* declarationUtils.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* Collection of static methods that operate on declarations.
*/

import { Declaration, DeclarationType } from './declaration';

export function isFunctionOrMethodDeclaration(declaration: Declaration) {
    return declaration.type === DeclarationType.Method ||
        declaration.type === DeclarationType.Function;
}

export function hasTypeForDeclaration(declaration: Declaration): boolean {
    switch (declaration.type) {
        case DeclarationType.Intrinsic:
        case DeclarationType.Class:
        case DeclarationType.SpecialBuiltInClass:
        case DeclarationType.Function:
        case DeclarationType.Method:
            return true;

        case DeclarationType.Parameter:
            return !!declaration.node.typeAnnotation;

        case DeclarationType.Variable:
            return !!declaration.typeAnnotationNode;

        case DeclarationType.Alias:
            return false;
    }
}

export function areDeclarationsSame(decl1: Declaration, decl2: Declaration): boolean {
    if (decl1.type !== decl2.type) {
        return false;
    }

    if (decl1.path !== decl2.path) {
        return false;
    }

    if (decl1.range.start.line !== decl2.range.start.line ||
            decl1.range.start.column !== decl2.range.start.column) {
        return false;
    }

    return true;
}
