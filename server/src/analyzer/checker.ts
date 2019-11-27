/*
* checker.ts
* Copyright (c) Microsoft Corporation.
* Licensed under the MIT license.
* Author: Eric Traut
*
* A parse tree walker that performs static type checking for
* a source file. Most of its work is performed by the type
* evaluator, but this module touches every node in the file
* to ensure that all statements and expressions are evaluated
* and checked. It also performs some additional checks that
* cannot (or should not be) performed lazily.
*/

import * as assert from 'assert';

import { DiagnosticLevel } from '../common/configOptions';
import { Diagnostic, DiagnosticAddendum } from '../common/diagnostic';
import { DiagnosticRule } from '../common/diagnosticRules';
import { TextRange } from '../common/textRange';
import { AssertNode, AssignmentExpressionNode, AssignmentNode, AugmentedAssignmentNode,
    BinaryOperationNode, CallNode, ClassNode, DelNode, ErrorNode, ExceptNode, ExpressionNode,
    FormatStringNode, ForNode, FunctionNode, IfNode, ImportAsNode, ImportFromNode, IndexNode,
    LambdaNode, ListComprehensionNode, MemberAccessNode, ModuleNode, NameNode, ParameterCategory,
    ParseNode, ParseNodeType, RaiseNode, ReturnNode, SliceNode, StringListNode, SuiteNode,
    TernaryNode, TupleNode, TypeAnnotationNode, UnaryOperationNode, UnpackNode, WhileNode,
    WithNode, YieldFromNode, YieldNode } from '../parser/parseNodes';
import { AnalyzerFileInfo } from './analyzerFileInfo';
import * as AnalyzerNodeInfo from './analyzerNodeInfo';
import { Declaration, DeclarationType } from './declaration';
import * as ParseTreeUtils from './parseTreeUtils';
import { ParseTreeWalker } from './parseTreeWalker';
import { ScopeType } from './scope';
import { Symbol } from './symbol';
import * as SymbolNameUtils from './symbolNameUtils';
import { getLastTypedDeclaredForSymbol } from './symbolUtils';
import { EvaluatorFlags, TypeEvaluator } from './typeEvaluator';
import { ClassType, combineTypes, FunctionType, isAnyOrUnknown, isNoneOrNever, isTypeSame,
    NoneType, ObjectType, Type, TypeCategory, UnknownType } from './types';
import { containsUnknown, derivesFromClassRecursive, doForSubtypes,
    getDeclaredGeneratorReturnType, getDeclaredGeneratorYieldType, getSymbolFromBaseClasses,
    isNoReturnType, isProperty, specializeType, transformTypeObjectToClass } from './typeUtils';

export class Checker extends ParseTreeWalker {
    private readonly _moduleNode: ModuleNode;
    private readonly _fileInfo: AnalyzerFileInfo;
    private readonly _evaluator: TypeEvaluator;

    // A list of all nodes that are defined within the module that
    // have their own scopes.
    private _scopedNodes: AnalyzerNodeInfo.ScopedNode[] = [];

    constructor(node: ModuleNode, evaluator: TypeEvaluator) {

        super();

        this._moduleNode = node;
        this._fileInfo = AnalyzerNodeInfo.getFileInfo(node)!;
        this._evaluator = evaluator;
    }

    check() {
        this._scopedNodes.push(this._moduleNode);

        this.walkMultiple(this._moduleNode.statements);

        // Perform a one-time validation of symbols in all scopes
        // defined in this module for things like unaccessed variables.
        this._validateSymbolTables();
    }

    walk(node: ParseNode) {
        if (!AnalyzerNodeInfo.isCodeUnreachable(node)) {
            super.walk(node);
        }
    }

    visitClass(node: ClassNode): boolean {
        const classTypeResult = this._evaluator.getTypeOfClass(node);

        this.walk(node.suite);
        this.walkMultiple(node.decorators);
        this.walkMultiple(node.arguments);

        if (classTypeResult) {
            this._validateClassMethods(classTypeResult.classType);
            if (ClassType.isTypedDictClass(classTypeResult.classType)) {
                this._validateTypedDictClassSuite(node.suite);
            }
        }

        this._scopedNodes.push(node);

        return false;
    }

    visitFunction(node: FunctionNode): boolean {
        const functionTypeResult = this._evaluator.getTypeOfFunction(node);
        const containingClassNode = ParseTreeUtils.getEnclosingClass(node, true);

        if (functionTypeResult) {
            // Report any unknown parameter types.
            node.parameters.forEach((param, index) => {
                if (param.name) {
                    const paramType = functionTypeResult.functionType.details.parameters[index].type;
                    if (paramType.category === TypeCategory.Unknown) {
                        this._evaluator.addDiagnostic(
                            this._fileInfo.diagnosticSettings.reportUnknownParameterType,
                            DiagnosticRule.reportUnknownParameterType,
                            `Type of '${ param.name.value }' is unknown`,
                            param.name);
                    }
                }
            });

            if (containingClassNode) {
                this._validateMethod(node, functionTypeResult.functionType);
            }
        }

        node.parameters.forEach(param => {
            if (param.defaultValue) {
                this.walk(param.defaultValue);
            }

            if (param.typeAnnotation) {
                this.walk(param.typeAnnotation);
            }
        });

        if (node.returnTypeAnnotation) {
            this.walk(node.returnTypeAnnotation);
        }

        this.walkMultiple(node.decorators);

        node.parameters.forEach(param => {
            if (param.name) {
                this.walk(param.name);
            }
        });

        this.walk(node.suite);

        if (functionTypeResult) {
            // Validate that the function returns the declared type.
            this._validateFunctionReturn(node, functionTypeResult.functionType);
        }

        this._scopedNodes.push(node);

        return false;
    }

