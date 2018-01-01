import { TypedRule, Replacement, TypedRuleContext, FlattenedAst } from '../types';
import * as ts from 'typescript';
import { isStrictNullChecksEnabled } from '../utils';
import { isVariableDeclaration, hasModifier, isFunctionScopeBoundary, isObjectType } from 'tsutils';
import * as debug from 'debug';
import { injectable } from 'inversify';

const log = debug('wotan:rule:no-useless-assertion');

const FAIL_MESSAGE = `This assertion is unnecesary as it doesn't change the type of the expression.`;

@injectable()
export class Rule extends TypedRule {
    public static supports(sourceFile: ts.SourceFile) {
        return !sourceFile.isDeclarationFile && /\.tsx?$/.test(sourceFile.fileName);
    }

    private strictNullChecks = isStrictNullChecksEnabled(this.program.getCompilerOptions());

    constructor(context: TypedRuleContext, private flatAst: FlattenedAst) {
        super(context);
    }

    public apply(): void {
        for (const node of this.flatAst) {
            switch (node.kind) {
                case ts.SyntaxKind.NonNullExpression:
                    this.checkNonNullAssertion(<ts.NonNullExpression>node);
                    break;
                case ts.SyntaxKind.AsExpression:
                case ts.SyntaxKind.TypeAssertionExpression:
                    this.checkTypeAssertion(<ts.AssertionExpression>node);
            }
        }
    }

    private checkNonNullAssertion(node: ts.NonNullExpression) {
        if (this.strictNullChecks) {
            const type = this.checker.getApparentType(this.checker.getTypeAtLocation(node.expression));
            if (type !== type.getNonNullableType())
                return;
            if (maybeUsedBeforeBeingAssigned(node.expression, this.checker)) {
                log('Identifier %s could be used before being assigned', node.expression.text);
                return;
            }
        }
        this.addFailure(node.end - 1, node.end, FAIL_MESSAGE, Replacement.delete(node.expression.end, node.end));
    }

    private checkTypeAssertion(node: ts.AssertionExpression) {
        const targetType = this.checker.getApparentType(this.checker.getTypeAtLocation(node));
        if (targetType.flags & ts.TypeFlags.Literal || // allow "foo" as "foo" to avoid unnecessary widening
            isObjectType(targetType) && (targetType.objectFlags & ts.ObjectFlags.Tuple || couldBeTupleType(targetType)))
            return;
        const sourceType = this.checker.getApparentType(this.checker.getTypeAtLocation(node.expression));
        if (targetType !== sourceType && this.checker.typeToString(targetType) !== this.checker.typeToString(sourceType))
            return;
        if (node.kind === ts.SyntaxKind.AsExpression) {
            this.addFailure(
                node.type.pos - 'as'.length,
                node.end,
                FAIL_MESSAGE,
                Replacement.delete(node.expression.end, node.end),
            );
        } else {
            const start = node.getStart(this.sourceFile);
            this.addFailure(start, node.expression.pos, FAIL_MESSAGE, Replacement.delete(start, node.expression.getStart(this.sourceFile)));
        }
    }
}

/**
 * Determine if the assertion may be necessary to avoid a compile error for use before being assigned.
 * This function may yield some false negatives, but is needed until https://github.com/Microsoft/TypeScript/issues/20221 is implemented.
 *
 * The rules are as follows:
 * * strictNullChecks are enabled
 * * assertion is on an identifier
 * * identifier is a mutable variable
 * * no destructuring, parameters, catch binding, ambient declarations
 * * variable is not initialized
 * * variable has a type annotation
 * * declared type is equal to the type at the assertion
 * * declaration and assertion are in the same function scope
 */
function maybeUsedBeforeBeingAssigned(node: ts.Expression, checker: ts.TypeChecker): node is ts.Identifier {
    if (node.kind !== ts.SyntaxKind.Identifier)
        return false;
    const symbol = checker.getSymbolAtLocation(node);
    if (symbol === undefined || symbol.declarations === undefined)
        return false;
    const declaration = symbol.declarations[0];
    if (!isVariableDeclaration(declaration) ||
        declaration.parent!.kind !== ts.SyntaxKind.VariableDeclarationList ||
        declaration.initializer !== undefined ||
        declaration.type === undefined ||
        declaration.parent!.parent!.kind === ts.SyntaxKind.VariableStatement &&
            hasModifier(declaration.parent!.parent!.modifiers, ts.SyntaxKind.DeclareKeyword))
        return false;
    if (checker.getTypeAtLocation(node) !== checker.getTypeFromTypeNode(declaration.type))
        return false;
    return findupFunction(node.parent!.parent) === findupFunction(declaration.parent!.parent!.parent);
}

/** Finds the nearest parent that has a function scope. */
function findupFunction(node: ts.Node | undefined) {
    while (node !== undefined && !isFunctionScopeBoundary(node))
        node = node.parent;
    return node;
}

/**
 * Sometimes tuple types don't have ObjectFlags.Tuple set, like when they're being matched against an inferred type.
 * So, in addition, check if there are integer properties 0..n and no other numeric keys
 */
function couldBeTupleType(type: ts.ObjectType): boolean {
    const properties = type.getProperties();
    if (properties.length === 0)
        return false;
    let i = 0;
    for (; i < properties.length; ++i) {
        const name = properties[i].name;
        if (String(i) !== name) {
            if (i === 0)
                // if there are no integer properties, this is not a tuple
                return false;
            break;
        }
    }
    for (; i < properties.length; ++i)
        if (String(+properties[i].name) === properties[i].name)
            return false;
    return true;
}