    visitLambda(node: LambdaNode): boolean {
        this._evaluator.getType(node);

        // Walk the children.
        this.walkMultiple([...node.parameters, node.expression]);

        node.parameters.forEach(param => {
            if (param.name) {
                const paramType = this._evaluator.getType(param.name);
                if (paramType) {
                    if (paramType.category === TypeCategory.Unknown) {
                        this._evaluator.addDiagnostic(
                            this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                            DiagnosticRule.reportUnknownLambdaType,
                            `Type of '${ param.name.value }' is unknown`,
                            param.name);
                    } else if (containsUnknown(paramType)) {
                        this._evaluator.addDiagnostic(
                            this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                            DiagnosticRule.reportUnknownLambdaType,
                            `Type of '${ param.name.value }', ` +
                            `'${ this._evaluator.printType(paramType) }', is partially unknown`,
                            param.name);
                    }
                }
            }
        });

        const returnType = this._evaluator.getType(node.expression);
        if (returnType) {
            if (returnType.category === TypeCategory.Unknown) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                    DiagnosticRule.reportUnknownLambdaType,
                    `Type of lambda expression is unknown`, node.expression);
            } else if (containsUnknown(returnType)) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportUnknownLambdaType,
                    DiagnosticRule.reportUnknownLambdaType,
                    `Type of lambda expression, '${ this._evaluator.printType(returnType) }', is partially unknown`,
                    node.expression);
            }
        }

        this._scopedNodes.push(node);

        return false;
    }

    visitCall(node: CallNode): boolean {
        this._evaluator.getType(node);

        this._validateIsInstanceCallNecessary(node);

        if (ParseTreeUtils.isWithinDefaultParamInitializer(node) && !this._fileInfo.isStubFile) {
            this._evaluator.addDiagnostic(
                this._fileInfo.diagnosticSettings.reportCallInDefaultInitializer,
                DiagnosticRule.reportCallInDefaultInitializer,
                `Function calls within default value initializer are not permitted`,
                node);
        }

        return true;
    }

    visitFor(node: ForNode): boolean {
        this._evaluator.evaluateTypesForStatement(node);
        return true;
    }

    visitListComprehension(node: ListComprehensionNode): boolean {
        this._scopedNodes.push(node);
        return true;
    }

    visitIf(node: IfNode): boolean {
        this._evaluator.getType(node.testExpression);
        return true;
    }

    visitWhile(node: WhileNode): boolean {
        this._evaluator.getType(node.testExpression);
        return true;
    }

    visitWith(node: WithNode): boolean {
        node.withItems.forEach(item => {
            this._evaluator.evaluateTypesForStatement(item);
        });

        return true;
    }

    visitReturn(node: ReturnNode): boolean {
        let returnType: Type;

        const enclosingFunctionNode = ParseTreeUtils.getEnclosingFunction(node);
        const declaredReturnType = enclosingFunctionNode ?
            this._evaluator.getFunctionDeclaredReturnType(enclosingFunctionNode) :
            undefined;

        if (node.returnExpression) {
            returnType = this._evaluator.getType(node.returnExpression) || UnknownType.create();
        } else {
            // There is no return expression, so "None" is assumed.
            returnType = NoneType.create();
        }

        if (this._evaluator.isNodeReachable(node) && enclosingFunctionNode) {
            if (declaredReturnType) {
                if (isNoReturnType(declaredReturnType)) {
                    this._evaluator.addError(
                        `Function with declared return type 'NoReturn' cannot include a return statement`,
                        node);
                } else {
                    const diagAddendum = new DiagnosticAddendum();

                    // Specialize the return type in case it contains references to type variables.
                    // These will be replaced with the corresponding constraint or bound types.
                    const specializedDeclaredType = specializeType(declaredReturnType, undefined);
                    if (!this._evaluator.canAssignType(specializedDeclaredType, returnType, diagAddendum)) {
                        this._evaluator.addError(
                            `Expression of type '${ this._evaluator.printType(returnType) }' cannot be assigned ` +
                                `to return type '${ this._evaluator.printType(specializedDeclaredType) }'` +
                                diagAddendum.getString(),
                            node.returnExpression ? node.returnExpression : node);
                    }
                }
            }
        }

        return true;
    }

    visitYield(node: YieldNode) {
        const yieldType = node.expression ?
            this._evaluator.getType(node.expression) : NoneType.create();

        // Wrap the yield type in an Iterator.
        let adjYieldType = yieldType;
        const iteratorType = this._evaluator.getBuiltInType(node, 'Iterator');
        if (yieldType && iteratorType.category === TypeCategory.Class) {
            adjYieldType = ObjectType.create(ClassType.cloneForSpecialization(iteratorType, [yieldType]));
        } else {
            adjYieldType = UnknownType.create();
        }

        this._validateYieldType(node, adjYieldType);

        return true;
    }

    visitYieldFrom(node: YieldFromNode) {
        const yieldType = this._evaluator.getType(node.expression);
        if (yieldType) {
            this._validateYieldType(node, yieldType);
        }

        return true;
    }

    visitRaise(node: RaiseNode): boolean {
        const baseExceptionType = this._evaluator.getBuiltInType(node, 'BaseException') as ClassType;

        if (node.typeExpression) {
            const exceptionType = this._evaluator.getType(node.typeExpression);

            // Validate that the argument of "raise" is an exception object or class.
            if (exceptionType && baseExceptionType && baseExceptionType.category === TypeCategory.Class) {
                const diagAddendum = new DiagnosticAddendum();

                doForSubtypes(exceptionType, subtype => {
                    if (!isAnyOrUnknown(subtype)) {
                        if (subtype.category === TypeCategory.Class) {
                            if (!derivesFromClassRecursive(subtype, baseExceptionType)) {
                                diagAddendum.addMessage(`'${ this._evaluator.printType(subtype) }' does not derive from BaseException`);
                            }
                        } else if (subtype.category === TypeCategory.Object) {
                            if (!derivesFromClassRecursive(subtype.classType, baseExceptionType)) {
                                diagAddendum.addMessage(`'${ this._evaluator.printType(subtype) }' does not derive from BaseException`);
                            }
                        } else {
                            diagAddendum.addMessage(`'${ this._evaluator.printType(subtype) }' does not derive from BaseException`);
                        }
                    }

                    return subtype;
                });

                if (diagAddendum.getMessageCount() > 0) {
                    this._evaluator.addError(
                        `Expected exception class or object` + diagAddendum.getString(),
                        node.typeExpression);
                }
            }
        }

        if (node.valueExpression) {
            const exceptionType = this._evaluator.getType(node.valueExpression);

            // Validate that the argument of "raise" is an exception object or None.
            if (exceptionType && baseExceptionType && baseExceptionType.category === TypeCategory.Class) {
                const diagAddendum = new DiagnosticAddendum();

                doForSubtypes(exceptionType, subtype => {
                    if (!isAnyOrUnknown(subtype) && !isNoneOrNever(subtype)) {
                        if (subtype.category === TypeCategory.Object) {
                            if (!derivesFromClassRecursive(subtype.classType, baseExceptionType)) {
                                diagAddendum.addMessage(`'${ this._evaluator.printType(subtype) }' does not derive from BaseException`);
                            }
                        } else {
                            diagAddendum.addMessage(`'${ this._evaluator.printType(subtype) }' does not derive from BaseException`);
                        }
                    }

                    return subtype;
                });

                if (diagAddendum.getMessageCount() > 0) {
                    this._evaluator.addError(
                        `Expected exception object or None` + diagAddendum.getString(),
                        node.valueExpression);
                }
            }
        }

        return true;
    }

    visitExcept(node: ExceptNode): boolean {
        if (node.typeExpression) {
            this._evaluator.evaluateTypesForStatement(node);

            const exceptionType = this._evaluator.getType(node.typeExpression);
            if (exceptionType) {
                this._validateExceptionType(exceptionType, node.typeExpression);
            }
        }

        return true;
    }

    visitAssert(node: AssertNode) {
        if (node.exceptionExpression) {
            this._evaluator.getType(node.exceptionExpression);
        }

        const type = this._evaluator.getType(node.testExpression);
        if (type && type.category === TypeCategory.Object) {
            if (ClassType.isBuiltIn(type.classType, 'Tuple') && type.classType.typeArguments) {
                if (type.classType.typeArguments.length > 0) {
                    this._evaluator.addDiagnosticForTextRange(this._fileInfo,
                        this._fileInfo.diagnosticSettings.reportAssertAlwaysTrue,
                        DiagnosticRule.reportAssertAlwaysTrue,
                        `Assert expression always evaluates to true`, node.testExpression);
                }
            }
        }

        return true;
    }

    visitAssignment(node: AssignmentNode): boolean {
        this._evaluator.evaluateTypesForStatement(node);
        if (node.typeAnnotationComment) {
            this._evaluator.getType(node.typeAnnotationComment);
        }

        return true;
    }

    visitAssignmentExpression(node: AssignmentExpressionNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitAugmentedAssignment(node: AugmentedAssignmentNode): boolean {
        this._evaluator.evaluateTypesForStatement(node);
        return true;
    }

    visitIndex(node: IndexNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitBinaryOperation(node: BinaryOperationNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitSlice(node: SliceNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitUnpack(node: UnpackNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitTuple(node: TupleNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitUnaryOperation(node: UnaryOperationNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitTernary(node: TernaryNode): boolean {
        this._evaluator.getType(node);
        return true;
    }

    visitStringList(node: StringListNode): boolean {
        if (node.typeAnnotation) {
            this._evaluator.getType(node);
        }

        return true;
    }

    visitFormatString(node: FormatStringNode): boolean {
        node.expressions.forEach(formatExpr => {
            this._evaluator.getType(formatExpr);
        });

        return true;
    }

    visitName(node: NameNode) {
        // Determine if we should log information about private usage.
        this._conditionallyReportPrivateUsage(node);
        return true;
    }

    visitDel(node: DelNode) {
        node.expressions.forEach(expr => {
            this._evaluator.verifyDeleteExpression(expr);
        });

        return true;
    }

    visitMemberAccess(node: MemberAccessNode) {
        this._evaluator.getType(node);
        this._conditionallyReportPrivateUsage(node.memberName);

        // Walk the leftExpression but not the memberName.
        this.walk(node.leftExpression);

        return false;
    }

    visitImportAs(node: ImportAsNode): boolean {
        this._evaluator.evaluateTypesForStatement(node);
        return false;
    }

    visitImportFrom(node: ImportFromNode): boolean {
        if (!node.isWildcardImport) {
            node.imports.forEach(importAs => {
                this._evaluator.evaluateTypesForStatement(importAs);
            });
        }

        return false;
    }

    visitTypeAnnotation(node: TypeAnnotationNode): boolean {
        this._evaluator.getType(node.typeAnnotation);
        return true;
    }

    visitError(node: ErrorNode) {
        // Get the type of the child so it's available to
        // the completion provider.
        if (node.child) {
            this._evaluator.getType(node.child);
        }

        // Don't explore further.
        return false;
    }

    private _validateExceptionType(exceptionType: Type, errorNode: ParseNode) {
        const baseExceptionType = this._evaluator.getBuiltInType(errorNode, 'BaseException');
        const derivesFromBaseException = (classType: ClassType) => {
            if (!baseExceptionType || !(baseExceptionType.category === TypeCategory.Class)) {
                return true;
            }

            return derivesFromClassRecursive(classType, baseExceptionType);
        };

        const diagAddendum = new DiagnosticAddendum();
        let resultingExceptionType: Type | undefined;

        if (isAnyOrUnknown(exceptionType)) {
            resultingExceptionType = exceptionType;
        } else if (exceptionType.category === TypeCategory.Class) {
            if (!derivesFromBaseException(exceptionType)) {
                diagAddendum.addMessage(
                    `'${this._evaluator.printType(exceptionType)}' does not derive from BaseException`);
            }
            resultingExceptionType = ObjectType.create(exceptionType);
        } else if (exceptionType.category === TypeCategory.Object) {
            const iterableType = this._evaluator.getTypeFromIterable(
                exceptionType, false, errorNode, false);

            resultingExceptionType = doForSubtypes(iterableType, subtype => {
                if (isAnyOrUnknown(subtype)) {
                    return subtype;
                }

                const transformedSubtype = transformTypeObjectToClass(subtype);
                if (transformedSubtype.category === TypeCategory.Class) {
                    if (!derivesFromBaseException(transformedSubtype)) {
                        diagAddendum.addMessage(
                            `'${this._evaluator.printType(exceptionType)}' does not derive from BaseException`);
                    }

                    return ObjectType.create(transformedSubtype);
                }

                diagAddendum.addMessage(
                    `'${this._evaluator.printType(exceptionType)}' does not derive from BaseException`);
                return UnknownType.create();
            });
        }

        if (diagAddendum.getMessageCount() > 0) {
            this._evaluator.addError(
                `'${this._evaluator.printType(exceptionType)}' is not valid exception class` +
                diagAddendum.getString(),
                errorNode);
        }

        return resultingExceptionType || UnknownType.create();
    }

    private _validateSymbolTables() {
        // Never report symbol table issues in stub files.
        if (this._fileInfo.isStubFile) {
            return;
        }

        for (const scopedNode of this._scopedNodes) {
            const scope = AnalyzerNodeInfo.getScope(scopedNode)!;

            scope.symbolTable.forEach((symbol, name) => {
                this._conditionallyReportUnusedSymbol(name, symbol, scope.type);

                this._reportIncompatibleDeclarations(name, symbol);
            });
        }
    }

    private _reportIncompatibleDeclarations(name: string, symbol: Symbol) {
        // If there's one or more declaration with a declared type,
        // all other declarations should match. The only exception is
        // for functions that have an overload.
        const primaryDecl = getLastTypedDeclaredForSymbol(symbol);

        // If there's no declaration with a declared type, we're done.
        if (!primaryDecl) {
            return;
        }

        let otherDecls = symbol.getDeclarations().filter(decl => decl !== primaryDecl);

        // If it's a function, we can skip any other declarations
        // that are overloads.
        if (primaryDecl.type === DeclarationType.Function) {
            otherDecls = otherDecls.filter(decl => decl.type !== DeclarationType.Function);
        }

        // If there are no other declarations to consider, we're done.
        if (otherDecls.length === 0) {
            return;
        }

        let primaryDeclType = '';
        if (primaryDecl.type === DeclarationType.Function) {
            primaryDeclType = primaryDecl.isMethod ? 'method ' : 'function ';
        } else if (primaryDecl.type === DeclarationType.Class) {
            primaryDeclType = 'class ';
        } else if (primaryDecl.type === DeclarationType.Parameter) {
            primaryDeclType = 'parameter ';
        } else if (primaryDecl.type === DeclarationType.Variable) {
            primaryDeclType = 'variable ';
        }

        const addPrimaryDeclInfo = (diag?: Diagnostic) => {
            if (diag) {
                let primaryDeclNode: ParseNode | undefined;
                if (primaryDecl.type === DeclarationType.Function ||
                        primaryDecl.type === DeclarationType.Class) {

                    primaryDeclNode = primaryDecl.node.name;
                } else if (primaryDecl.type === DeclarationType.Variable) {
                    if (primaryDecl.node.nodeType === ParseNodeType.Name) {
                        primaryDeclNode = primaryDecl.node;
                    }
                } else if (primaryDecl.type === DeclarationType.Parameter) {
                    if (primaryDecl.node.name) {
                        primaryDeclNode = primaryDecl.node.name;
                    }
                }

                if (primaryDeclNode) {
                    diag.addRelatedInfo(`See ${ primaryDeclType }declaration`,
                        primaryDecl.path, primaryDecl.range);
                }
            }
        };

        for (const otherDecl of otherDecls) {
            if (otherDecl.type === DeclarationType.Class) {
                const diag = this._evaluator.addError(
                    `Class declaration '${ name }' is obscured by a ${ primaryDeclType }` +
                        `declaration of the same name`,
                    otherDecl.node.name
                );
                addPrimaryDeclInfo(diag);
            } else if (otherDecl.type === DeclarationType.Function) {
                const diag = this._evaluator.addError(
                    `Function declaration '${ name }' is obscured by a ${ primaryDeclType }` +
                        `declaration of the same name`,
                    otherDecl.node.name
                );
                addPrimaryDeclInfo(diag);
            } else if (otherDecl.type === DeclarationType.Parameter) {
                if (otherDecl.node.name) {
                    const diag = this._evaluator.addError(
                        `Parameter '${ name }' is obscured by a ${ primaryDeclType }` +
                            `declaration of the same name`,
                        otherDecl.node.name
                    );
                    addPrimaryDeclInfo(diag);
                }
            } else if (otherDecl.type === DeclarationType.Variable) {
                const primaryType = this._evaluator.getTypeForDeclaration(primaryDecl);

                if (otherDecl.typeAnnotationNode) {
                    if (otherDecl.node.nodeType === ParseNodeType.Name) {
                        let duplicateIsOk = false;

                        // If both declarations are variables, it's OK if they
                        // both have the same declared type.
                        if (primaryDecl.type === DeclarationType.Variable) {
                            const otherType = this._evaluator.getTypeForDeclaration(otherDecl);
                            if (primaryType && otherType && isTypeSame(primaryType, otherType)) {
                                duplicateIsOk = true;
                            }
                        }

                        if (!duplicateIsOk) {
                            const diag = this._evaluator.addError(
                                `Declared type for '${ name }' is obscured by an ` +
                                    `incompatible ${ primaryDeclType }declaration`,
                                otherDecl.node
                            );
                            addPrimaryDeclInfo(diag);
                        }
                    }
                } else if (primaryType && !isProperty(primaryType)) {
                    if (primaryDecl.type === DeclarationType.Function || primaryDecl.type === DeclarationType.Class) {
                        const diag = this._evaluator.addError(
                            `Declared ${ primaryDeclType } already exists for '${ name }'`,
                            otherDecl.node
                        );
                        addPrimaryDeclInfo(diag);
                    }
                }
            }
        }
    }

    private _conditionallyReportUnusedSymbol(name: string, symbol: Symbol, scopeType: ScopeType) {
        const accessedSymbolMap = this._fileInfo.accessedSymbolMap;
        if (symbol.isIgnoredForProtocolMatch() || accessedSymbolMap.has(symbol.id)) {
            return;
        }

        // A name starting with "_" means "I know this symbol isn't used", so
        // don't report it as unused.
        if (name.startsWith('_')) {
            return;
        }

        if (SymbolNameUtils.isDunderName(name)) {
            return;
        }

        const decls = symbol.getDeclarations();
        decls.forEach(decl => {
            this._conditionallyReportUnusedDeclaration(decl,
                this._isSymbolPrivate(name, scopeType));
        });
    }

    private _conditionallyReportUnusedDeclaration(decl: Declaration, isPrivate: boolean) {
        let diagnosticLevel: DiagnosticLevel;
        let nameNode: NameNode | undefined;
        let message: string | undefined;
        let rule: DiagnosticRule | undefined;

        switch (decl.type) {
            case DeclarationType.Alias:
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedImport;
                rule = DiagnosticRule.reportUnusedImport;
                if (decl.node.nodeType === ParseNodeType.ImportAs) {
                    if (decl.node.alias) {
                        nameNode = decl.node.alias;
                    } else {
                        // Handle multi-part names specially.
                        const nameParts = decl.node.module.nameParts;
                        if (nameParts.length > 0) {
                            const multipartName = nameParts.map(np => np.value).join('.');
                            const textRange: TextRange = { start: nameParts[0].start, length: nameParts[0].length };
                            TextRange.extend(textRange, nameParts[nameParts.length - 1]);
                            this._fileInfo.diagnosticSink.addUnusedCodeWithTextRange(
                                `'${ multipartName }' is not accessed`, textRange);

                            this._evaluator.addDiagnosticForTextRange(this._fileInfo,
                                this._fileInfo.diagnosticSettings.reportUnusedImport,
                                DiagnosticRule.reportUnusedImport,
                                `Import '${ multipartName }' is not accessed`, textRange);
                            return;
                        }
                    }
                } else if (decl.node.nodeType === ParseNodeType.ImportFromAs) {
                    // Python files generated by protoc ("_pb2.py" files) contain
                    // unused imports. Don't report these because they're in generated
                    // files that shouldn't be edited.
                    const importFrom = decl.node.parent as ImportFromNode;
                    if (importFrom.module.nameParts.length === 0 ||
                            importFrom.module.nameParts[0].value !== '__future__' &&
                            !this._fileInfo.filePath.endsWith('_pb2.py')) {

                        nameNode = decl.node.alias || decl.node.name;
                    }
                }

                if (nameNode) {
                    message = `Import '${ nameNode.value }' is not accessed`;
                }
                break;

            case DeclarationType.Variable:
            case DeclarationType.Parameter:
                if (!isPrivate) {
                    return;
                }
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedVariable;
                if (decl.node.nodeType === ParseNodeType.Name) {
                    nameNode = decl.node;
                    rule = DiagnosticRule.reportUnusedVariable;
                    message = `Variable '${ nameNode.value }' is not accessed`;
                }
                break;

            case DeclarationType.Class:
                if (!isPrivate) {
                    return;
                }
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedClass;
                nameNode = decl.node.name;
                rule = DiagnosticRule.reportUnusedClass;
                message = `Class '${ nameNode.value }' is not accessed`;
                break;

            case DeclarationType.Function:
                if (!isPrivate) {
                    return;
                }
                diagnosticLevel = this._fileInfo.diagnosticSettings.reportUnusedFunction;
                nameNode = decl.node.name;
                rule = DiagnosticRule.reportUnusedFunction;
                message = `Function '${ nameNode.value }' is not accessed`;
                break;

            default:
                return;
        }

        if (nameNode && rule !== undefined && message) {
            this._fileInfo.diagnosticSink.addUnusedCodeWithTextRange(
                `'${ nameNode.value }' is not accessed`, nameNode);
            this._evaluator.addDiagnostic(
                diagnosticLevel, rule, message, nameNode);
        }
    }

    // Validates that a call to isinstance or issubclass are necessary. This is a
    // common source of programming errors.
    private _validateIsInstanceCallNecessary(node: CallNode) {
        if (this._fileInfo.diagnosticSettings.reportUnnecessaryIsInstance === 'none') {
            return;
        }

        // If this call is within an assert statement, we'll ignore it.
        let curNode: ParseNode | undefined = node;
        while (curNode) {
            if (curNode.nodeType === ParseNodeType.Assert) {
                return;
            }
            curNode = curNode.parent;
        }

        if (node.leftExpression.nodeType !== ParseNodeType.Name ||
                (node.leftExpression.value !== 'isinstance' &&
                    node.leftExpression.value !== 'issubclass') ||
                node.arguments.length !== 2) {
            return;
        }

        const callName = node.leftExpression.value;
        const isInstanceCheck = callName === 'isinstance';
        let arg0Type = this._evaluator.getType(node.arguments[0].valueExpression);
        if (!arg0Type) {
            return;
        }
        arg0Type = doForSubtypes(arg0Type, subtype => {
            return transformTypeObjectToClass(subtype);
        });

        if (isAnyOrUnknown(arg0Type)) {
            return;
        }

        const arg1Type = this._evaluator.getType(node.arguments[1].valueExpression);
        if (!arg1Type) {
            return;
        }

        const classTypeList: ClassType[] = [];
        if (arg1Type.category === TypeCategory.Class) {
            classTypeList.push(arg1Type);
        } else if (arg1Type.category === TypeCategory.Object) {
            // The isinstance and issubclass call supports a variation where the second
            // parameter is a tuple of classes.
            const objClass = arg1Type.classType;
            if (ClassType.isBuiltIn(objClass, 'Tuple') && objClass.typeArguments) {
                objClass.typeArguments.forEach(typeArg => {
                    if (typeArg.category === TypeCategory.Class) {
                        classTypeList.push(typeArg);
                    } else {
                        return;
                    }
                });
            }
        } else {
            return;
        }

        const finalizeFilteredTypeList = (types: Type[]): Type => {
            return combineTypes(types);
        };

        const filterType = (varType: ClassType): (ObjectType[] | ClassType[]) => {
            const filteredTypes: ClassType[] = [];

            for (const filterType of classTypeList) {
                const filterIsSuperclass = ClassType.isDerivedFrom(varType, filterType);
                const filterIsSubclass = ClassType.isDerivedFrom(filterType, varType);

                if (filterIsSuperclass) {
                    // If the variable type is a subclass of the isinstance
                    // filter, we haven't learned anything new about the
                    // variable type.
                    filteredTypes.push(varType);
                } else if (filterIsSubclass) {
                    // If the variable type is a superclass of the isinstance
                    // filter, we can narrow the type to the subclass.
                    filteredTypes.push(filterType);
                }
            }

            if (!isInstanceCheck) {
                return filteredTypes;
            }

            return filteredTypes.map(t => ObjectType.create(t));
        };

        let filteredType: Type;
        if (isInstanceCheck && arg0Type.category === TypeCategory.Object) {
            const remainingTypes = filterType(arg0Type.classType);
            filteredType = finalizeFilteredTypeList(remainingTypes);
        } else if (!isInstanceCheck && arg0Type.category === TypeCategory.Class) {
            const remainingTypes = filterType(arg0Type);
            filteredType = finalizeFilteredTypeList(remainingTypes);
        } else if (arg0Type.category === TypeCategory.Union) {
            let remainingTypes: Type[] = [];
            let foundAnyType = false;

            arg0Type.subtypes.forEach(t => {
                if (isAnyOrUnknown(t)) {
                    foundAnyType = true;
                }

                if (isInstanceCheck && t.category === TypeCategory.Object) {
                    remainingTypes = remainingTypes.concat(filterType(t.classType));
                } else if (!isInstanceCheck && t.category === TypeCategory.Class) {
                    remainingTypes = remainingTypes.concat(filterType(t));
                }
            });

            filteredType = finalizeFilteredTypeList(remainingTypes);

            // If we found an any or unknown type, all bets are off.
            if (foundAnyType) {
                return;
            }
        } else {
            return;
        }

        const getTestType = () => {
            const objTypeList = classTypeList.map(t => ObjectType.create(t));
            return combineTypes(objTypeList);
        };

        const callType = isInstanceCheck ? 'instance' : 'subclass';
        if (filteredType.category === TypeCategory.Never) {
            this._evaluator.addDiagnostic(
                this._fileInfo.diagnosticSettings.reportUnnecessaryIsInstance,
                DiagnosticRule.reportUnnecessaryIsInstance,
                `Unnecessary ${ callName } call: '${ this._evaluator.printType(arg0Type) }' ` +
                    `is never ${ callType } of '${ this._evaluator.printType(getTestType()) }'`,
                node);
        } else if (isTypeSame(filteredType, arg0Type)) {
            this._evaluator.addDiagnostic(
                this._fileInfo.diagnosticSettings.reportUnnecessaryIsInstance,
                DiagnosticRule.reportUnnecessaryIsInstance,
                `Unnecessary ${ callName } call: '${ this._evaluator.printType(arg0Type) }' ` +
                    `is always ${ callType } of '${ this._evaluator.printType(getTestType()) }'`,
                node);
        }
    }

    private _isSymbolPrivate(nameValue: string, scopeType: ScopeType) {
        // All variables within the scope of a function or a list
        // comprehension are considered private.
        if (scopeType === ScopeType.Function || scopeType === ScopeType.ListComprehension) {
            return true;
        }

        // See if the symbol is private.
        if (SymbolNameUtils.isPrivateName(nameValue)) {
            return true;
        }

        if (SymbolNameUtils.isProtectedName(nameValue)) {
            // Protected names outside of a class scope are considered private.
            const isClassScope = scopeType === ScopeType.Class;
            return !isClassScope;
        }

        return false;
    }

    private _conditionallyReportPrivateUsage(node: NameNode) {
        if (this._fileInfo.diagnosticSettings.reportPrivateUsage === 'none') {
            return;
        }

        // Ignore privates in type stubs.
        if (this._fileInfo.isStubFile) {
            return;
        }

        const nameValue = node.value;
        const isPrivateName = SymbolNameUtils.isPrivateName(nameValue);
        const isProtectedName = SymbolNameUtils.isProtectedName(nameValue);

        // If it's not a protected or private name, don't bother with
        // any further checks.
        if (!isPrivateName && !isProtectedName) {
            return;
        }

        const declarations = this._evaluator.getDeclarationsForNameNode(node);

        let primaryDeclaration = declarations && declarations.length > 0 ?
            declarations[declarations.length - 1] : undefined;
        if (!primaryDeclaration || primaryDeclaration.node === node) {
            return;
        }

        primaryDeclaration = this._evaluator.resolveAliasDeclaration(primaryDeclaration);
        if (!primaryDeclaration || primaryDeclaration.node === node) {
            return;
        }

        let classOrModuleNode: ClassNode | ModuleNode | undefined;
        if (primaryDeclaration.node) {
            classOrModuleNode = ParseTreeUtils.getEnclosingClassOrModule(
            primaryDeclaration.node);
        }

        // If this is the name of a class, find the module or class that contains it rather
        // than constraining the use of the class name within the class itself.
        if (primaryDeclaration.node &&
                primaryDeclaration.node.parent &&
                primaryDeclaration.node.parent === classOrModuleNode &&
                classOrModuleNode.nodeType === ParseNodeType.Class) {

            classOrModuleNode = ParseTreeUtils.getEnclosingClassOrModule(classOrModuleNode);
        }

        // If it's a class member, check whether it's a legal protected access.
        let isProtectedAccess = false;
        if (classOrModuleNode && classOrModuleNode.nodeType === ParseNodeType.Class) {
            if (isProtectedName) {
                const declClassTypeInfo = this._evaluator.getTypeOfClass(classOrModuleNode);
                if (declClassTypeInfo && declClassTypeInfo.decoratedType.category === TypeCategory.Class) {
                    // Note that the access is to a protected class member.
                    isProtectedAccess = true;

                    const enclosingClassNode = ParseTreeUtils.getEnclosingClass(node);
                    if (enclosingClassNode) {
                        isProtectedAccess = true;
                        const enclosingClassTypeInfo = this._evaluator.getTypeOfClass(enclosingClassNode);

                        // If the referencing class is a subclass of the declaring class, it's
                        // allowed to access a protected name.
                        if (enclosingClassTypeInfo &&
                                enclosingClassTypeInfo.decoratedType.category === TypeCategory.Class) {

                            if (derivesFromClassRecursive(enclosingClassTypeInfo.decoratedType,
                                    declClassTypeInfo.decoratedType)) {

                                return;
                            }
                        }
                    }
                }
            }
        }

        if (classOrModuleNode && !ParseTreeUtils.isNodeContainedWithin(node, classOrModuleNode)) {
            if (isProtectedAccess) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportPrivateUsage,
                    DiagnosticRule.reportPrivateUsage,
                    `'${ nameValue }' is protected and used outside of a derived class`,
                    node);
            } else {
                const scopeName = classOrModuleNode.nodeType === ParseNodeType.Class ?
                    'class' : 'module';

                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportPrivateUsage,
                    DiagnosticRule.reportPrivateUsage,
                    `'${ nameValue }' is private and used outside of the ${ scopeName } in which it is declared`,
                    node);
            }
        }
    }

    // Verifies the rules specified in PEP 589 about TypedDict classes.
    // They cannot have statements other than type annotations, doc
    // strings, and "pass" statements or ellipses.
    private _validateTypedDictClassSuite(suiteNode: SuiteNode) {
        const emitBadStatementError = (node: ParseNode) => {
            this._evaluator.addError(
                `TypedDict classes can contain only type annotations`,
                node);
        };

        suiteNode.statements.forEach(statement => {
            if (!AnalyzerNodeInfo.isCodeUnreachable(statement)) {
                if (statement.nodeType === ParseNodeType.StatementList) {
                    for (const substatement of statement.statements) {
                        if (substatement.nodeType !== ParseNodeType.TypeAnnotation &&
                                substatement.nodeType !== ParseNodeType.Ellipsis &&
                                substatement.nodeType !== ParseNodeType.StringList &&
                                substatement.nodeType !== ParseNodeType.Pass) {

                            emitBadStatementError(substatement);
                        }
                    }
                } else {
                    emitBadStatementError(statement);
                }
            }
        });
    }

    private _validateFunctionReturn(node: FunctionNode, functionType: FunctionType) {
        // Stub files are allowed not to return an actual value,
        // so skip this if it's a stub file.
        if (this._fileInfo.isStubFile) {
            return;
        }

        if (node.returnTypeAnnotation) {
            const functionNeverReturns = !this._evaluator.isAfterNodeReachable(node);
            const implicitlyReturnsNone = this._evaluator.isAfterNodeReachable(node.suite);

            const declaredReturnType = FunctionType.isGenerator(functionType) ?
                getDeclaredGeneratorReturnType(functionType) :
                functionType.details.declaredReturnType;

            // The types of all return statement expressions were already checked
            // against the declared type, but we need to verify the implicit None
            // at the end of the function.
            if (declaredReturnType && !functionNeverReturns && implicitlyReturnsNone) {
                if (isNoReturnType(declaredReturnType)) {
                    // If the function consists entirely of "...", assume that it's
                    // an abstract method or a protocol method and don't require that
                    // the return type matches.
                    if (!ParseTreeUtils.isSuiteEmpty(node.suite)) {
                        this._evaluator.addError(
                            `Function with declared type of 'NoReturn' cannot return 'None'`,
                            node.returnTypeAnnotation);
                    }
                } else if (!FunctionType.isAbstractMethod(functionType)) {
                    // Make sure that the function doesn't implicitly return None if the declared
                    // type doesn't allow it. Skip this check for abstract methods.
                    const diagAddendum = new DiagnosticAddendum();

                    // If the declared type isn't compatible with 'None', flag an error.
                    if (!this._evaluator.canAssignType(declaredReturnType, NoneType.create(), diagAddendum)) {
                        // If the function consists entirely of "...", assume that it's
                        // an abstract method or a protocol method and don't require that
                        // the return type matches.
                        if (!ParseTreeUtils.isSuiteEmpty(node.suite)) {
                            this._evaluator.addError(
                                `Function with declared type of '${ this._evaluator.printType(declaredReturnType) }'` +
                                    ` must return value` + diagAddendum.getString(),
                                node.returnTypeAnnotation);
                        }
                    }
                }
            }
        } else {
            const inferredReturnType = this._evaluator.getFunctionInferredReturnType(functionType);
            if (inferredReturnType.category === TypeCategory.Unknown) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportUnknownParameterType,
                    DiagnosticRule.reportUnknownParameterType,
                    `Inferred return type is unknown`, node.name);
            } else if (containsUnknown(inferredReturnType)) {
                this._evaluator.addDiagnostic(
                    this._fileInfo.diagnosticSettings.reportUnknownParameterType,
                    DiagnosticRule.reportUnknownParameterType,
                    `Return type '${ this._evaluator.printType(inferredReturnType) }' is partially unknown`,
                    node.name);
            }
        }
    }

    // Validates that any overridden methods contain the same signatures
    // as the original method. Also marks the class as abstract if one or
    // more abstract methods are not overridden.
    private _validateClassMethods(classType: ClassType) {
        // Skip the overridden method check for stub files. Many of the built-in
        // typeshed stub files trigger this diagnostic.
        if (!this._fileInfo.isStubFile) {
            this._validateOveriddenMethods(classType);
        }
    }

    private _validateOveriddenMethods(classType: ClassType) {
        classType.details.fields.forEach((symbol, name) => {
            // Don't check magic functions.
            if (symbol.isClassMember() && !SymbolNameUtils.isDunderName(name)) {
                const typeOfSymbol = this._evaluator.getEffectiveTypeOfSymbol(symbol);
                if (typeOfSymbol.category === TypeCategory.Function) {
                    const baseClassAndSymbol = getSymbolFromBaseClasses(classType, name);
                    if (baseClassAndSymbol) {
                        const typeOfBaseClassMethod = this._evaluator.getEffectiveTypeOfSymbol(
                            baseClassAndSymbol.symbol);
                        const diagAddendum = new DiagnosticAddendum();
                        if (!this._evaluator.canOverrideMethod(typeOfBaseClassMethod, typeOfSymbol,
                                diagAddendum)) {

                            const decl = getLastTypedDeclaredForSymbol(symbol);
                            if (decl && decl.type === DeclarationType.Function) {
                                this._evaluator.addDiagnostic(
                                    this._fileInfo.diagnosticSettings.reportIncompatibleMethodOverride,
                                    DiagnosticRule.reportIncompatibleMethodOverride,
                                    `Method '${ name }' overrides class '${ baseClassAndSymbol.class.details.name }' ` +
                                        `in an incompatible manner` + diagAddendum.getString(), decl.node.name);
                            }
                        }

                        if (typeOfBaseClassMethod.category === TypeCategory.Function) {
                            if (FunctionType.isFinal(typeOfBaseClassMethod)) {
                                const decl = getLastTypedDeclaredForSymbol(symbol);
                                if (decl && decl.type === DeclarationType.Function) {
                                    this._evaluator.addError(
                                        `Method '${ name }' cannot override final method defined ` +
                                        `in class '${ baseClassAndSymbol.class.details.name }'`,
                                        decl.node.name);
                                }
                            }
                        }
                    }
                }
            }
        });
    }

    // Performs checks on a function that is located within a class
    // and has been determined not to be a property accessor.
    private _validateMethod(node: FunctionNode, functionType: FunctionType) {
        if (node.name && node.name.value === '__new__') {
            // __new__ overrides should have a "cls" parameter.
            if (node.parameters.length === 0 || !node.parameters[0].name ||
                    (node.parameters[0].name.value !== 'cls' &&
                    node.parameters[0].name.value !== 'mcs')) {
                this._evaluator.addError(
                    `The __new__ override should take a 'cls' parameter`,
                    node.parameters.length > 0 ? node.parameters[0] : node.name);
            }
        } else if (node.name && node.name.value === '__init_subclass__') {
            // __init_subclass__ overrides should have a "cls" parameter.
            if (node.parameters.length === 0 || !node.parameters[0].name ||
                    node.parameters[0].name.value !== 'cls') {
                this._evaluator.addError(
                    `The __init_subclass__ override should take a 'cls' parameter`,
                    node.parameters.length > 0 ? node.parameters[0] : node.name);
            }
        } else if (FunctionType.isStaticMethod(functionType)) {
            // Static methods should not have "self" or "cls" parameters.
            if (node.parameters.length > 0 && node.parameters[0].name) {
                const paramName = node.parameters[0].name.value;
                if (paramName === 'self' || paramName === 'cls') {
                    this._evaluator.addError(
                        `Static methods should not take a 'self' or 'cls' parameter`,
                        node.parameters[0].name);
                }
            }
        } else if (FunctionType.isClassMethod(functionType)) {
            let paramName = '';
            if (node.parameters.length > 0 && node.parameters[0].name) {
                paramName = node.parameters[0].name.value;
            }
            // Class methods should have a "cls" parameter. We'll exempt parameter
            // names that start with an underscore since those are used in a few
            // cases in the stdlib pyi files.
            if (paramName !== 'cls') {
                if (!this._fileInfo.isStubFile || (!paramName.startsWith('_') && paramName !== 'metacls')) {
                    this._evaluator.addError(
                        `Class methods should take a 'cls' parameter`,
                        node.parameters.length > 0 ? node.parameters[0] : node.name);
                }
            }
        } else {
            // The presence of a decorator can change the behavior, so we need
            // to back off from this check if a decorator is present.
            if (node.decorators.length === 0) {
                let paramName = '';
                let firstParamIsSimple = true;
                if (node.parameters.length > 0) {
                    if (node.parameters[0].name) {
                        paramName = node.parameters[0].name.value;
                    }

                    if (node.parameters[0].category !== ParameterCategory.Simple) {
                        firstParamIsSimple = false;
                    }
                }

                // Instance methods should have a "self" parameter. We'll exempt parameter
                // names that start with an underscore since those are used in a few
                // cases in the stdlib pyi files.
                if (firstParamIsSimple && paramName !== 'self' && !paramName.startsWith('_')) {
                    // Special-case the ABCMeta.register method in abc.pyi.
                    const isRegisterMethod = this._fileInfo.isStubFile &&
                        paramName === 'cls' &&
                        node.name.value === 'register';

                    if (!isRegisterMethod) {
                        this._evaluator.addError(
                            `Instance methods should take a 'self' parameter`,
                            node.parameters.length > 0 ? node.parameters[0] : node.name);
                    }
                }
            }
        }
    }

    private _validateYieldType(node: YieldNode | YieldFromNode, adjustedYieldType: Type) {
        let declaredYieldType: Type | undefined;
        const enclosingFunctionNode = ParseTreeUtils.getEnclosingFunction(node);

        if (enclosingFunctionNode) {
            const functionTypeResult = this._evaluator.getTypeOfFunction(enclosingFunctionNode);
            if (functionTypeResult) {
                assert(functionTypeResult.functionType.category === TypeCategory.Function);
                const iteratorType = this._evaluator.getBuiltInType(node, 'Iterator');
                declaredYieldType = getDeclaredGeneratorYieldType(functionTypeResult.functionType, iteratorType);
            }
        }

        if (this._evaluator.isNodeReachable(node)) {
            if (declaredYieldType) {
                if (isNoReturnType(declaredYieldType)) {
                    this._evaluator.addError(
                        `Function with declared return type 'NoReturn' cannot include a yield statement`,
                        node);
                } else {
                    const diagAddendum = new DiagnosticAddendum();
                    if (!this._evaluator.canAssignType(declaredYieldType, adjustedYieldType, diagAddendum)) {
                        this._evaluator.addError(
                            `Expression of type '${ this._evaluator.printType(adjustedYieldType) }' cannot be assigned ` +
                                `to yield type '${ this._evaluator.printType(declaredYieldType) }'` + diagAddendum.getString(),
                            node.expression || node);
                    }
                }
            }
        }
    }
}
